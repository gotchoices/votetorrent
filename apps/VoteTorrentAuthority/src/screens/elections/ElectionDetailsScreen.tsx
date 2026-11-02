import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, ScrollView, StyleSheet, Share } from "react-native";
import { ExtendedTheme, useRoute, useTheme, useNavigation, useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { peerUnavailableMessage } from "../../utils/peerUnavailableMessage";
import { ThemedText } from "../../components/ThemedText";
import type { BallotSummary, ElectionDetails, IElectionEngine, ElectionRevisionSignatureTask } from "@votetorrent/vote-core";
import { globalStyles } from "../../theme/styles";
import { InlineError } from "../../components/InlineError";
import { PeerReadUnavailableNotice } from "../../components/PeerReadUnavailableNotice";
import { classifyPeerReadFailure } from "../../engines/peer-read-unavailable";
import { ElectionDetailsBlock } from "./components/ElectionDetailsBlock";
import { ElectionTimelineList } from "./components/ElectionTimelineList";
import { ChipButton } from "../../components/ChipButton";
import { KeyholderCard } from "./components/KeyholderCard";
import { CustomButton } from "../../components/CustomButton";
import { CustomTextInput } from "../../components/CustomTextInput";
import { InfoCard } from "../../components/InfoCard";
import { formatDate } from "../../utils/displayUtils";
import type { NavigationProp } from "../../navigation/types";
import { useKeyboardInset } from "../../hooks/useKeyboardInset";

/**
 * ElectionDetailsScreen — Figma parity #13/#18/#19 per Phase 9 plan 09-14.
 *
 * Render order (top → bottom):
 *   1.  ElectionDetailsBlock — immutable core (title, Authority, Type, Date-time, Core Sig)
 *   2.  Current revision section (Revision #N + date, Tags, Timeline text list,
 *       Keyholder Policy, Revision Signature, PREVIEW chip)
 *   3.  Keyholders — Sent/Unsent cards + chevron
 *   4.  REVISE ELECTION / CLONE ELECTION actions
 *   5.  Proposed Revision block (conditional — only when electionDetails.proposed exists)
 *       · revision header, tags, timeline text list, keyholder policy
 *       · signing rows per keyholder (SIGN accent / SHARE warning CustomButton pills)
 *       · ADJUST REVISION → EditElectionRevision
 *   6.  Ballot Templates section (one InfoCard per template with Questions subtitle)
 *   7.  Registration Policy entry (InfoCard -> RegistrationPolicy) — Phase 46 (D-01)
 *   8.  Registrants entry (InfoCard -> RegistrantsList, election filter pre-applied) — Phase 47 plan 47-21 (D-07/D-08)
 *   8b. Results entry (InfoCard -> ElectionResults: decrypt + validate + tally after the key release)
 *   9.  More section (collapsible) + filter-authorities input
 */
type BallotConfirmationState = { locked: boolean; confirmed: boolean };

export default function ElectionDetailsScreen() {
	const { t } = useTranslation();
	// Read through a ref inside the load callbacks: a `t` that changes identity every render must
	// not become a dependency (it would re-create the callbacks and re-fire the focus effects).
	const tRef = useRef(t);
	tRef.current = t;
	const keyboardInset = useKeyboardInset();
	const { electionEngine, authorityName } = useRoute().params as { electionEngine: IElectionEngine; authorityName?: string };
	const [electionDetails, setElectionDetails] = useState<ElectionDetails | null>(null);
	const [ballots, setBallots] = useState<BallotSummary[]>([]);
	// D-09: confirmation state per ballot — { locked, confirmed } keyed by ballot id. An entry is
	// undefined when the state could not be read from the network and was never read before
	// (WR-01): that ballot shows no badge, never "Proposed".
	const [ballotConfirmationStates, setBallotConfirmationStates] = useState<Record<string, BallotConfirmationState | undefined>>({});
	const ballotConfirmationStatesRef = useRef(ballotConfirmationStates);
	ballotConfirmationStatesRef.current = ballotConfirmationStates;
	// WR-01: the ballots read goes through the same peer-read classifier as the details read.
	// ballotsRead: a ballots read has succeeded at least once (the notice variant is 'stale' then,
	// 'unavailable' before).
	const [ballotsRead, setBallotsRead] = useState(false);
	const [ballotsPeerUnavailable, setBallotsPeerUnavailable] = useState(false);
	const [moreOpen, setMoreOpen] = useState(false);
	const [errorMessage, setErrorMessage] = useState("");
	// REVIEW/IN-11: the details read's own failure. Separate from errorMessage because the ballots
	// reload clears errorMessage at its start and would otherwise erase it, leaving a first-open
	// failure spinning on Loading with no way out. Cleared only by a successful details read or a
	// Try Again start.
	const [detailsError, setDetailsError] = useState("");
	// Gap 7: a details read that could not reach the other devices. Kept apart from errorMessage so
	// the ballots focus effect (which clears errorMessage) cannot erase it. The notice variant is
	// derived at render: 'stale' while the details this device last read are still shown,
	// 'unavailable' when nothing has been read yet.
	const [peerUnavailable, setPeerUnavailable] = useState(false);
	// REVIEW/IN-05: everything below is the last read FOR one election. When the route moves to a
	// different election (a different engine), the previous election's reads are dropped in the
	// same render, so they can never show under the new one. (The route carries the election
	// engine, not an election id; the engine is the subject.)
	const [readSubject, setReadSubject] = useState(electionEngine);
	if (readSubject !== electionEngine) {
		setReadSubject(electionEngine);
		setElectionDetails(null);
		setBallots([]);
		setBallotConfirmationStates({});
		setBallotsRead(false);
		setBallotsPeerUnavailable(false);
		setPeerUnavailable(false);
		setErrorMessage("");
		setDetailsError("");
	}
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
	// WR-02: a cohort-unreachable read can take a long time to fail while Try Again (or a refocus)
	// starts another. Each read takes a sequence number and only the latest of its kind may write,
	// so a slow earlier failure cannot re-raise the notice over fresh data, and a slow earlier
	// success cannot overwrite a newer one.
	const detailsReadSeqRef = useRef(0);
	const ballotsReadSeqRef = useRef(0);
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation<NavigationProp>();
	const insets = useSafeAreaInsets();

	// UAT 62 M: re-read on every focus, not once per mount. The keyholder cards are derived from
	// these details, so a send or a same-device accept that happened while this screen sat under
	// the stack never reached them until the screen was rebuilt.
	const loadElectionDetails = useCallback(
		async (isCallerActive: () => boolean) => {
			const seq = ++detailsReadSeqRef.current;
			const isActive = () => seq === detailsReadSeqRef.current && isCallerActive();
			try {
				if (electionEngine) {
					// D-27: keyholders come from the engine only — no AsyncStorage merge.
					const details = await electionEngine.getElectionDetails();
					if (isActive()) {
						setElectionDetails(details);
						setPeerUnavailable(false);
						setDetailsError("");
					}
				}
			} catch (error) {
				const peerFailure = classifyPeerReadFailure(error);
				if (peerFailure) {
					// Gap 7 (D-23/D-39): the network could not answer, which is not the same as the
					// election being absent. Keep what this device already read; never surface the
					// engine message (it names block ids). Reason token only in the log.
					console.warn("[election-details] peer read unavailable:", peerFailure.reason);
					if (isActive()) setPeerUnavailable(true);
					return;
				}
				console.warn("Error loading election details:", error instanceof Error ? error.name : typeof error);
				if (isActive()) setDetailsError(peerUnavailableMessage(error, tRef.current, "read") ?? tRef.current("electionDetailsLoadFailed"));
			}
		},
		[electionEngine]
	);

	useFocusEffect(
		useCallback(() => {
			let active = true;
			loadElectionDetails(() => active);
			return () => {
				active = false;
			};
		}, [loadElectionDetails])
	);

	const retryElectionDetails = useCallback(() => {
		setDetailsError("");
		loadElectionDetails(() => mountedRef.current);
	}, [loadElectionDetails]);

	// G2/G12: Refresh ballot list on every focus so newly proposed templates appear
	// immediately on return from CreateBallot/EditBallot.
	// D-09: Also refresh confirmation states on focus so Proposed/Confirmed badge
	// updates when the user returns from the Tasks inbox after signing.
	const loadBallots = useCallback(
		async (isCallerActive: () => boolean) => {
			const seq = ++ballotsReadSeqRef.current;
			const isActive = () => seq === ballotsReadSeqRef.current && isCallerActive();
			setErrorMessage(""); // clear stale error before reload so transient failures don't persist
			try {
				if (electionEngine) {
					const summaries = await electionEngine.getBallots();
					if (!isActive()) return;
					setBallots(summaries);
					setBallotsRead(true);
					// D-09: fetch confirmation state for each ballot to drive the badge.
					// WR-01: a state the network could not answer keeps the badge this device last
					// read (or none), never the { locked: false, confirmed: false } "Proposed" default.
					const lastRead = ballotConfirmationStatesRef.current;
					let peerReason: string | undefined;
					const stateEntries = await Promise.all(
						summaries.map(async (b) => {
							try {
								const cs = await electionEngine.getBallotConfirmationState(b.id);
								return [b.id, cs] as const;
							} catch (e) {
								const peerFailure = classifyPeerReadFailure(e);
								if (peerFailure) {
									peerReason = peerFailure.reason;
									return [b.id, lastRead[b.id]] as const;
								}
								return [b.id, { locked: false, confirmed: false }] as const;
							}
						})
					);
					if (!isActive()) return;
					setBallotConfirmationStates(Object.fromEntries(stateEntries));
					if (peerReason) {
						console.warn("[election-details] ballots peer read unavailable:", peerReason);
					}
					setBallotsPeerUnavailable(peerReason !== undefined);
				}
			} catch (error) {
				const peerFailure = classifyPeerReadFailure(error);
				if (peerFailure) {
					// WR-01: keep the ballots this device already read; never surface the engine
					// message (it names block ids). Reason token only in the log.
					console.warn("[election-details] ballots peer read unavailable:", peerFailure.reason);
					if (isActive()) setBallotsPeerUnavailable(true);
					return;
				}
				console.warn("Error loading ballots:", error instanceof Error ? error.name : typeof error);
				if (isActive()) setErrorMessage(peerUnavailableMessage(error, tRef.current, "read") ?? tRef.current("electionBallotsLoadFailed"));
			}
		},
		[electionEngine]
	);

	useFocusEffect(
		useCallback(() => {
			let active = true;
			loadBallots(() => active);
			return () => {
				active = false;
			};
		}, [loadBallots])
	);

	const retryBallots = useCallback(() => {
		loadBallots(() => mountedRef.current);
	}, [loadBallots]);

	const handleShare = async (election: ElectionDetails["election"], proposed: ElectionDetails["proposed"], current: ElectionDetails["current"]) => {
		try {
			const message = [
				`Election: ${election.title}`,
				`Revision: #${proposed?.proposed.revision ?? current.revision}`,
				`Authority: ${election.authorityId}`,
				`Date: ${formatDate(election.date)}`,
			].join("\n");
			await Share.share({ message });
		} catch (err) {
			// The OS share-sheet rejection text is not ours to render.
			setErrorMessage(tRef.current("electionShareFailed"));
		}
	};

	if (!electionDetails) {
		return (
			<View style={styles.container}>
				{peerUnavailable ? (
					<PeerReadUnavailableNotice variant="unavailable" onRetry={retryElectionDetails} />
				) : detailsError ? (
					<View testID="election-details-load-error">
						<InlineError message={detailsError} />
						<CustomButton
							testID="election-details-retry"
							title={t("loadRetryButton")}
							icon="rotate"
							size="thin"
							onPress={retryElectionDetails}
						/>
					</View>
				) : (
					<ThemedText>{t("loading")}</ThemedText>
				)}
			</View>
		);
	}

	const { election, current, proposed } = electionDetails;
	const revisionSignature = (current as any).signature?.signature as string | undefined;
	const revisionDate = Array.isArray(current.revisionTimestamp) && current.revisionTimestamp.length > 0
		? (current.revisionTimestamp[0] as unknown as number)
		: election.date;

	return (
		<ScrollView
			style={styles.container}
			contentContainerStyle={{ paddingBottom: insets.bottom + 24 + keyboardInset }}>

			{/* SC6 error state — surfaces load failures inline (D-19) */}
			<View style={styles.section}>
				<InlineError message={errorMessage} />
				<InlineError message={detailsError} />
				{peerUnavailable ? <PeerReadUnavailableNotice variant="stale" onRetry={retryElectionDetails} /> : null}
			</View>

			{/* 1. Immutable core block (title + Authority/Type/Date + Core Signature) */}
			<View style={styles.section}>
				<ElectionDetailsBlock electionDetails={electionDetails} authorityName={authorityName} />
			</View>

			{/* 2. Current revision section — rendered ONCE here */}
			<View style={styles.section}>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("revision")}: </ThemedText>
					<ThemedText>#{current.revision} - {formatDate(revisionDate)}</ThemedText>
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("tags")}: </ThemedText>
					<ThemedText>{current.tags.join(", ")}</ThemedText>
				</View>

				{/* Timeline — text list per Decision 2 */}
				<ThemedText type="defaultSemiBold" style={styles.sectionLabel}>{t("timeline")}</ThemedText>
				<ElectionTimelineList timeline={current.timeline} />

				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("keyholderPolicy")}: </ThemedText>
					<ThemedText>{current.keyholderThreshold} of {current.keyholders.length}</ThemedText>
				</View>

				{revisionSignature ? (
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("revisionSignature")}: </ThemedText>
						<ThemedText numberOfLines={1} ellipsizeMode="middle">{revisionSignature}</ThemedText>
					</View>
				) : null}

				{/* PREVIEW chip — EUI-05/D-09: navigate to EditBallot in read-only mode.
				    WR-07: only show the single top-level PREVIEW when there is exactly
				    one template — otherwise it would silently preview only ballots[0].
				    With multiple templates the per-template cards below are the
				    unambiguous per-ballot entry points. */}
				{ballots.length === 1 ? (
					<ChipButton
						label={t("previewBallots")}
						onPress={() => {
							navigation.navigate("EditBallot", {
								electionId: election.id,
								electionTitle: election.title,
								electionDate: formatDate(election.date),
								ballotId: ballots[0].id,
								electionEngine,
								readOnly: true,
							} as any);
						}}
					/>
				) : null}
			</View>

			{/* 3. Keyholders — Sent/Unsent + chevron */}
			<View style={styles.section}>
				<ThemedText type="defaultSemiBold">{t("keyholders")}</ThemedText>
				{current.keyholders.map((keyholder, index) => (
					<KeyholderCard
						key={keyholder.invite?.name ?? `keyholder-${index}`}
						invitationStatus={keyholder}
						onPress={() => navigation.navigate("Keyholder", { keyholder, electionEngine })}
					/>
				))}
				<CustomButton
					title={t("invite")}
					icon="paper-plane"
					backgroundColor={colors.accent}
					size="thin"
					// UAT 62 L1: this INVITE used to open the send form with an empty Name. When exactly
					// one keyholder has not accepted yet it is the obvious invitee, so prefill it (the
					// accept is matched to the keyholder card by that name). Otherwise leave it blank.
					onPress={() => {
						const pending = current.keyholders.filter((k) => !k.result);
						navigation.navigate("KeyholderInvitation", {
							mode: "send",
							electionEngine,
							keyholder: pending.length === 1 ? pending[0] : undefined,
						});
					}}
				/>
			</View>

			{/* 4. REVISE / CLONE actions */}
			<View style={styles.section}>
				<CustomButton
					title={t("reviseElection")}
					size="thin"
					icon="pencil"
					backgroundColor={colors.accent}
					onPress={() => navigation.navigate("EditElectionRevision", { electionEngine })}
				/>
				<CustomButton
					title={t("cloneElection")}
					size="thin"
					icon="copy"
					backgroundColor={colors.accent}
					disabled={true}
					onPress={() => {/* Phase 21 */}}
				/>
			</View>

			{/* 5. Proposed Revision block — conditional */}
			{electionDetails.proposed && (
				<View style={styles.section}>
					<ThemedText type="defaultSemiBold">{t("proposedRevisionHeader")}</ThemedText>

					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("revision")}: </ThemedText>
						<ThemedText>#{proposed!.proposed.revision}</ThemedText>
					</View>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("tags")}: </ThemedText>
						<ThemedText>{proposed!.proposed.tags.join(", ")}</ThemedText>
					</View>

					<ThemedText type="defaultSemiBold" style={styles.sectionLabel}>{t("timeline")}</ThemedText>
					<ElectionTimelineList timeline={proposed!.proposed.timeline} />

					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("keyholderPolicy")}: </ThemedText>
						<ThemedText>{proposed!.proposed.keyholderThreshold} of {proposed!.proposed.keyholders.length}</ThemedText>
					</View>

					{/* Signing rows — one per proposed keyholder */}
					{proposed!.proposed.keyholders.map((holder, idx) => {
						// EUI-04 (D-02): navigation-only task object; real signing is Phase 21.
						// Mirrors TasksScreen.tsx:129 navigate("SignatureTask", { task }) shape.
						const signatureTask: ElectionRevisionSignatureTask = {
							type: "signature",
							signatureType: "election-revision",
							// network and userId are not available on this screen; Phase 21 will
							// source the real task from the task queue (navigation-only this phase).
							network: { hash: "", name: election.authorityId, primaryAuthorityDomainName: election.authorityId, relays: [] },
							userId: "",
							election: {
								proposed: {
									election: {
										id: election.id,
										authorityId: election.authorityId,
										title: election.title,
										type: election.type,
										date: election.date,
										revisionDeadline: election.revisionDeadline,
										ballotDeadline: election.ballotDeadline,
									},
									revision: proposed!.proposed,
								},
								signers: [],
							},
						};
						return (
							<View key={holder.name ?? `proposed-holder-${idx}`} style={styles.signingRow}>
								<ThemedText type="defaultSemiBold" style={styles.holderName}>{holder.name}</ThemedText>
								<View style={styles.signingPills}>
									<CustomButton
										title={t("signRevision")}
										size="thin"
										icon="signature"
										backgroundColor={colors.accent}
										onPress={() => navigation.navigate("SignatureTask", { task: signatureTask })}
									/>
									<CustomButton
										title={t("shareRevision")}
										size="thin"
										icon="share-nodes"
										backgroundColor={colors.warning}
										onPress={() => handleShare(election, proposed, current)}
									/>
								</View>
							</View>
						);
					})}

					{/* ADJUST REVISION → EditElectionRevision */}
					<CustomButton
						title={t("adjustRevision")}
						size="thin"
						icon="pencil"
						backgroundColor={colors.accent}
						onPress={() => navigation.navigate("EditElectionRevision", { electionEngine })}
					/>
				</View>
			)}

			{/* 6. Ballot Templates section */}
			<View style={styles.section}>
				<ThemedText type="title">{t("ballotTemplates")}</ThemedText>
				{/* WR-01: a ballots read the network could not answer is not "no ballot yet". */}
				{ballotsPeerUnavailable ? (
					<PeerReadUnavailableNotice variant={ballotsRead ? "stale" : "unavailable"} onRetry={retryBallots} />
				) : null}
				{ballotsPeerUnavailable && !ballotsRead ? null : ballots.length > 0 ? (
					ballots.map((ballot) => {
						// D-09: render a Proposed/Confirmed status badge driven by getBallotConfirmationState.
						// WR-01: no badge while the state is unknown (not read, network unreachable).
						const cs = ballotConfirmationStates[ballot.id];
						const statusLabel = !cs
							? undefined
							: cs.confirmed
								? t("statusConfirmed")
								: cs.locked
									? t("statusAwaitingConfirmation")
									: t("statusProposed");
						return (
							<InfoCard
								key={ballot.id}
								// The row names the ballot, never the authority's raw id (UAT 62 gap 4 item 4).
								title={ballot.description?.trim() || t("ballotTemplate")}
								subtitle={statusLabel}
								icon="chevron-right"
								onPress={() =>
									navigation.navigate("EditBallot", {
										electionId: election.id,
										electionTitle: election.title,
										electionDate: formatDate(election.date),
										ballotId: ballot.id,
										electionEngine,
									} as any)
								}
							/>
						);
					})
				) : (
					<>
						<ThemedText type="small">{t("noBallotYet")}</ThemedText>
						<CustomButton
							title={t("createBallotTemplate")}
							size="thin"
							icon="plus"
							backgroundColor={colors.accent}
							onPress={() =>
								navigation.navigate("CreateBallot", {
									electionId: election.id,
									electionTitle: election.title,
									electionDate: formatDate(election.date),
									electionEngine,
								} as any)
							}
						/>
					</>
				)}
			</View>

			{/* 7. Registration Policy entry — Phase 46 (D-01): one InfoCard placed after
			    Ballot Templates and before More, navigating to the single RegistrationPolicy
			    route (Fields/Disclosure/Attestation sections). */}
			<View style={styles.section} testID="election-details-registration-policy-entry">
				<InfoCard
					title={t("registrationPolicyEntryTitle")}
					icon="chevron-right"
					onPress={() =>
						navigation.navigate("RegistrationPolicy", {
							electionEngine,
							electionId: election.id,
							authorityId: election.authorityId,
						} as any)
					}
				/>
			</View>

			{/* 8. Registrants entry — Phase 47 plan 47-21 (D-07/D-08): this IS the
			    election roster. It navigates to the same RegistrantsList route the
			    authority-wide roster uses (AuthorityDetailsScreen), with an
			    election-scoped filter pre-applied below. There is deliberately no
			    second roster screen, no second engine method and no second route.
			    Sits beside Phase 46's Registration Policy entry because both are
			    election-scoped registration surfaces — the policy defines what is
			    collected, the roster shows who registered under it. The election's
			    title is passed because RegistrantsListScreen interpolates it into
			    its header title; it is public election metadata already rendered
			    on this screen — the ONLY non-identifier in any Phase 47 route
			    param (T-47-21-01). */}
			<View style={styles.section} testID="election-details-registrants-entry">
				<InfoCard
					title={t("registrantListScreenTitle")}
					icon="chevron-right"
					// NavigationProp (navigation/types.ts) already types params
					// loosely, so the type-escape cast the two neighbouring calls
					// carry adds nothing here — it is deliberately omitted.
					onPress={() =>
						navigation.navigate("RegistrantsList", {
							authorityId: election.authorityId,
							electionFilter: { electionId: election.id, electionTitle: election.title },
						})
					}
				/>
			</View>

			{/* 8b. Results entry: decrypt + validate + tally on this device once enough keyholders have released
			    their shares (the results screen explains the locked state before that). */}
			<View style={styles.section} testID="election-details-results-entry">
				<InfoCard
					title={t("resultsEntryTitle")}
					icon="chevron-right"
					onPress={() =>
						navigation.navigate("ElectionResults", {
							electionId: election.id,
							electionTitle: election.title,
							authorityId: election.authorityId,
						})
					}
				/>
			</View>

			{/* 9. More section (collapsible) + filter-authorities input */}
			<View style={styles.section}>
				<ChipButton label={t("more")} onPress={() => setMoreOpen((v) => !v)} />
				{moreOpen && (
					<CustomTextInput
						placeholder={t("filterAuthoritiesField")}
					/>
				)}
			</View>
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	detail: {
		flexDirection: "row",
		flexWrap: "wrap",
		marginVertical: 2,
	},
	sectionLabel: {
		marginTop: 8,
		marginBottom: 2,
	},
	signingRow: {
		marginVertical: 6,
	},
	holderName: {
		marginBottom: 4,
	},
	signingPills: {
		flexDirection: "row",
		gap: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };
