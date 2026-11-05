import React, { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { CommonActions, ExtendedTheme, useTheme, useNavigation, useRoute, useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import type { Question } from "@votetorrent/vote-core";
import type { RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../navigation/types";
import { globalStyles } from "../../theme/styles";
import { useBallotDraft } from "./providers/BallotDraftProvider";
import { BallotTemplateForm } from "./components/BallotTemplateForm";
import { CustomButton } from "../../components/CustomButton";
import { InlineError } from "../../components/InlineError";
import { ThemedText } from "../../components/ThemedText";
import { useApp } from "../../providers/AppProvider";
import { loadAuthoritiesWithRetry } from "../../utils/loadAuthoritiesWithRetry";
import { createDeviceSigner } from "../../engines/device-signer";
import { useDeviceSigningErrorHandler } from "../../hooks/useDeviceSigningErrorHandler";
import type { Authority, Ballot, INetworkEngine } from "@votetorrent/vote-core";
import { peerUnavailableMessage } from "../../utils/peerUnavailableMessage";

/**
 * EditBallotScreen — Ballot Template frame (Figma 57:490) in edit/populated mode.
 *
 * Reached from ElectionDetailsScreen's ballot template chevron list card (09-08).
 * Shares BallotTemplateForm with CreateBallotScreen (Decision 3).
 *
 * 09-10 G12: reads electionEngine + ballotId from route.params. When ballotId
 * is present, calls getBallotDetails(ballotId) on mount and seeds the draft so
 * the form pre-populates AND retains the SAME id. On PROPOSE, calls
 * engine.proposeBallot(ballot) with the existing id — the engine upserts by id
 * (from 09-09) so editing replaces the card instead of inserting a duplicate.
 *
 * UAT 62 test 13: "Submit for confirmation" and "Withdraw" live HERE, on the
 * persisted ballot. CreateBallotScreen's draft id has no ProposedBallot row, so the
 * engine refuses a submit from there; every persisted ballot opens this screen.
 * The footer is therefore state-driven: unlocked -> Propose + Submit, locked ->
 * Withdraw, confirmed -> no footer, readOnly preview -> no footer, unknown lock state
 * (pending or failed read) -> disabled form with Retry only (CR-03, 62-REVIEW.md).
 */
/**
 * gap7/IN-05: a cohort-unreachable lock read can take long to fail. After this long without an
 * answer the screen fails closed (Retry); a later success of the LATEST read still restores it.
 */
const BALLOT_STATE_READ_TIMEOUT_MS = 30_000;

type BallotConfirmationView = { locked: boolean; confirmed: boolean; canWithdraw: boolean; ownTaskOpen: boolean };

/** The comparable form of a ballot: what Propose stores and what Submit would send out. */
const comparableBallot = (b: { authorityId?: string; description?: string; districts?: string[]; questions?: unknown[] }) =>
	JSON.stringify({
		authorityId: b.authorityId ?? "",
		description: b.description ?? "",
		districts: b.districts ?? [],
		questions: b.questions ?? [],
	});

const errorClass = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

const EditBallotScreen = () => {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const route = useRoute<RouteProp<RootStackParamList, "EditBallot">>();
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const insets = useSafeAreaInsets();
	const { electionId, electionTitle, electionDate } = route.params ?? {};
	const electionEngine = (route.params as any)?.electionEngine;
	const ballotId = (route.params as any)?.ballotId;
	const readOnly = route.params?.readOnly === true;
	const { getEngine } = useApp();
	const [loadError, setLoadError] = useState("");
	const [errorMessage, setErrorMessage] = useState("");
	const [proposing, setProposing] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [withdrawing, setWithdrawing] = useState(false);
	const [confirmationState, setConfirmationState] = useState<BallotConfirmationView | null>(null);
	// gap7/IN-05: only the latest lock read may write state; Retry shows it is busy.
	const readSeqRef = useRef(0);
	const retryingRef = useRef(false);
	const [retrying, setRetrying] = useState(false);
	// gap6/WR-01: the stored ballot as last loaded, in comparable form, to detect unsaved edits.
	const storedBallotRef = useRef<{ authorityId: string; comparable: (authorityId: string) => string } | null>(null);
	// gap6/WR-02: where confirmation happens after a submit; cleared on the next focus read.
	const [submittedHint, setSubmittedHint] = useState<"own" | "others" | null>(null);
	// CR-03 (62-REVIEW.md): a failed confirmation-state read must FAIL CLOSED. The edit lock
	// is unknown, so the form is disabled and the footer shows Retry only.
	const [stateReadFailed, setStateReadFailed] = useState(false);
	// WR-03 (62-REVIEW.md): synchronous in-flight guard. `submitting` state only updates on
	// the next render, so two presses in one tick would both pass a state check; the ref is
	// the guard (same reasoning as RegistrationRequestApprovalScreen's submittingRef).
	const submittingRef = useRef(false);
	const handleDeviceSigningError = useDeviceSigningErrorHandler();
	const [authorities, setAuthorities] = useState<Authority[]>([]);
	const { ballotDraft, setBallotDraft, addQuestion, updateQuestion, removeQuestion } = useBallotDraft();

	// Seed the draft with electionId from route params (edit mode entry point)
	useEffect(() => {
		if (electionId && ballotDraft.electionId !== electionId) {
			setBallotDraft((prev) => ({ ...prev, electionId }));
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [electionId]);

	// Load the real authorities so the dropdown stores a valid Authority.Id (the
	// ProposedBallot.AuthorityIdValid CHECK requires the id to exist in the
	// Authority table). Includes the primary/network-creator authority.
	const [primaryAuthorityId, setPrimaryAuthorityId] = useState("");
	useEffect(() => {
		async function loadAuthorities() {
			try {
				const engine = await getEngine<INetworkEngine>("network");
				if (!engine) return;
				// ballot-authority-empty fix: retry a zero-row result — see
				// loadAuthoritiesWithRetry for the strand-replication-race rationale.
				const buffer = await loadAuthoritiesWithRetry(engine);
				setAuthorities(buffer);
				const details = await engine.getDetails();
				if (details?.network?.primaryAuthorityId) {
					setPrimaryAuthorityId(details.network.primaryAuthorityId);
				}
			} catch (error) {
				console.warn("Error loading authorities for ballot:", errorClass(error));
			}
		}
		loadAuthorities();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [getEngine]);

	// Default to the primary authority ONLY when the loaded ballot has no authority
	// (the getBallotDetails effect already seeds `authority` from the existing
	// ballot's authorityId, so this never clobbers an existing selection).
	useEffect(() => {
		if (primaryAuthorityId && !(ballotDraft as any).authority) {
			setBallotDraft((prev) => ({ ...prev, authority: primaryAuthorityId }) as any);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [primaryAuthorityId, (ballotDraft as any).authority]);

	// G12 edit/upsert: load existing ballot from engine on mount so the form
	// pre-populates AND the draft retains the SAME id for upsert on PROPOSE. Also used to
	// restore the stored ballot after the engine refused an edit (gap8/WR-01), so the form
	// never shows edits that were not saved.
	const reloadStoredBallot = async () => {
		if (!ballotId || !electionEngine) return;
		try {
			const details = await electionEngine.getBallotDetails(ballotId);
			if (details?.ballot) {
				const stored = details.ballot as any;
				storedBallotRef.current = {
					authorityId: stored.authorityId ?? "",
					comparable: (authorityId: string) => comparableBallot({ ...stored, authorityId }),
				};
				// WR-06: the async load replaces the whole draft, so it must not drop
				// the electionId that the synchronous seed effect set, so fall back
				// explicitly to the loaded ballot's electionId, else the route's
				// electionId param.
				// Map authorityId → authority (the loose key BallotTemplateForm's
				// dropdown reads) so the Authority field re-populates on reopen.
				setBallotDraft({
					...details.ballot,
					electionId: (details.ballot as any).electionId || electionId || "",
					authority: (details.ballot as any).authorityId ?? "",
				} as any);
			}
		} catch (error) {
			console.warn("getBallotDetails error", errorClass(error));
			// Peer-unavailable first (translated); everything else is fixed copy, never engine text.
			setLoadError(peerUnavailableMessage(error, t, "read") ?? t("ballotLoadFailed"));
		}
	};
	useEffect(() => {
		reloadStoredBallot();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ballotId]);

	// One read path for the focus effect, the post-Submit/Withdraw refresh and Retry. Success
	// clears the failure flag; failure sets it (fail closed, CR-03) and logs the error CLASS only.
	// Returns the state it read, or null when the read failed or timed out. Reads are sequenced
	// (gap7/IN-05): a slower, older read never overwrites a newer one.
	const readConfirmationState = useCallback(async (): Promise<BallotConfirmationView | null> => {
		const seq = ++readSeqRef.current;
		const apply = (state: any): BallotConfirmationView => {
			const fresh = {
				locked: !!state.locked,
				confirmed: !!state.confirmed,
				canWithdraw: state.canWithdraw === true,
				ownTaskOpen: state.ownTaskOpen === true,
			};
			if (seq === readSeqRef.current) {
				setConfirmationState(fresh);
				setStateReadFailed(false);
			}
			return fresh;
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const read = Promise.resolve(electionEngine.getBallotConfirmationState(ballotId));
			read.catch(() => {});
			const timeout = new Promise<"timeout">((resolve) => {
				timer = setTimeout(() => resolve("timeout"), BALLOT_STATE_READ_TIMEOUT_MS);
			});
			const outcome = await Promise.race([read, timeout]);
			if (outcome === "timeout") {
				console.warn("getBallotConfirmationState failed", "timeout");
				if (seq === readSeqRef.current) setStateReadFailed(true);
				// A late answer to the LATEST read still restores the screen.
				read.then((late) => {
					apply(late);
				}, () => {});
				return null;
			}
			return apply(outcome);
		} catch (error) {
			console.warn("getBallotConfirmationState failed", errorClass(error));
			if (seq === readSeqRef.current) setStateReadFailed(true);
			return null;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}, [electionEngine, ballotId]);

	const handleRetry = async () => {
		if (retryingRef.current) return;
		retryingRef.current = true;
		setRetrying(true);
		try {
			await readConfirmationState();
		} finally {
			retryingRef.current = false;
			setRetrying(false);
		}
	};

	// D-05: poll confirmation lock state on every focus so an edit screen opened
	// while a confirmation is pending shows the correct locked UI immediately.
	useFocusEffect(
		useCallback(() => {
			if (!electionEngine || !ballotId) return;
			setSubmittedHint(null);
			readConfirmationState();
		}, [electionEngine, ballotId, readConfirmationState])
	);

	const refreshConfirmationState = readConfirmationState;

	// D-05 / CR-03: edit is blocked when the ballot has a pending or confirmed confirmation, and
	// ALSO when that state is unknown (first read pending or the last read failed).
	const locked = confirmationState?.locked === true;
	const confirmed = confirmationState?.confirmed === true;
	const stateUnknown = !!electionEngine && !!ballotId && (confirmationState === null || stateReadFailed);
	const editingDisabled = readOnly || locked || confirmed || stateUnknown;
	// gap6/WR-01: the form differs from the stored ballot. An empty stored authority matches the
	// primary-authority default the seeding effect writes into the draft, so that is not an edit.
	const draftAuthority = (ballotDraft as any).authority ?? (ballotDraft as any).authorityId ?? "";
	const storedBallot = storedBallotRef.current;
	const draftDirty =
		storedBallot !== null &&
		comparableBallot({ ...ballotDraft, authorityId: draftAuthority }) !==
			storedBallot.comparable(storedBallot.authorityId || (primaryAuthorityId && draftAuthority === primaryAuthorityId ? draftAuthority : storedBallot.authorityId));

	// D-03/D-08: Submit the persisted ballot for confirmation.
	// `lazySign` is a LAZY factory thunk: `createDeviceSigner` is only invoked if the engine
	// actually calls this callback, which happens only when the authority's ceb threshold is
	// above 1 (IElectionEngine.submitBallotForConfirmation's own doc comment). A threshold-1
	// authority therefore needs neither a provisioned key nor a biometric prompt to submit; the
	// engine opens a confirmation Task for the submitting officer instead.
	const handleSubmitForConfirmation = async () => {
		if (!electionEngine || !ballotId) return;
		if (stateUnknown || locked || confirmed || draftDirty) return;
		if (submittingRef.current) return;
		submittingRef.current = true;
		setErrorMessage("");
		setSubmitting(true);
		try {
			const lazySign = async (digest: Uint8Array) => (await createDeviceSigner("Device User"))(digest);
			await electionEngine.submitBallotForConfirmation(ballotId, lazySign);
			// Re-read rather than guess. A submitted ballot reads locked until its confirmation
			// Task is accepted (threshold 1 opens that Task for this officer; it does not self-confirm).
			const after = await refreshConfirmationState();
			if (after?.locked) setSubmittedHint(after.ownTaskOpen ? "own" : "others");
		} catch (error) {
			console.warn("submitBallotForConfirmation error", errorClass(error));
			const outcome = handleDeviceSigningError(error);
			if (outcome.handled) return;
			// The engine refuses a ballot that is out for confirmation or confirmed (proposeBallot,
			// and since WR-04 submitBallotForConfirmation); a stale screen re-reads so its footer
			// follows the engine instead of inviting a retry that cannot succeed (WR-04, 62-REVIEW.md).
			const fresh = await readConfirmationState();
			if (fresh && (fresh.locked || fresh.confirmed)) {
				// gap8/WR-01: say what happened, and show the stored ballot again.
				setErrorMessage(t(fresh.confirmed ? "ballotSubmitRefusedConfirmed" : "ballotSubmitRefusedLocked"));
				await reloadStoredBallot();
			} else {
				setErrorMessage(outcome.message ?? t("ballotSubmitFailed"));
			}
		} finally {
			submittingRef.current = false;
			setSubmitting(false);
		}
	};

	// D-05: Withdraw the pending confirmation — unlocks the ballot for editing.
	const handleWithdrawConfirmation = async () => {
		if (!electionEngine || !ballotId) return;
		setErrorMessage("");
		setWithdrawing(true);
		try {
			await electionEngine.withdrawBallotConfirmation(ballotId);
			await refreshConfirmationState();
		} catch (error) {
			console.warn("withdrawBallotConfirmation error", errorClass(error));
			setErrorMessage(t("ballotWithdrawFailed"));
		} finally {
			setWithdrawing(false);
		}
	};

	// Carry-back from EditQuestionScreen SAVE: when editing an existing template,
	// EditQuestion popTos here with the assembled `question`. Merge it into the
	// draft (add or update by original code), then clear the param.
	const incomingQuestion = (route.params as { question?: Question } | undefined)?.question;
	useEffect(() => {
		if (!incomingQuestion) return;
		const originalQuestionCode = (
			route.params as { originalQuestionCode?: string } | undefined
		)?.originalQuestionCode;
		const lookupCode = originalQuestionCode ?? incomingQuestion.code;
		const existing = (ballotDraft.questions ?? []).some((q) => q.code === lookupCode);
		if (existing) {
			updateQuestion(lookupCode, incomingQuestion);
		} else {
			addQuestion(incomingQuestion);
		}
		navigation.setParams({
			question: undefined,
			originalQuestionCode: undefined,
		} as any);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [incomingQuestion?.code]);

	// Carry-back from EditQuestionScreen REMOVE: child passes removeQuestionCode via popTo.
	// We remove the question then clear the param to prevent re-fire (WARNING 7).
	const removeQuestionCode = (route.params as { removeQuestionCode?: string } | undefined)?.removeQuestionCode;
	useEffect(() => {
		if (!removeQuestionCode) return;
		removeQuestion(removeQuestionCode);
		navigation.setParams({ removeQuestionCode: undefined } as any);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [removeQuestionCode]);

	const handlePropose = async () => {
		// G12: upsert via engine (uses existing id to replace, not duplicate).
		if (!electionEngine) {
			// Guard: no engine in test/standalone contexts — still navigate back.
			navigation.goBack();
			return;
		}
		if (stateUnknown || locked || confirmed) return;
		setErrorMessage("");
		setProposing(true);
		const ballot: Ballot = {
			id: (ballotDraft as any).id ?? ballotId ?? `ballot-${electionId}-${Date.now()}`,
			electionId: ballotDraft.electionId ?? electionId ?? "",
			authorityId: (ballotDraft as any).authority ?? (ballotDraft as any).authorityId ?? "",
			description: ballotDraft.description ?? "",
			districts: ballotDraft.districts ?? [],
			questions: ballotDraft.questions ?? [],
		};
		try {
			await electionEngine.proposeBallot(ballot);
			navigation.goBack();
		} catch (error) {
			console.warn("proposeBallot error", errorClass(error));
			// Same re-read as the submit catch: a refusal because the ballot is now out for
			// confirmation or confirmed must leave the footer matching the engine (WR-04).
			const fresh = await readConfirmationState();
			if (fresh && (fresh.locked || fresh.confirmed)) {
				// gap8/WR-01: say what happened and drop the unsaved edits for the stored ballot.
				setErrorMessage(t(fresh.confirmed ? "ballotProposeRefusedConfirmed" : "ballotProposeRefusedLocked"));
				await reloadStoredBallot();
			} else {
				setErrorMessage(t("ballotProposeFailed"));
			}
		} finally {
			setProposing(false);
		}
	};

	// gap6/WR-02: the Tasks tab lives under the Home tab navigator (same form as EditElectionScreen).
	const openTasks = () => {
		navigation.dispatch(CommonActions.navigate({ name: "Home", params: { screen: "Tasks" } }));
	};

	const handleAuthorityChange = (authority: string) => {
		setBallotDraft((prev) => ({ ...prev, authority }) as any);
	};

	const handleDescriptionChange = (description: string) => {
		setBallotDraft((prev) => ({ ...prev, description }));
	};

	const handleDistrictsChange = (districts: string[]) => {
		setBallotDraft((prev) => ({ ...prev, districts }));
	};

	const handleAddQuestion = () => {
		navigation.navigate("EditQuestion", { electionTitle, electionDate });
	};

	const handleEditQuestion = (questionCode: string) => {
		// Pass the existing question so EditQuestion can pre-populate — its own
		// draft provider instance is separate/empty (screenLayout per-screen).
		const editQuestion = (ballotDraft.questions ?? []).find((q) => q.code === questionCode);
		navigation.navigate("EditQuestion", {
			questionCode,
			editQuestion,
			electionTitle,
			electionDate,
		} as any);
	};

	return (
		<View style={globalStyles.content}>
			<BallotTemplateForm
				electionTitle={electionTitle}
				electionDate={electionDate}
				authority={(ballotDraft as any).authority ?? ""}
				onAuthorityChange={handleAuthorityChange}
				authorityOptions={authorities.map((a) => ({ id: a.id, name: a.name }))}
				description={ballotDraft.description ?? ""}
				onDescriptionChange={handleDescriptionChange}
				districts={ballotDraft.districts ?? []}
				onDistrictsChange={handleDistrictsChange}
				questions={ballotDraft.questions ?? []}
				onAddQuestion={editingDisabled ? undefined : handleAddQuestion}
				onEditQuestion={editingDisabled ? undefined : handleEditQuestion}
				disabled={editingDisabled}
			/>
			<InlineError message={loadError} />
			<InlineError message={errorMessage} />
			{!readOnly && stateReadFailed && (
				<>
					<InlineError message={t("ballotStateLoadFailed")} />
					<View style={[globalStyles.footer, { backgroundColor: colors.card, paddingBottom: insets.bottom + 16 }]}>
						<CustomButton
							testID="edit-ballot-state-retry"
							title={t("ballotStateRetry")}
							icon="rotate-right"
							onPress={handleRetry}
							backgroundColor={colors.accent}
						disabled={retrying}
							/>
					</View>
				</>
			)}
			{/* Footer (UAT 62 test 13): hidden in readOnly preview, once confirmed, and while the
			    lock state is unknown (CR-03 fail closed). Locked -> Withdraw only; otherwise
			    Propose + Submit for confirmation. */}
			{!readOnly && !stateUnknown && !confirmed && (
				<View style={[globalStyles.footer, { backgroundColor: colors.card, paddingBottom: insets.bottom + 16 }]}>
					{locked ? (
						<>
							{submittedHint && (
								<View testID="edit-ballot-submitted-task-hint">
									<ThemedText>{t(submittedHint === "own" ? "ballotSubmittedOwnTaskHint" : "ballotSubmittedOthersHint")}</ThemedText>
									{submittedHint === "own" && (
										<CustomButton
											testID="edit-ballot-open-tasks"
											title={t("ballotOpenTasksLink")}
											icon="list-check"
											size="thin"
											onPress={openTasks}
											backgroundColor={colors.accent}
										/>
									)}
								</View>
							)}
							{confirmationState?.canWithdraw === true ? (
								<CustomButton
									testID="edit-ballot-withdraw"
									title={t("withdrawConfirmation")}
									icon="rotate-left"
									onPress={handleWithdrawConfirmation}
									backgroundColor={colors.warning ?? colors.accent}
									disabled={withdrawing}
								/>
							) : (
								<View testID="edit-ballot-out-for-confirmation">
									<ThemedText>{t("ballotOutForConfirmationNote")}</ThemedText>
								</View>
							)}
						</>
					) : (
						<>
							<CustomButton
								testID="edit-ballot-propose"
								title={t("propose")}
								icon="floppy-disk"
								onPress={handlePropose}
								backgroundColor={colors.success}
								forceDarkText={true}
								disabled={proposing || submitting}
							/>
							<CustomButton
								testID="edit-ballot-submit"
								title={t("submitForConfirmation")}
								icon="paper-plane"
								onPress={handleSubmitForConfirmation}
								backgroundColor={colors.accent}
								disabled={submitting || proposing || draftDirty}
							/>
							{draftDirty && (
								<View testID="edit-ballot-submit-needs-propose">
									<ThemedText>{t("ballotSubmitNeedsPropose")}</ThemedText>
								</View>
							)}
						</>
					)}
				</View>
			)}
		</View>
	);
};

export default EditBallotScreen;
