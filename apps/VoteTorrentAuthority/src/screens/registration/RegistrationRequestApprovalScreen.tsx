import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useFocusEffect, useNavigation, useRoute, useTheme } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type {
	LikelyDuplicateRequest,
	PriorRejection,
	RegistrantSignatureTask,
	RegistrationDuplicateClosure,
	RegistrationRequestRead,
	RegistrationStaleCloseAvailability,
	RegistrationVerificationChecklistItem,
	SigningStatus,
} from "@votetorrent/vote-core";
import { isChecklistGateMet, REGISTRATION_STALE_CLOSE_TIMEOUT_MS } from "@votetorrent/vote-core";
import {
	approveRegistrationRequest,
	closeRegistrationRequestAsStale,
	closesRequestIdOf,
	isRegistrationStaleCloseError,
	loadRegistrationApproval,
	recordRegistrationRejectVote,
	refuseRegistrationRequest,
	registrationApprovalErrorCode,
	registrationDecisionBlockers,
	type RegistrationApprovalErrorCode,
} from "@votetorrent/workflows/authority";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { KeyboardAvoidingScreen } from "../../components/KeyboardAvoidingScreen";
import { useKeyboardInset } from "../../hooks/useKeyboardInset";
import { InlineError } from "../../components/InlineError";
import { globalStyles } from "../../theme/styles";
import { useApp } from "../../providers/AppProvider";
import { createDeviceSigner } from "../../engines/device-signer";
import { resolveAuthorityKeyVault } from "../../engines/key-vault";
import { useDeviceSigningErrorHandler } from "../../hooks/useDeviceSigningErrorHandler";
import { useCurrentOfficerScopes } from "../../hooks/useCurrentOfficerScopes";
import {
	KNOWN_REQUEST_FIELD_LABEL_KEYS,
	REGISTRATION_REQUEST_STATUS_META,
	formatRequestTimestamp,
	humanizeFieldName,
	registrationRequestDisplayName,
} from "./registration-request-display";
import { truncateId } from "./registrant-display";
import { BridgeSourceCallout } from "./components/BridgeSourceBadge";
import { PriorRejectionsCallout } from "./components/PriorRejectionsCallout";
import { PossibleDuplicateCallout } from "./components/PossibleDuplicateCallout";
import { ThresholdProgressNote } from "../tasks/components/ThresholdProgressNote";
import { ChipButton } from "../../components/ChipButton";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import {
	createLazyDeviceSign,
	isClosedAsDuplicateError,
	isRegistrationContentAccessError,
	isRequesterSignatureUnverifiableError,
	registrationContentUnreadKey,
} from "./continuity-review";
import { VerificationChecklist } from "./components/VerificationChecklist";
import { RejectReasonCard } from "./components/RejectReasonCard";
import { pillStyles, tintPill } from "./components/pill";
import type { RootStackParamList } from "../../navigation/types";
import { peerUnavailableMessage } from "../../utils/peerUnavailableMessage";
import { trackCommits, useCommitShareTracker } from "../../hooks/useCommitShare";

/**
 * The shared workflow's coded failures (`RegistrationApprovalError`, code-only message: never a request id
 * or a screen name) mapped to catalog copy, so nothing from them can reach the screen as text.
 */
const APPROVAL_ERROR_KEYS: Record<RegistrationApprovalErrorCode, string> = {
	"not-found": "registrationRequestNotFound",
	"checklist-incomplete": "registrationRequestChecklistIncomplete",
	"no-task": "registrationRequestNoTask",
};
function approvalErrorKey(err: unknown): string | undefined {
	const code = registrationApprovalErrorCode(err);
	return code === undefined ? undefined : APPROVAL_ERROR_KEYS[code];
}

/**
 * RegistrationRequestApprovalScreen — the ceremony where an authority
 * officer actually decides a registration request (D-03/D-06/D-07).
 *
 * (1) This is a STANDALONE screen reached by its own route
 * (`RegistrationRequestApproval`, wired by 48-21). It deliberately adds NO
 * `'registrant'` branch to `SignatureTaskScreen.tsx`'s `titleKey` record or
 * its `signatureType` switch — that file is byte-unchanged by this phase.
 * What is reused from it is the ceremony SHAPE only: fetch the
 * engine-authoritative digest via `getSignatureDigest` -> sign with the
 * device-signer callback -> call the completion method -> `navigation.goBack()`,
 * with `InlineError` as the sole failure surface. The reason this is a
 * separate screen is D-07: the verification checklist is a screen-local gate
 * `SignatureTaskScreen.tsx` has no equivalent of, and bolting a seventh
 * branch onto a switch serving six unrelated ceremonies would put the
 * checklist one refactor away from every other signature type.
 *
 * (2) The render order below is a safety property, not a layout preference.
 * `BridgeSourceCallout` renders first because D-03 requires a bridge
 * assertion to be unmissable. `PriorRejectionsCallout` renders directly
 * beneath it, above the summary and the checklist, because an officer who
 * never scrolls past a re-submitted request must still see that this person
 * was refused before (D-06).
 *
 * (3) Never-log rule: the request summary renders unmasked — an officer
 * cannot honestly complete the D-07 checklist against a masked value, so
 * masking would make the checklist dishonest. The compensating control is
 * that no payload value, no `rejectionReason`, and neither `read.submittedAt`
 * nor `read.receivedAt` ever reaches `console.*`, an `errorMessage`, an i18n
 * interpolation, or a crash payload — the same contract Phase 47's
 * `RegistrantDetailScreen` states for `RegistrantPrivate`. This file
 * deliberately contains ZERO `console.*` calls — a divergence from
 * `SignatureTaskScreen.tsx`, which does `console.warn` on its own catch
 * branches: that screen's tasks carry no registrant PII, this screen's
 * summary does.
 *
 * (4) `useCurrentOfficerScopes()` here is a UI legibility convenience, not a
 * security boundary. `AdminSigning.SignerKeyValid` and
 * `OfficerSignature.OfficerValid` are hardcoded stub CHECKs, and
 * `AdminSigning.UserIdValid` requires the signer to be some officer at the
 * authority, not one scoped to any particular value — a pre-existing,
 * cross-cutting gap tracked under Phase 999.1 and out of scope here. This
 * file makes no claim anywhere that write access is scope-gated at the data
 * layer; `canDecide` decides only which write controls render `disabled`.
 *
 * (5) D-44 / D-11 (62-27). `PossibleDuplicateCallout` renders beneath the prior-rejections
 * callout. A request closed (or closing) as a duplicate renders its own block, and its Approve and
 * Reject controls stay present but disabled. Each decision is published right after it resolves,
 * through `RegistrationEngine.publishRegistrationDecision` with `closesRequestId` set to the
 * callout candidate or null (never omitted); a publish failure never reports the recorded decision
 * as failed, and 62-25's drain publishes it later. At a vrg threshold above 1, Reject records a
 * vote through the officer's own registrant task (62-11 refuses a single-officer
 * `rejectRegistrationRequest` above threshold 1); the reason is not collected, because whether to
 * persist it is an open question. No screen calls a transport's `publishDecision`.
 *
 * (6) D-49 (62-31) seals the payload per officer. An unread payload renders an explicit
 * unreadable state in place of the summary and checklist, never an empty form. The copy is
 * 62-10's Group K; the approval gate's `RegistrationContentAccessError` is mapped by its access
 * code, and its message (request id plus access code) is never rendered.
 *
 * The decision workflow itself (load, gate, sign, complete, publish) lives in `@votetorrent/workflows`
 * `registration-approval.ts` (67-18); this screen keeps state and presentation and calls it.
 */

export interface RequestSummaryRow {
	key: string;
	labelKey?: string;
	label?: string;
	value: string;
}

/** Recursion guard mirroring `registrant-detail-model.ts`'s flatten discipline — malformed stored JSON must never hang a render. */
const MAX_PRIVATE_DETAIL_DEPTH = 8;

function slugifyFieldName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** Pushes one row IFF `value` is not `undefined`/`null` — an empty string IS pushed (a declared-but-blank field is information the officer needs). Coerces with `String(...)`. A known field name gets a translated `labelKey`; any other name a humanized `label` — never the raw key. */
function pushFieldRow(rows: RequestSummaryRow[], key: string, fieldName: string, value: unknown): void {
	if (value === undefined || value === null) return;
	const labelKey = Object.prototype.hasOwnProperty.call(KNOWN_REQUEST_FIELD_LABEL_KEYS, fieldName)
		? KNOWN_REQUEST_FIELD_LABEL_KEYS[fieldName]
		: undefined;
	rows.push(
		labelKey ? { key, labelKey, value: String(value) } : { key, label: humanizeFieldName(fieldName), value: String(value) }
	);
}

function pushPrivateDetailRows(
	rows: RequestSummaryRow[],
	details: ReadonlyArray<{ name: string; value: string | number | boolean | unknown[]; hint?: string }>,
	depth: number,
	namePrefix: string
): void {
	if (depth >= MAX_PRIVATE_DETAIL_DEPTH) return;
	for (const detail of details) {
		if (typeof detail?.name !== "string" || detail.name.trim().length === 0) continue;
		const qualifiedName = namePrefix.length > 0 ? namePrefix + "." + detail.name : detail.name;
		if (Array.isArray(detail.value)) {
			pushPrivateDetailRows(
				rows,
				detail.value as ReadonlyArray<{ name: string; value: string | number | boolean | unknown[]; hint?: string }>,
				depth + 1,
				qualifiedName
			);
		} else {
			pushFieldRow(rows, "private-" + slugifyFieldName(qualifiedName), qualifiedName, detail.value);
		}
	}
}

/**
 * `buildRequestSummaryRows` — the pure, exported helper the render loop
 * consumes. No React, no `t()`, no theme: the caller translates `labelKey`
 * and renders `label` verbatim. Payload fields the Voter submits carry a
 * `labelKey` (`KNOWN_REQUEST_FIELD_LABEL_KEYS`); any other field name carries
 * a humanized `label`, never the raw key.
 *
 * Rows 1 and 2 are the provenance pair and they LEAD the summary — this
 * ordering is a safety property, not a layout preference. `submittedAt` is
 * submitter-chosen, a claim carried inside the request's own signature and
 * attacker-controlled within 48-07's skew bound; `receivedAt` is the
 * authority's own observation, inside no digest, and the key 48-08's triage
 * queue is ordered by. T-48-05-09, T-48-07-12 and T-48-08-11 all ACCEPT a
 * misstated `submittedAt` on the explicit ground that the officer can see
 * the divergence, and this screen is where the decision is actually made —
 * so the pair sits above every payload field, where an officer who never
 * scrolls still sees it. BOTH rows are emitted unconditionally, in every
 * mode, even when the two values are equal — this screen applies NO
 * divergence threshold (unlike 48-14's list row) and never calls
 * `resolveRowTimestamps`: that threshold exists to protect the D-03 marker's
 * weight in a dense list, and a detail screen has no such budget. Never emit
 * one value under the other's row key, and never merge the two into one row.
 *
 * This function performs no masking, no truncation of payload values (other
 * than the final `requesterKey` row, which truncates the same way every
 * other truncated-key surface in this app does), and no logging.
 */
export function buildRequestSummaryRows(read: RegistrationRequestRead): RequestSummaryRow[] {
	const rows: RequestSummaryRow[] = [];

	rows.push({
		key: "received-at",
		labelKey: "registrationRequestApprovalReceivedAtLabel",
		value: formatRequestTimestamp(read.receivedAt),
	});
	rows.push({
		key: "submitted-at",
		labelKey: "registrationRequestApprovalSubmittedAtLabel",
		value: formatRequestTimestamp(read.submittedAt),
	});

	const publicTier = read.payload.public;
	if (publicTier) {
		pushFieldRow(rows, "public-lastname", "lastName", publicTier.lastName);
		pushFieldRow(rows, "public-firstname", "firstName", publicTier.firstName);
		pushFieldRow(rows, "public-district", "district", publicTier.district);
		if (publicTier.extraFields) {
			for (const name of Object.keys(publicTier.extraFields)) {
				pushFieldRow(rows, "public-" + slugifyFieldName(name), name, publicTier.extraFields[name]);
			}
		}
	}

	const privateDetails = read.payload.private?.details;
	if (Array.isArray(privateDetails)) {
		pushPrivateDetailRows(rows, privateDetails, 0, "");
	}

	const selectiveDetails = read.payload.selective?.details;
	if (Array.isArray(selectiveDetails)) {
		for (const item of selectiveDetails) {
			pushFieldRow(rows, "selective-" + slugifyFieldName(item.name), item.name, item.value);
		}
	}

	rows.push({
		key: "requester-key",
		labelKey: "registrationRequestApprovalRequesterKeyLabel",
		value: truncateId(read.requesterKey),
	});

	return rows;
}

type ApprovalMode = "loading" | "pending" | "approved" | "rejected";

export default function RegistrationRequestApprovalScreen() {
	const { requestId, authorityId } = useRoute().params as { requestId: string; authorityId: string };
	// Writes this decision makes are attributed to it, so the inbox can say when one has not reached
	// the network yet (todo 2026-09-11-optimystic-commit-success-hides-unresolvable-cohort).
	const commitTracker = useCommitShareTracker();
	const trackDecision = <T,>(fn: () => Promise<T>): Promise<T> => trackCommits(commitTracker, `decision:${requestId}`, fn);
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { t } = useTranslation();
	// Effects read the translator through a ref so a language change does not re-run the load.
	const tRef = useRef(t);
	tRef.current = t;
	const handleDeviceSigningError = useDeviceSigningErrorHandler();
	const { colors } = useTheme() as ExtendedTheme;
	const insets = useSafeAreaInsets();
	const keyboardInset = useKeyboardInset();
	const { getEngine, createPeerStagingTransports } = useApp();
	const { scopes, refresh: refreshScopes } = useCurrentOfficerScopes(authorityId);
	// UAT 62 gap 4 item 1: officer standing can change while this screen is backgrounded (for
	// example after Replace Signing Key), so re-read it on every focus; canDecide never stays stale.
	useFocusEffect(
		React.useCallback(() => {
			refreshScopes();
		}, [refreshScopes])
	);

	useLayoutEffect(() => {
		navigation.setOptions({ title: t("registrationRequestApprovalScreenTitle") });
	}, [navigation, t]);

	const [read, setRead] = useState<RegistrationRequestRead | undefined>(undefined);
	const [priorRejections, setPriorRejections] = useState<PriorRejection[]>([]);
	const [priorRejectionsUnavailable, setPriorRejectionsUnavailable] = useState(false);
	// D-44: the likely-duplicate candidate the callout shows (oldest first), the closure state, and
	// the "could not check" flags. Refusing under uncertainty is safe; approving a possible
	// duplicate without seeing the flag is not.
	const [duplicate, setDuplicate] = useState<LikelyDuplicateRequest | undefined>(undefined);
	const [duplicateUnavailable, setDuplicateUnavailable] = useState(false);
	const [closure, setClosure] = useState<RegistrationDuplicateClosure | undefined>(undefined);
	const [closureUnavailable, setClosureUnavailable] = useState(false);
	// D-11: display-only status of the vrg session behind this request.
	const [signingStatus, setSigningStatus] = useState<SigningStatus | null>(null);
	// Bumping this re-runs the load effect (after a vote, a closed race, a content refusal).
	const [reloadNonce, setReloadNonce] = useState(0);
	// A message that must survive the reload it triggers (the load effect clears the error area).
	const carryMessageRef = useRef("");
	const [task, setTask] = useState<RegistrantSignatureTask | undefined>(undefined);
	const [checked, setChecked] = useState<RegistrationVerificationChecklistItem[]>([]);
	const [gateMet, setGateMet] = useState(false);
	const [showRejectCard, setShowRejectCard] = useState(false);
	// Above a vrg threshold of 1: whether this officer may close the request as rejected on their own
	// (its session has been open for the stale-close timeout). Engine-owned; a failed read hides it.
	const [staleClose, setStaleClose] = useState<RegistrationStaleCloseAvailability | undefined>(undefined);
	const [showStaleCloseCard, setShowStaleCloseCard] = useState(false);
	const [errorMessage, setErrorMessage] = useState("");
	const [loading, setLoading] = useState(true);

	// CR-02/WR-08 stale-setState guard, copied from RegistrantDetailScreen.tsx.
	const unmountedRef = useRef(false);
	useEffect(() => {
		unmountedRef.current = false;
		return () => {
			unmountedRef.current = true;
		};
	}, []);

	// A SYNCHRONOUS double-press guard on Approve — a signed, irreversible
	// write. Two touches dispatched in the same JS tick both read the SAME
	// closure's state (React does not re-render synchronously between them),
	// so a `useState`-only guard cannot close that gap; a ref mutation is
	// visible to every subsequent call in the same tick. This app has already
	// shipped double-press defects on signed writes (RejectReasonCard's own
	// `submittingRef` doc comment carries the identical reasoning).
	const submittingRef = useRef(false);
	// WR-13: the ref is the CORRECTNESS guard; this state is the FEEDBACK. Mutating a ref
	// schedules no render, so the previous `disabled={… || submittingRef.current}` never actually
	// disabled the button while the ceremony was in flight — directly contradicting the comment
	// that claimed "the visual freeze tracks the ref without a redundant state variable". On a
	// slow device-signer path (biometric prompt, TEE round trip) the officer saw an apparently
	// live Approve button for the whole ceremony. The two are set together, ref first, and both
	// cleared in the same `finally`; the state is NEVER read as the guard, so the
	// same-tick double-press case still resolves against the ref.
	const [submitting, setSubmitting] = useState(false);

	const mode: ApprovalMode =
		read?.status === "p" ? "pending" : read?.status === "a" ? "approved" : read?.status === "r" ? "rejected" : "loading";
	// A UI legibility convenience only — see the file header (4). Gates
	// `disabled` on the two write controls below and nothing else; no data
	// path anywhere in this file branches on it.
	const canDecide = scopes?.includes("vrg") ?? false;

	useEffect(() => {
		async function load() {
			setLoading(true);
			setErrorMessage(carryMessageRef.current);
			carryMessageRef.current = "";
			setPriorRejectionsUnavailable(false);
			setDuplicate(undefined);
			setDuplicateUnavailable(false);
			setClosure(undefined);
			setClosureUnavailable(false);
			setSigningStatus(null);
			setStaleClose(undefined);
			try {
				// The reads (request, prior rejections, duplicate closure, likely duplicates, the
				// requestId-scoped own task, signing status, stale-close availability) and their
				// partial-failure semantics live in the shared workflow; it never throws.
				const view = await loadRegistrationApproval({ getEngine, requestId, shouldStop: () => unmountedRef.current });
				if (unmountedRef.current) return;
				if (view.read) {
					setRead(view.read);
					setChecked(view.read.verificationChecklist ?? []);
				}
				if (view.priorRejections) setPriorRejections(view.priorRejections);
				setPriorRejectionsUnavailable(view.priorRejectionsUnavailable);
				setClosure(view.closure);
				setClosureUnavailable(view.closureUnavailable);
				setDuplicate(view.duplicate);
				setDuplicateUnavailable(view.duplicateUnavailable);
				if (view.taskLookup) setTask(view.taskLookup.task);
				setSigningStatus(view.signingStatus);
				setStaleClose(view.staleClose);
				// The error area: later failures win over earlier ones, as the sequential reads did.
				if (view.priorRejectionsUnavailable) {
					// L-3: rendering nothing here would be indistinguishable from "no prior rejections",
					// the exact misreading D-06 exists to prevent — so the failure is surfaced and Approve
					// is blocked while Reject stays available. Refusing under uncertainty is safe;
					// approving under it is not.
					setErrorMessage(
						peerUnavailableMessage(view.priorRejectionsFailure, tRef.current, "read") ?? tRef.current("priorRejectionsUnavailable")
					);
				}
				if (view.closureUnavailable || view.duplicateUnavailable) {
					// L-3 mirror: the engine message is never shown, and Approve is blocked.
					setErrorMessage(t("possibleDuplicateCheckFailed"));
				}
				if (view.failure !== undefined) {
					const tr = tRef.current;
					const coded = approvalErrorKey(view.failure);
					setErrorMessage(peerUnavailableMessage(view.failure, tr, "read") ?? tr(coded ?? "registrationRequestLoadFailed"));
				}
			} finally {
				if (!unmountedRef.current) setLoading(false);
			}
		}
		load();
		// `t` is intentionally not a dependency: a locale change must not re-run the engine reads.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [requestId, getEngine, reloadNonce]);

	// Derived values (D-44 / D-11 / D-49): the data terms of the Approve and Reject `disabled`
	// expressions come from the shared workflow, so the CLI refuses on exactly the conditions an
	// officer sees here; the UI-only terms (`gateMet`, `canDecide`, `submitting`) stay below.
	const blockers = registrationDecisionBlockers({
		read,
		priorRejectionsUnavailable,
		closure,
		closureUnavailable,
		duplicateUnavailable,
		taskLookup: { task },
		signingStatus,
	});
	const { thresholdAboveOne, unreachable, closedAsDuplicate, contentReadable, rejectableUnread } = blockers;
	const unreadKey = registrationContentUnreadKey(read?.payloadAccess);
	// D-07: derived from `checked` directly (not the `gateMet` state), because `checked` can be
	// seeded from `read.verificationChecklist` before VerificationChecklist reports.
	const checklistGateMet = isChecklistGateMet(checked);
	// One definition shared by the readable branch and the tampered branch.
	const checklistElement = (
		<VerificationChecklist
			checked={checked}
			onChange={(next, met) => {
				setChecked(next);
				setGateMet(met);
			}}
			readOnly={mode !== "pending"}
			decidedAt={read?.decidedAt}
		/>
	);
	// 62-31 degrades an unread registrant task to the base task, so a missing own task does not
	// mean the officer voted.
	const voteRecorded = mode === "pending" && thresholdAboveOne && !task && !unreachable && contentReadable;
	// Close as Rejected: offered to a vrg officer once the engine reports the request closable, in the
	// unreachable state too (that is the request it exists for).
	const staleCloseOffered = mode === "pending" && staleClose?.available === true && canDecide && !closedAsDuplicate;

	// The signer seam the shared workflow takes: resolved per ceremony, never a key.
	const resolveDeviceSign = () => createDeviceSigner("Device User");

	function buildReviewDeps() {
		return {
			getEngine,
			createPeerStagingTransports,
			authorityId,
			sign: createLazyDeviceSign(resolveDeviceSign),
			resolveVault: resolveAuthorityKeyVault,
		};
	}

	/** The request the callout showed, or null: never omitted (automatic closure would close an unseen request). */
	function closesRequestId(): string | null {
		return closesRequestIdOf({ duplicate, duplicateUnavailable });
	}

	// G. handleApprove — the accept ceremony (D-07): the shared workflow fetches the
	// engine-authoritative digest, signs it device-side, completes the signature with the
	// checklist bound into `decision` and publishes; this handler then leaves.
	async function handleApprove() {
		if (submittingRef.current) return;
		submittingRef.current = true;
		// WR-13: set immediately after the ref, so the render pass that follows this press already
		// shows the button disabled. Never checked as the guard — see the ref's own comment.
		setSubmitting(true);
		try {
			setErrorMessage("");
			// WR-02 / 48-11 L-2: the D-07 gate (against `checked`, the array actually bound into
			// `decision.checklist`), the own-task check, the digest, the device signature and the
			// completion with `sign` passed unconditionally are re-asserted inside
			// approveRegistrationRequest before any signature is requested.
			const result = await approveRegistrationRequest({
				getEngine,
				requestId,
				task,
				checklist: checked,
				resolveSign: resolveDeviceSign,
				review: buildReviewDeps(),
				closesRequestId: closesRequestId(),
				track: trackDecision,
			});
			if (thresholdAboveOne && result.published.kind === "still-pending") {
				// Below threshold: the vote is recorded, the request is still pending.
				setReloadNonce((n) => n + 1);
				return;
			}
			// No toast, no checkmark — this is a ceremony screen, mirroring
			// SignatureTaskScreen.tsx.
			navigation.goBack();
		} catch (err) {
			if (isClosedAsDuplicateError(err)) {
				setErrorMessage("");
				setReloadNonce((n) => n + 1);
			} else if (isRegistrationContentAccessError(err)) {
				// D-49: the approval gate refused before any signature was spent. Mapped by access
				// code; its message (request id plus access code) is never rendered.
				carryMessageRef.current = t(registrationContentUnreadKey(err.access) ?? "registrationContentUnreadable");
				setReloadNonce((n) => n + 1);
			} else if (isRequesterSignatureUnverifiableError(err)) {
				// The engine refused before any signature was spent: the request itself is undecidable, so
				// fixed copy with no retry invitation and never the engine text.
				setErrorMessage(t("registrationRequestUnverifiable"));
			} else {
				const outcome = handleDeviceSigningError(err);
				if (!outcome.handled) {
					const coded = approvalErrorKey(err);
					setErrorMessage(outcome.message ?? t(coded ?? "registrationRequestApproveFailed"));
				}
			}
		} finally {
			submittingRef.current = false;
			// The screen navigates away on success, so this setState can land after unmount —
			// guarded by the same `unmountedRef` discipline the load effect uses.
			if (!unmountedRef.current) setSubmitting(false);
		}
	}

	// H. handleReject — the refusal.
	//
	// D-12 / L-2 (48-11, 48-12) / WR-14 are carried by the shared refuseRegistrationRequest: the gate
	// first (an ungated press spends NO biometric prompt), the signer handed to the engine to sign the
	// rejection RECORD (never a digest read, never a signer call of its own, so the signing session
	// is never advanced), the blank-triple task close isolated and swallowed past the recorded
	// rejection, and the publish as a third separately failing act that never throws.
	async function handleReject(reason: string): Promise<void> {
		setErrorMessage("");
		try {
			// `reason` arrives already trimmed from RejectReasonCard — not re-trimmed here.
			await refuseRegistrationRequest({
				getEngine,
				requestId,
				task,
				checklist: checked,
				reason,
				resolveSign: resolveDeviceSign,
				review: buildReviewDeps(),
				closesRequestId: closesRequestId(),
				track: trackDecision,
			});
			navigation.goBack();
		} catch (err) {
			if (registrationApprovalErrorCode(err) === "checklist-incomplete") {
				// D-07 / WR-02: the engine refuses an ungated reject, and the buttons are disabled on the
				// same predicate; this is the belt to those braces. Fixed text, no request id. Rethrown
				// so RejectReasonCard's latch returns to idle.
				setErrorMessage(t("registrationRequestRejectChecklistRequired"));
				throw err;
			}
			if (isClosedAsDuplicateError(err)) {
				setErrorMessage("");
				setShowRejectCard(false);
				setReloadNonce((n) => n + 1);
			} else if (isRequesterSignatureUnverifiableError(err)) {
				// 62-64 refusal: undecidable request, refused before any officer signature.
				setErrorMessage(t("registrationRequestUnverifiable"));
			} else {
				const outcome = handleDeviceSigningError(err);
				if (!outcome.handled) {
					setErrorMessage(outcome.message ?? t("registrationRequestRejectFailed"));
				}
			}
			// Re-thrown so RejectReasonCard's own submit latch (idle ->
			// submitting -> submitted) sees a REJECTED onConfirm and returns to
			// idle — mirroring RegistrantDetailScreen.tsx's handleConfirmLifecycle
			// precedent. Without this a failed reject would latch the card on
			// "submitted" permanently, stranding the officer with no retry.
			throw err;
		}
	}

	// D-11 (crossnote assignment): at a vrg threshold above 1 a rejection is a RECORDED VOTE, not a
	// veto (UI-SPEC Surface 5). 62-11 refuses a single-officer `rejectRegistrationRequest` above
	// threshold 1, so this records the officer's decision through their own registrant task, the
	// blank triple exactly as the rejected-task completion above does: no `sign`, no `decision`, no
	// device signer, no confirm and no reason card. The reason is NOT collected, because whether to
	// persist it needs a schema change and that question is still open.
	async function handleThresholdRejectVote() {
		if (submittingRef.current) return;
		submittingRef.current = true;
		setSubmitting(true);
		try {
			setErrorMessage("");
			await recordRegistrationRejectVote({ getEngine, task });
			// The request stays pending until the session resolves: reload to show the status.
			setReloadNonce((n) => n + 1);
		} catch (err) {
			if (isClosedAsDuplicateError(err)) {
				setErrorMessage("");
				setReloadNonce((n) => n + 1);
			} else {
				const outcome = handleDeviceSigningError(err);
				if (!outcome.handled) {
					const coded = approvalErrorKey(err);
					setErrorMessage(outcome.message ?? t(coded ?? "registrationRequestVoteFailed"));
				}
			}
		} finally {
			submittingRef.current = false;
			if (!unmountedRef.current) setSubmitting(false);
		}
	}

	// Close as Rejected (stale close): one officer closes a request whose co-signers did not decide in
	// time. The engine re-checks the timeout and the officer's 'vrg' scope and records the checklist
	// 'none'. The decision is then published so the requester is told; as with handleReject, a failed
	// task completion or publish is never reported as a failed close.
	async function handleStaleClose(reason: string): Promise<void> {
		setErrorMessage("");
		try {
			await closeRegistrationRequestAsStale({
				getEngine,
				requestId,
				task,
				reason,
				resolveSign: resolveDeviceSign,
				review: buildReviewDeps(),
				track: trackDecision,
			});
			navigation.goBack();
		} catch (err) {
			if (isRegistrationStaleCloseError(err)) {
				setErrorMessage(t(err.code === "too-early" ? "registrationRequestStaleCloseNotYet" : "registrationRequestStaleCloseFailed"));
				if (err.code !== "too-early") setReloadNonce((n) => n + 1);
			} else {
				const outcome = handleDeviceSigningError(err);
				if (!outcome.handled) {
					setErrorMessage(outcome.message ?? t("registrationRequestStaleCloseFailed"));
				}
			}
			// Re-thrown so the card's submit latch returns to idle for a retry.
			throw err;
		}
	}

	const summaryRows = read ? buildRequestSummaryRows(read) : [];
	const rejectedMeta = REGISTRATION_REQUEST_STATUS_META.r;

	return (
		<KeyboardAvoidingScreen testID="registration-request-approval-screen">
			{/* Neither decided mode renders a footer (see below), so nothing else
			    clears the Android gesture bar / iOS home indicator below the last
			    line of the approved or rejected block — the rejected block's
			    trailing decided-at line was unreachable at maximum scroll for
			    exactly this reason (48-UAT.md gap 3 / DEFECT-3). Applied
			    unconditionally (not just in decided modes) so this does not become
			    a third three-valued branch; in pending mode the Footer supplies its
			    own inset clearance and the extra scroll room is harmless. Mirrors
			    RegistrationInboxScreen.tsx's contentContainerStyle exactly — do not
			    delete this as redundant-looking. */}
			<ScrollView
				testID="registration-request-approval-scroll"
				style={styles.container}
				contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
			>
				{/* InlineError renders null for an empty message and carries no
				    testID prop, so its absence is otherwise unassertable — the
				    wrapping View is what makes presence/absence testable. */}
				{/* One error surface at a time: while the reject card is open it shows the failure itself. */}
				{errorMessage && !(mode === "pending" && (showRejectCard || showStaleCloseCard) && read) ? (
					<View testID="registration-request-approval-error">
						<InlineError message={errorMessage} />
					</View>
				) : null}

				{read ? (
					<>
						{/* D-03: BridgeSourceCallout owns its own issuerType === 'bridge'
						    absence rule. No screen-level condition is added around it —
						    duplicating that condition is how the two drift. */}
						<BridgeSourceCallout issuerType={read.issuerType} bridgeLabel={read.bridgeLabel} bridgeId={read.bridgeId} />

						{/* D-06: PriorRejectionsCallout returns null for an empty array —
						    rendered unconditionally, no wrapping length check. */}
						<PriorRejectionsCallout rejections={priorRejections} />

						{/* D-44: directly beneath the prior-rejections callout. Absent when there is no
						    candidate, and never rendered for an already-closed request. */}
						<PossibleDuplicateCallout
							candidate={closedAsDuplicate ? undefined : duplicate}
							onViewOther={(id) => navigation.push("RegistrationRequestApproval", { requestId: id, authorityId })}
						/>

						{/* D-11: threshold progress, rendered from a status read that survives the
						    officer's own vote. An unreachable session renders its own block below. */}
						{!unreachable ? (
							<View testID="registration-request-approval-threshold-note">
								<ThresholdProgressNote status={signingStatus} />
							</View>
						) : null}
						{voteRecorded ? (
							<ThemedText
								type="small"
								style={{ color: colors.textSecondary }}
								testID="registration-request-approval-vote-recorded"
							>
								{t("signatureTaskThresholdVoteRecorded")}
							</ThemedText>
						) : null}

						{closedAsDuplicate ? (
							<View testID="registration-request-approval-duplicate-closed-block" style={localStyles.stateBlock}>
								<View style={[pillStyles.pill, { backgroundColor: tintPill(colors.warning) }]}>
									<ThemedText type="smallBold" style={{ color: colors.warningText }}>
										{t("possibleDuplicateClosedLabel")}
									</ThemedText>
								</View>
								{closure?.closedByRequestId ? (
									<ChipButton
										fullWidth
										label={t("possibleDuplicateViewOtherButton")}
										onPress={() =>
											navigation.push("RegistrationRequestApproval", {
												requestId: closure.closedByRequestId!,
												authorityId,
											})
										}
									/>
								) : null}
							</View>
						) : null}

						{unreachable ? (
							<View testID="registration-request-approval-unreachable-block" style={localStyles.stateBlock}>
								<View
									testID="registration-request-approval-unreachable-pill"
									style={[pillStyles.pill, { backgroundColor: tintPill(colors[rejectedMeta.colorKey]) }]}
								>
									<ThemedText type="smallBold" style={{ color: colors[rejectedMeta.colorKey] }}>
										{t(rejectedMeta.labelKey)}
									</ThemedText>
								</View>
								<ThemedText type="small" testID="registration-request-approval-unreachable-text">
									{t("signatureTaskThresholdUnreachable")}
								</ThemedText>
							</View>
						) : null}

						{staleCloseOffered && !showStaleCloseCard ? (
							<View testID="registration-request-approval-stale-close-block" style={localStyles.stateBlock}>
								<ThemedText type="small" testID="registration-request-approval-stale-close-note">
									{t("registrationRequestStaleCloseNote", { days: Math.round(REGISTRATION_STALE_CLOSE_TIMEOUT_MS / 86_400_000) })}
								</ThemedText>
								<View testID="registration-request-approval-stale-close">
									<CustomButton
										title={t("registrationRequestStaleCloseButton")}
										icon="xmark"
										backgroundColor={colors.error}
										disabled={submitting}
										onPress={() => {
											setShowRejectCard(false);
											setShowStaleCloseCard(true);
										}}
									/>
								</View>
							</View>
						) : null}

						{/* D-49: an unread payload renders why, in place of the summary and the checklist,
						    never an empty form. The copy is a Group K key; no payload text, request id or
						    access code reaches this node. */}
						{!contentReadable ? (
							<>
							<View
								testID="registration-request-approval-content-unreadable"
								style={[
									styles.cardSurface,
									{ backgroundColor: colors.card, borderLeftWidth: 4, borderLeftColor: colors.warning },
								]}
							>
								<View style={localStyles.unreadableRow}>
									<FontAwesome6 name="circle-exclamation" size={16} color={colors.warning} />
									<ThemedText type="default" style={localStyles.unreadableText}>
										{t(unreadKey!)}
									</ThemedText>
								</View>
							</View>
							{read?.payloadAccess === "not-a-recipient" ? (
								<ThemedText type="small" testID="registration-request-approval-late-officer" style={{ color: colors.textSecondary }}>
									{t("sealedBeforeOfficerExplanation")}
								</ThemedText>
							) : null}
							{/* D-07 + WR-02: the tampered state is still rejectable, and the engine refuses
							    any reject whose checklist does not meet the gate. Without the checklist here
							    a fresh tampered read has `checked = []` and Reject could never be enabled.
							    Only the tampered state gets it; the checklist carries no payload content, so
							    D-49's never-render posture is unaffected. */}
							{rejectableUnread ? checklistElement : null}
							</>
						) : (
						<>
						<View
							testID="registration-request-approval-summary"
							style={[styles.cardSurface, { backgroundColor: colors.card }]}
						>
							<ThemedText type="title" testID="registration-request-approval-summary-title">
								{t("registrationRequestApprovalSummaryTitle")}
							</ThemedText>
							{summaryRows.map((row) => (
								<View
									key={row.key}
									testID={`registration-request-approval-summary-row-${row.key}`}
									style={localStyles.summaryRow}
								>
									<ThemedText
										type="small"
										style={{ color: colors.textSecondary }}
										testID={`registration-request-approval-summary-label-${row.key}`}
									>
										{row.labelKey ? t(row.labelKey) : row.label}
									</ThemedText>
									{/* row.value has exactly ONE destination — this ThemedText
									    child. No console.*, no interpolation into any other
									    string, no error message. */}
									<ThemedText
										type="default"
										testID={`registration-request-approval-summary-value-${row.key}`}
									>
										{row.value}
									</ThemedText>
								</View>
							))}
						</View>

						{checklistElement}
						</>
						)}

						{mode === "approved" ? (
							<View testID="registration-request-approval-approved-block">
								<ThemedText type="default" testID="registration-request-approval-approved-by">
									{t("registrationRequestApprovalApprovedByLabel", {
										officer: read.decidingOfficerUserId ?? "",
										date: formatRequestTimestamp(read.decidedAt ?? ""),
									})}
								</ThemedText>
								{/* registrantId is resolved by the engine (48-05/48-08), never
								    guessed by the UI — its absence on an approved request means
								    the engine could not resolve it, and the CTA must not render a
								    broken navigation. */}
								{read.registrantId ? (
									<View testID="registration-request-approval-view-registrant">
										<CustomButton
											title={t("registrationRequestApprovalViewRegistrantButton")}
											backgroundColor={colors.accent}
											onPress={() =>
												navigation.navigate("RegistrantDetail", {
													registrantId: read.registrantId!,
													authorityId,
												})
											}
										/>
									</View>
								) : null}
							</View>
						) : null}

						{mode === "rejected" ? (
							<View testID="registration-request-approval-rejected-block">
								<View
									testID="registration-request-approval-rejected-pill"
									style={[pillStyles.pill, { backgroundColor: tintPill(colors[rejectedMeta.colorKey]) }]}
								>
									<ThemedText type="smallBold" style={{ color: colors[rejectedMeta.colorKey] }}>
										{t(rejectedMeta.labelKey)}
									</ThemedText>
								</View>
								<ThemedText type="default" testID="registration-request-approval-rejection-reason">
									{read.rejectionReason ?? ""}
								</ThemedText>
								<ThemedText type="small" testID="registration-request-approval-rejecting-officer">
									{read.decidingOfficerUserId ?? ""}
								</ThemedText>
								<ThemedText type="tiny" testID="registration-request-approval-decided-at">
									{formatRequestTimestamp(read.decidedAt ?? "")}
								</ThemedText>
							</View>
						) : null}
					</>
				) : null}
			</ScrollView>

			{/* Neither decided mode renders a footer of any kind. */}
			{mode === "pending" && !unreachable && !showRejectCard && !showStaleCloseCard ? (
				<View testID="registration-request-approval-footer">
					{/* Approve needs the officer's own task at every threshold; without one the engine can only refuse. */}
					{!loading && canDecide && !task && !voteRecorded ? (
						<View testID="registration-request-no-task-hint">
							<ThemedText type="small">{t("registrationRequestNoTask")}</ThemedText>
						</View>
					) : null}
					{/* Stacked (no `row`), not the two-across row every other footer
					    in the app uses: a row gave each label ~84dp, and "APPROVE
					    REGISTRATION" clipped to "APPROVE RE" rather than wrapping
					    (48-UAT.md gap 4). The real cause is CustomButton.tsx's
					    `buttonContent` being content-sized under an
					    `alignItems: "center"` TouchableOpacity, so its
					    `flexShrink: 1` on the label never has an overflow to resolve
					    against — an app-wide shared-component fix, filed as a todo
					    rather than made here (see
					    2026-08-07-custombutton-label-clips-instead-of-wrapping.md).
					    A full-width column slot leaves ~276dp, comfortably fitting
					    both EN and ES labels on one line without touching the shared
					    component. The buttons use the default tall size: the thin size
					    measured 95px = 36dp on Pixel_8 (UAT 62 gap 4 item 2), under the
					    44dp floor, which hitSlop does not lift in uiautomator bounds. */}
					<Footer>
						<View testID="registration-request-approval-approve" style={localStyles.footerSlot}>
							<CustomButton
								title={t("registrationRequestApprovalApproveButton")}
								icon="check"
								backgroundColor={colors.success}
								// WR-13: reads the STATE, not the ref — a ref mutation schedules no render, so
								// the ref-based form never produced a visual disable while the ceremony ran.
								disabled={!gateMet || !canDecide || blockers.approve.length > 0 || submitting}
								onPress={handleApprove}
							/>
						</View>
						<View testID="registration-request-approval-reject" style={localStyles.footerSlot}>
							<CustomButton
								title={t("registrationRequestApprovalRejectButton")}
								icon="xmark"
								backgroundColor={colors.error}
								disabled={!checklistGateMet || !canDecide || blockers.refuse.length > 0 || submitting}
								// Threshold 1 fires NO engine call whatsoever — only reveals the card. Above
								// threshold 1 it records a vote (D-11).
								onPress={() => (thresholdAboveOne ? handleThresholdRejectVote() : setShowRejectCard(true))}
							/>
						</View>
					</Footer>
				</View>
			) : null}

			{mode === "pending" && showRejectCard && read ? (
				// Under forced edge-to-edge (targetSdk 35) adjustResize is inert: the shell pads by the IME
				// height, and the IME already covers the gesture bar, so adding insets.bottom too would push
				// the card up by a phantom gap.
				<View
					testID="registration-request-approval-reject-card-host"
					style={{ paddingBottom: keyboardInset > 0 ? 0 : insets.bottom }}
				>
				<RejectReasonCard
					decisionGateMet={checklistGateMet && canDecide}
					errorMessage={errorMessage}
					requesterName={registrationRequestDisplayName({
						requestId,
						lastName: read.payload.public?.lastName,
						firstName: read.payload.public?.firstName,
						requesterKey: read.requesterKey,
					})}
					onConfirm={handleReject}
					onDismiss={() => setShowRejectCard(false)}
				/>
				</View>
			) : null}
			{mode === "pending" && showStaleCloseCard && read ? (
				<View
					testID="registration-request-approval-stale-close-card-host"
					style={{ paddingBottom: keyboardInset > 0 ? 0 : insets.bottom }}
				>
					<RejectReasonCard
						testIDPrefix="stale-close"
						titleKey="registrationRequestStaleCloseTitle"
						bodyKey="registrationRequestStaleCloseBody"
						confirmKey="registrationRequestStaleCloseConfirmButton"
						decisionGateMet={canDecide}
						errorMessage={errorMessage}
						requesterName={registrationRequestDisplayName({
							requestId,
							lastName: read.payload.public?.lastName,
							firstName: read.payload.public?.firstName,
							requesterKey: read.requesterKey,
						})}
						onConfirm={handleStaleClose}
						onDismiss={() => setShowStaleCloseCard(false)}
					/>
				</View>
			) : null}
		</KeyboardAvoidingScreen>
	);
}

const localStyles = StyleSheet.create({
	summaryRow: {
		marginBottom: 8,
	},
	// `alignSelf: "stretch"`, not `flex: 1` — inside a column Footer with no
	// defined height, `flex: 1` resolves to a zero flex-basis and collapses
	// the slot (48-26 gap 4 / D-07).
	footerSlot: {
		alignSelf: "stretch",
	},
	stateBlock: {
		marginBottom: 12,
		gap: 8,
	},
	unreadableRow: {
		flexDirection: "row",
		alignItems: "flex-start",
		gap: 8,
	},
	unreadableText: {
		flexShrink: 1,
	},
});

const styles = { ...globalStyles, ...localStyles };
