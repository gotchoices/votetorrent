import React, { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useRoute, useTheme } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ThemedText } from "../../components/ThemedText";
import { ChipButton } from "../../components/ChipButton";
import { CustomButton } from "../../components/CustomButton";
import { InlineError } from "../../components/InlineError";
import { globalStyles } from "../../theme/styles";
import { useApp } from "../../providers/AppProvider";
import { createDeviceSigner } from "../../engines/device-signer";
import type { SignCallback } from "../../engines/device-signer";
import { useDeviceSigningErrorHandler } from "../../hooks/useDeviceSigningErrorHandler";
import { useCurrentOfficerScopes } from "../../hooks/useCurrentOfficerScopes";
import { reconcilePolicyState } from "./registration-policy-reconciliation";
import { RegistrationFieldsSection } from "./components/RegistrationFieldsSection";
import { DisclosurePolicySection, isDistrictAudienceAvailable } from "./components/DisclosurePolicySection";
import { AttestationPolicySection } from "./components/AttestationPolicySection";
import { ReassociationReviewNote } from "./components/ReassociationReviewNote";
import { ElectionEvent } from "@votetorrent/vote-core";
import { scopeLabel } from "../../utils/scopeLabel";
import type {
	IElectionEngine,
	IRegistrationEngine,
	ElectionRegistrationField,
	ElectionDisclosurePolicy,
	ElectionAttestationPolicy,
	DisclosureAudience,
	RegistrantTier,
	FieldRequirement,
} from "@votetorrent/vote-core";
import { errorCopy } from "../../utils/errorCopy";

/** Which control's home the D-13 confirmation card is intercepting on behalf of. */
type PolicySection = "fields" | "disclosure" | "attestation" | "issues";

/**
 * RegistrationPolicyScreen — the single RegistrationPolicy route (D-01). Owns every
 * IRegistrationEngine read, every 'mel'-signed write, the createDeviceSigner plumbing,
 * the D-10 scope-gate banner, the D-04/D-05 Policy Issues card (Task 2), the D-13
 * warn-don't-block confirmation (Task 2), and the D-03 Leg A N+1 ballot-districts read.
 * The three section components (46-05/46-06/46-07) are pure presentational — they make
 * no engine calls of their own.
 */
export default function RegistrationPolicyScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const insets = useSafeAreaInsets();
	const { getEngine } = useApp();
	const { electionEngine, electionId, authorityId } = useRoute().params as {
		electionEngine: IElectionEngine;
		electionId: string;
		authorityId: string;
	};

	const [fields, setFields] = useState<ElectionRegistrationField[]>([]);
	const [disclosures, setDisclosures] = useState<ElectionDisclosurePolicy[]>([]);
	const [attestationPolicy, setAttestationPolicy] = useState<ElectionAttestationPolicy | undefined>(undefined);
	const [hasDistrictedBallot, setHasDistrictedBallot] = useState(false);
	const [rosterNonEmpty, setRosterNonEmpty] = useState(false);
	const [registrationOpen, setRegistrationOpen] = useState(false);
	const [errorMessage, setErrorMessage] = useState("");
	const handleDeviceSigningError = useDeviceSigningErrorHandler();

	// Default-open, unlike ElectionDetailsScreen's "More" section (which defaults
	// closed): this is policy-review content an auditing read-only officer must see
	// immediately, matching D-10's transparency intent.
	const [fieldsOpen, setFieldsOpen] = useState(true);
	const [disclosureOpen, setDisclosureOpen] = useState(true);
	const [attestationOpen, setAttestationOpen] = useState(true);

	// Bumped only by Task 2's Keep-Current-Policy path to remount the three section
	// components below, resetting their internal row-status maps back to idle. Declared
	// here (unincremented) so Task 1's render already keys every section on it.
	const [sectionEpoch, setSectionEpoch] = useState(0);

	// D-04/D-05 Policy Issues card write state. There is deliberately no "saved" status:
	// a successful repair removes the flagged row from the NEXT reconciliation pass (via
	// loadPolicy() inside runSignedWrite), so the row disappears from this card entirely
	// instead of showing a transient checkmark.
	const [issueStatus, setIssueStatus] = useState<Record<string, "idle" | "saving" | "error">>({});
	const [issueRetry, setIssueRetry] = useState<Record<string, () => Promise<void>>>({});
	// Which audience-less field row currently has its inline Everyone/District choice
	// open. Pressing "Set Audience" reveals the choice; it never defaults a choice for
	// the officer.
	const [audienceRepairFor, setAudienceRepairFor] = useState<string | undefined>(undefined);

	// D-13 warn-don't-block inline confirmation. Acknowledging once (Proceed Anyway)
	// lets every subsequent edit this session bypass the card entirely.
	const [confirmAcknowledged, setConfirmAcknowledged] = useState(false);
	const [confirmForSection, setConfirmForSection] = useState<PolicySection | undefined>(undefined);
	const pendingWriteRef = useRef<
		{ run: () => Promise<void>; resolve: () => void; reject: (e: unknown) => void } | undefined
	>(undefined);

	const { scopes, loading: scopesLoading } = useCurrentOfficerScopes(authorityId);
	const canWrite = !scopesLoading && scopes?.includes("mel") === true;
	const reconciliation = reconcilePolicyState(fields, disclosures);
	const needsConfirmation = rosterNonEmpty || registrationOpen;

	// CR-02 guard against a stale setState: loadPolicy is invoked both from the mount
	// effect below AND from runSignedWrite after every write, so a single effect-scoped
	// `cancelled` closure would only cover the mount call. A ref shared across every
	// caller generalizes the same "never setState after unmount" guarantee.
	const unmountedRef = useRef(false);
	useEffect(() => {
		// WR-08: reset on entry so a cleanup that runs while the component stays
		// mounted (StrictMode double-invoke, Fast Refresh, remount-in-place) does
		// not permanently latch every setState in loadPolicy off.
		unmountedRef.current = false;
		return () => {
			unmountedRef.current = true;
		};
	}, []);

	const loadPolicy = useCallback(async () => {
		try {
			const registrationEngine = await getEngine<IRegistrationEngine>("registration");

			const fetchedFields = await registrationEngine.getElectionRegistrationFields(electionId);
			if (!unmountedRef.current) setFields(fetchedFields);

			const fetchedDisclosures = await registrationEngine.getElectionDisclosurePolicies(electionId);
			if (!unmountedRef.current) setDisclosures(fetchedDisclosures);

			// Store the raw result unchanged — never coalesce, never synthesize a row.
			// `undefined` is a real state AttestationPolicySection's resolveAttestationState
			// discriminates on FIRST (T-46-02); collapsing an absent policy to a false-y
			// default here would tell the officer attestation is off when the associate
			// ceremony will in fact require it.
			const fetchedAttestationPolicy = await registrationEngine.getElectionAttestationPolicy(electionId);
			if (!unmountedRef.current) setAttestationPolicy(fetchedAttestationPolicy);

			// D-03 Leg A — the N+1 read. BallotSummary carries NO districts field, so the
			// per-ballot detail read below is mandatory: reading districts off getBallots()
			// alone would silently pin this gate to false forever. Leg B (a declared
			// District field) is evaluated inside DisclosurePolicySection via
			// isDistrictAudienceAvailable — this screen supplies Leg A only and does not
			// restate Leg B here.
			const summaries = await electionEngine.getBallots();
			const ballotDetails = await Promise.all(summaries.map((b) => electionEngine.getBallotDetails(b.id)));
			if (!unmountedRef.current) {
				setHasDistrictedBallot(ballotDetails.some((d) => (d.ballot.districts?.length ?? 0) > 0));
			}

			// D-13 inputs. The roster length read below is STUBBED
			// (registration-engine.ts:865 returns an empty array), so this leg is dormant
			// until Phase 47 implements the real read — only the LENGTH may ever be
			// consumed here. No registrant name, field, count display, or roster list may
			// be rendered anywhere on this screen (D-08/D-09 — Phase 47 owns the roster
			// surface).
			const registrantsLength = (await registrationEngine.getElectionRegistrants(electionId)).length;
			if (!unmountedRef.current) setRosterNonEmpty(registrantsLength > 0);

			// ElectionEvent declares exactly ONE registration member, registrationEnds —
			// there is no registrationOpens/registrationCloses member on ElectionEvent
			// itself (those i18n key names are Timeline.tsx display labels mapped onto
			// this one member).
			const details = await electionEngine.getElectionDetails();
			if (!unmountedRef.current) {
				setRegistrationOpen(Date.now() < details.current.timeline[ElectionEvent.registrationEnds]);
			}
		} catch (err) {
			// Write failures must NOT set errorMessage here — they surface per-row inside
			// the three section components via their own runWrite state machines.
			if (!unmountedRef.current) setErrorMessage(errorCopy(err, t, "read"));
		}
	}, [getEngine, electionEngine, electionId]);

	useEffect(() => {
		loadPolicy();
		// Plain effect, NOT a focus-triggered re-fetch: nothing else in the app mutates
		// this policy during a session, and this screen re-reads via loadPolicy() at the
		// end of every write it fires itself.
	}, [loadPolicy]);

	/**
	 * D-13 warn-don't-block gate. The engine is deliberately permissive and the
	 * AdminSignature is the sole control (Phase 42 D-16), so this card carries the
	 * confirmation burden and is NOT a hard gate. When neither risky condition holds, or
	 * the officer has already Proceeded once this session, the write fires immediately
	 * with no card (D-14 unaffected). Otherwise the pending write is parked in
	 * pendingWriteRef and the returned promise stays pending until the officer decides —
	 * the originating row therefore honestly displays Saving while awaiting that
	 * decision, since the write really is in flight, pending confirmation.
	 */
	function guardedWrite(section: PolicySection, run: () => Promise<void>): Promise<void> {
		if (!needsConfirmation || confirmAcknowledged) {
			return run();
		}
		return new Promise<void>((resolve, reject) => {
			// Never leave a parked write unsettled (D-13/CR-04, gap 5). The card
			// renders inline -- not a modal, not an overlay -- and every section
			// stays mounted and interactive, so a second write control can be
			// pressed before the first is decided. A displaced write whose promise
			// is never settled leaves its originating row on registrationPolicyRowSaving
			// forever with no error and no Retry -- the officer is told a policy
			// change is in flight when it has actually been discarded. Rejecting it
			// here settles that row into Couldn't-save + Retry instead.
			//
			// This message is an internal control-flow marker only and must never
			// reach the screen: the section's runWrite catch discards the error
			// object entirely and renders the existing registrationPolicyRowError
			// i18n copy.
			const displaced = pendingWriteRef.current;
			if (displaced) {
				displaced.reject(new Error("superseded-by-newer-edit"));
			}
			pendingWriteRef.current = { run, resolve, reject };
			setConfirmForSection(section);
		});
	}

	// D-14: every edit fires its signed engine call immediately — there is no draft
	// state and no Save button anywhere in this screen. Acquire "Device User" — the
	// same literal bootstrap fallback AppProvider.tsx:75 and useCurrentOfficerScopes
	// use, so a first-run identity cannot diverge.
	//
	// 49-12: this is the ONLY point in the file with access to the real signing
	// error before the section components' own `runWrite` (RegistrationFieldsSection
	// et al.) discards it with a bare `catch {}` (by design — see that file's own
	// comment on the "superseded-by-newer-edit" internal marker). A
	// KEY_INVALIDATED_REASSOCIATE/NO_KEY_PROVISIONED/NO_DEVICE_CREDENTIAL rejection
	// therefore MUST be classified and, where applicable, navigated HERE — it would
	// otherwise be silently swallowed into a generic "Couldn't save" row with no
	// path back to recovery. `createDeviceSigner` itself is now inside the try (it
	// previously ran unguarded before the try/finally, which is exactly the gap:
	// its rejection used to skip this function's error handling entirely).
	//
	// This still ALWAYS re-throws (never swallows), preserving the pre-existing
	// contract every call site depends on: guardedWrite -> the section's runWrite,
	// which needs a rejection to know the write did NOT commit and render its Retry
	// affordance. Known limitation (documented, not silently accepted): the
	// section's per-row state machine has only "saved"/"error", no third
	// "silently reverted" state, so a cancelled biometric prompt still surfaces as
	// a retryable row error rather than D-13's ideal "no error screen" — the
	// navigation and inline-copy outcomes for the other five classes are unaffected
	// and correct.
	async function runSignedWrite(op: (sign: SignCallback) => Promise<void>): Promise<void> {
		try {
			const sign = await createDeviceSigner("Device User");
			await op(sign);
		} catch (err) {
			// Classify/navigate now, while the real error is still available.
			handleDeviceSigningError(err);
			throw err;
		} finally {
			// The reload runs in a finally so BOTH the success and the failure path
			// refresh the screen (gap 4's second missing bullet) — a half-applied
			// remove-then-add is visible in the fields list and the D-04/D-05 Policy
			// Issues card immediately, not just at the next successful write.
			await loadPolicy();
		}
	}

	async function onAddField(fieldName: string, tier: RegistrantTier, requirement: FieldRequirement) {
		// Plain add: RegistrationFieldsSection already dedupes against existing names, so
		// this row does not yet exist.
		await guardedWrite("fields", () =>
			runSignedWrite(async (sign) => {
				const registrationEngine = await getEngine<IRegistrationEngine>("registration");
				await registrationEngine.addElectionRegistrationField({ electionId, fieldName, tier, requirement }, sign);
			})
		);
	}

	// PRIMARY-KEY HAZARD (shared by onChangeField and onSetAudience below):
	// addElectionRegistrationField (registration-engine.ts:915-928) and
	// addElectionDisclosurePolicy (registration-engine.ts:1017-1024) both execute a
	// plain `insert into`, NOT `insert or replace`, against an (ElectionId, FieldName)
	// primary key. Changing an existing row therefore has to be remove-then-add — two
	// separate 'mel'-signed calls under the same acquired signer, since a single add on
	// an existing row is a PK violation on the real engine. MockRegistrationEngine
	// implements both add* methods as a Map.set upsert (mock-registration-engine.ts:196/
	// 210), so a mock-backed jest test passes either way — correctness lives here, and
	// only the 46-10 device run exercises the real engine's constraint.
	//
	// The remove and the add are NOT atomic. If the add fails after the remove has
	// already committed, the row is gone from the table until the officer retries — and
	// the very next loadPolicy() reconciliation pass is what surfaces that gap as a
	// flagged Policy Issues row (D-04/D-05). CONTEXT.md D-04 enumerates this as a state
	// that genuinely occurs in a live database, not a theoretical one.
	//
	// gap 4 (D-14 retry): the stored Retry handler re-invokes this SAME op closure. If
	// the remove already committed and only the add failed, a naive replay would call
	// remove again on an absent row — and the real engine's removeElectionRegistrationField
	// (registration-engine.ts:950-952) THROWS when the row is not found, making every
	// subsequent Retry throw the same way before it ever reaches the add. The fresh
	// existence re-read below exists SPECIFICALLY for retry idempotency — do not
	// "simplify" it back to an unconditional remove.
	async function onChangeField(fieldName: string, tier: RegistrantTier, requirement: FieldRequirement) {
		await guardedWrite("fields", () =>
			runSignedWrite(async (sign) => {
				const registrationEngine = await getEngine<IRegistrationEngine>("registration");
				const existingFields = await registrationEngine.getElectionRegistrationFields(electionId);
				const existingRow = existingFields.find((f) => f.fieldName.toLowerCase() === fieldName.toLowerCase());
				// Only skip the remove when the row is genuinely absent (the retry case).
				// A remove that IS attempted must still be allowed to throw and propagate —
				// this is not a blanket try/catch around the remove call.
				if (existingRow) {
					await registrationEngine.removeElectionRegistrationField(electionId, existingRow.fieldName, sign);
				}
				await registrationEngine.addElectionRegistrationField({ electionId, fieldName, tier, requirement }, sign);
			})
		);
	}

	async function onRemoveField(fieldName: string) {
		await guardedWrite("fields", () =>
			runSignedWrite(async (sign) => {
				const registrationEngine = await getEngine<IRegistrationEngine>("registration");
				await registrationEngine.removeElectionRegistrationField(electionId, fieldName, sign);
			})
		);
	}

	/**
	 * Resolves an ElectionDisclosurePolicy row's STORED fieldName casing — the
	 * PK argument a disclosure delete must be keyed on. Closes CR-01
	 * (46-VERIFICATION.md gap 1, a REGRESSION this phase's own 46-12
	 * introduced): 46-12 case-folded DisclosurePolicySection's Remove-control
	 * predicate (`findDisclosureForField`), so the control now renders for a
	 * case-skewed disclosure row — but the fieldName crossing that component
	 * boundary is the FIELD row's casing, not the disclosure row's STORED
	 * casing. The engine's disclosure read/delete
	 * (registration-engine.ts:1041-1046) does an exact-match PK read and
	 * THROWS on a miss, so a caller-supplied field-row casing is NOT a valid
	 * PK argument for it.
	 *
	 * Awaits a FRESH getElectionDisclosurePolicies read — never the captured
	 * `disclosures` React state (see onSetAudience's comment below for the
	 * retry-idempotency and stale-closure reasons that read has to be fresh) —
	 * finds the row case-insensitively, and returns its OWN fieldName. Returns
	 * undefined when no row exists, which every caller below treats as
	 * "already absent, nothing to delete" (retry idempotency).
	 */
	async function resolveStoredDisclosureName(
		registrationEngine: IRegistrationEngine,
		fieldName: string,
	): Promise<string | undefined> {
		const existingDisclosures = await registrationEngine.getElectionDisclosurePolicies(electionId);
		const existing = existingDisclosures.find((d) => d.fieldName.toLowerCase() === fieldName.toLowerCase());
		return existing?.fieldName;
	}

	async function onSetAudience(fieldName: string, audience: DisclosureAudience) {
		await guardedWrite("disclosure", () =>
			runSignedWrite(async (sign) => {
				const registrationEngine = await getEngine<IRegistrationEngine>("registration");
				// Resolves via a FRESH engine read INSIDE the op, not the captured
				// `disclosures` React state — two reasons survive this refactor
				// unchanged. (1) Retry idempotency, same as onChangeField above: after
				// a half-applied audience change (remove committed, add rejected), a
				// naive replay would call remove again on an absent row, and the real
				// engine's removeElectionDisclosurePolicy (registration-engine.ts:1044-1046)
				// throws when the row is not found. (2) A `disclosures` state snapshot
				// is a stale-closure hazard: it can reflect the policy as of an
				// EARLIER write, not the current engine state, if this op closure
				// outlives a prior write. resolveStoredDisclosureName (CR-01, 46-15)
				// is what performs that fresh read now, shared with the two other
				// disclosure write paths below.
				const storedName = await resolveStoredDisclosureName(registrationEngine, fieldName);
				// When a disclosure row for this field already exists, delete it FIRST using
				// its STORED casing — the PK argument the delete is keyed on — then always
				// add under the caller-supplied field-row casing. Only skip the remove when
				// the row is genuinely absent; a remove that IS attempted must still be
				// allowed to throw and propagate.
				if (storedName) {
					await registrationEngine.removeElectionDisclosurePolicy(electionId, storedName, sign);
				}
				await registrationEngine.addElectionDisclosurePolicy({ electionId, fieldName, audience }, sign);
			})
		);
	}

	async function onRemoveDisclosure(fieldName: string) {
		await guardedWrite("disclosure", () =>
			runSignedWrite(async (sign) => {
				const registrationEngine = await getEngine<IRegistrationEngine>("registration");
				// CR-01 (46-VERIFICATION.md gap 1, 46-15) — this was the one disclosure
				// write path that skipped stored-casing resolution. `fieldName` here is
				// the FIELD row's casing (DisclosurePolicySection.handleRemove passes
				// field.fieldName, correctly — see that component's comment for why the
				// section itself must not resolve this), NOT the disclosure row's
				// STORED casing the delete has to be keyed on. Resolve it first,
				// exactly like onSetAudience above.
				const storedName = await resolveStoredDisclosureName(registrationEngine, fieldName);
				// Only skip the remove when the row is genuinely absent — retry
				// idempotency, same shape as onSetAudience/onChangeField above. A
				// remove that IS attempted must still be allowed to throw and
				// propagate; this is not a blanket try/catch.
				if (!storedName) return;
				await registrationEngine.removeElectionDisclosurePolicy(electionId, storedName, sign);
			})
		);
	}

	async function onSetAttestation(required: boolean) {
		await guardedWrite("attestation", () =>
			runSignedWrite(async (sign) => {
				const registrationEngine = await getEngine<IRegistrationEngine>("registration");
				// insert or replace (registration-engine.ts:1108) — no remove-then-add needed.
				await registrationEngine.setElectionAttestationPolicy(electionId, required, sign);
			})
		);
	}

	async function onRevertToDefault() {
		await guardedWrite("attestation", () =>
			runSignedWrite(async (sign) => {
				const registrationEngine = await getEngine<IRegistrationEngine>("registration");
				await registrationEngine.removeElectionAttestationPolicy(electionId, sign);
			})
		);
	}

	/**
	 * D-04/D-05 Policy Issues repair write. Distinct from the section-row runWrite
	 * helpers (46-05/46-06/46-07) because this card lives on the screen itself, keyed by
	 * fieldName so the orphan-disclosure repair and the audience-less repair share one
	 * status map. There is no "saved" branch — see the state declaration comment above.
	 */
	async function runIssueWrite(fieldName: string, op: () => Promise<void>) {
		// CR-02 (46-VERIFICATION.md gap 2 / 46-REVIEW.md, closed by 46-16): the
		// Issues card's repair chips, unlike the section rows, stay rendered and
		// live during a write — only a "Saving…" label is added alongside — so
		// the handler is the only place a double press can be stopped. Without
		// this guard, a double press fires `op` twice; against the real
		// engine's plain `insert into`/exact-match-delete PK behaviour the
		// second call is either a violation or a throw-on-missing-row, and the
		// officer is told a repair failed that actually succeeded.
		// handleRetryIssue is unaffected: a failed repair leaves the status at
		// "error", not "saving".
		//
		// The success branch below is REQUIRED BY the guard above, not optional
		// polish (WR-03, escalated by 46-UAT.md test 12 and fixed here). Without
		// it a successful repair leaves this field pinned at "saving" forever, so
		// the guard's own early return then swallows every LATER repair press for
		// that field — no card, no write, no error — until the officer leaves and
		// re-enters the screen. WR-03 was assessed in 46-REVIEW.md as a cosmetic
		// stale "Saving…" label; that assessment predates this guard, which turned
		// it into a functional dead-end. Reproduced on device: repair an audience
		// (succeeds, flag clears) -> remove the disclosure (field re-flagged) ->
		// press the repair again -> nothing happens.
		//
		// Clears only THIS field: other fields may legitimately be in flight.
		// (handleKeepCurrentPolicy resets the whole map instead — correct there,
		// since abandoning the confirmation abandons every parked repair.)
		if (issueStatus[fieldName] === "saving") return;
		setIssueStatus((prev) => ({ ...prev, [fieldName]: "saving" }));
		try {
			await op();
			setIssueStatus((prev) => {
				const next = { ...prev };
				delete next[fieldName];
				return next;
			});
			setIssueRetry((prev) => {
				const next = { ...prev };
				delete next[fieldName];
				return next;
			});
		} catch {
			setIssueStatus((prev) => ({ ...prev, [fieldName]: "error" }));
			setIssueRetry((prev) => ({ ...prev, [fieldName]: () => runIssueWrite(fieldName, op) }));
		}
	}

	function handleRetryIssue(fieldName: string) {
		const retry = issueRetry[fieldName];
		if (retry) retry();
	}

	function handleRepairRemoveDisclosure(fieldName: string) {
		// fieldName here is always issue.fieldName — the disclosure row's STORED
		// original casing (registration-policy-reconciliation.ts's CASE-FOLDING
		// RULE guarantees this: the emitted fieldName is never lower-cased).
		// Routed through resolveStoredDisclosureName anyway (46-15): the safety
		// no longer rests on that non-local guarantee holding — the resolver
		// makes the invariant structural instead of commentary, which is
		// exactly the kind of reasoning that drifted and produced CR-01 in
		// onRemoveDisclosure above.
		runIssueWrite(fieldName, () =>
			guardedWrite("issues", () =>
				runSignedWrite(async (sign) => {
					const registrationEngine = await getEngine<IRegistrationEngine>("registration");
					const storedName = await resolveStoredDisclosureName(registrationEngine, fieldName);
					if (!storedName) return;
					await registrationEngine.removeElectionDisclosurePolicy(electionId, storedName, sign);
				})
			)
		);
	}

	function handleRepairSetAudience(fieldName: string, audience: DisclosureAudience) {
		runIssueWrite(fieldName, () =>
			guardedWrite("issues", () =>
				runSignedWrite(async (sign) => {
					const registrationEngine = await getEngine<IRegistrationEngine>("registration");
					await registrationEngine.addElectionDisclosurePolicy({ electionId, fieldName, audience }, sign);
				})
			)
		);
		setAudienceRepairFor(undefined);
	}

	function handleProceedAnyway() {
		setConfirmAcknowledged(true);
		setConfirmForSection(undefined);
		const record = pendingWriteRef.current;
		pendingWriteRef.current = undefined;
		if (record) {
			record.run().then(record.resolve, record.reject);
		}
	}

	function handleKeepCurrentPolicy() {
		setConfirmForSection(undefined);
		// Clear WITHOUT calling run — deliberately leave the pending promise unsettled.
		// Settling it would force either a false Saved (resolve) or a false Couldn't-save
		// (reject), and nothing failed — the officer chose not to apply the edit.
		pendingWriteRef.current = undefined;
		// Bumping sectionEpoch remounts the three section components (keyed on it since
		// Task 1), resetting their internal row-status maps to idle, so an abandoned
		// field/disclosure/attestation row returns to displaying the unchanged current
		// policy. The unsettled promise's consumer is unmounted, so no state update on an
		// unmounted component occurs. confirmAcknowledged is NOT set here — the card must
		// reappear on the next attempt, since this one was never acknowledged.
		setSectionEpoch((e) => e + 1);
		// The Policy Issues card is NOT one of the three sectionEpoch-remounted
		// components (it lives directly on this screen), so an abandoned repair row
		// needs its own reset here alongside the remount above, or it would be stuck
		// showing Saving forever with no path back to idle.
		setIssueStatus({});
		setIssueRetry({});
		setAudienceRepairFor(undefined);
	}

	function renderConfirmCard() {
		const bodyLines = [
			rosterNonEmpty ? t("registrationPolicyConfirmRosterBody") : undefined,
			registrationOpen ? t("registrationPolicyConfirmWindowOpenBody") : undefined,
		].filter((line): line is string => line !== undefined);

		return (
			<View
				testID="registration-policy-confirm-card"
				style={[styles.cardSurface, { backgroundColor: colors.card, borderLeftWidth: 4, borderLeftColor: colors.warning }]}
			>
				<ThemedText type="defaultSemiBold">{t("registrationPolicyConfirmTitle")}</ThemedText>
				<ThemedText type="default">{bodyLines.join("\n")}</ThemedText>
				<View style={localStyles.confirmButtonRow}>
					<View testID="registration-policy-confirm-keep">
						<CustomButton
							size="thin"
							title={t("registrationPolicyConfirmCancelButton")}
							backgroundColor={colors.accent}
							onPress={handleKeepCurrentPolicy}
						/>
					</View>
					<View testID="registration-policy-confirm-proceed">
						<CustomButton
							size="thin"
							title={t("registrationPolicyConfirmProceedButton")}
							backgroundColor={colors.warning}
							forceDarkText
							onPress={handleProceedAnyway}
						/>
					</View>
				</View>
			</View>
		);
	}

	return (
		<ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
			<View style={styles.section}>
				<InlineError message={errorMessage} />
			</View>

			{/* D-10 scope-gate banner — persistent, non-collapsible, rendered only once the
			    hook has resolved (never flashes the not-an-officer copy during load). The
			    two branches are DELIBERATELY not collapsed: `scopes === undefined` (no
			    matching Officer row) and a real scopes array missing 'mel' are two distinct
			    facts and bind to two distinct copies. This gate is a UI affordance for
			    legibility, NOT a security boundary — the DB-side 'mel' AdminSignature CHECK
			    is the real control (T-46-03, D-10). */}
			{!scopesLoading && !canWrite && (
				scopes === undefined ? (
					<View testID="registration-policy-readonly-no-officer-banner" style={localStyles.banner}>
						<FontAwesome6 name="lock" size={14} color={colors.textSecondary} />
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrationPolicyReadOnlyNoOfficerBanner")}
						</ThemedText>
					</View>
				) : (
					<View testID="registration-policy-readonly-banner" style={localStyles.banner}>
						<FontAwesome6 name="lock" size={14} color={colors.textSecondary} />
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrationPolicyReadOnlyBanner", { scope: scopeLabel("mel", t) })}
						</ThemedText>
					</View>
				)
			)}

			{confirmForSection === "issues" && renderConfirmCard()}

			{/* D-04 detection / D-05 repair. There is NO FK and NO cross-table CHECK
			    between ElectionDisclosurePolicy.FieldName and ElectionRegistrationField,
			    and none is added this phase — both tables validate only ElectionId
			    existence, enum membership and the 'mel' signature digest. These states
			    genuinely occur in a live database: a partial failure of two non-atomic
			    signed writes (including this screen's own remove-then-add above), a
			    non-cascading remove, a tier flip, or another writer (the voter app, a
			    second officer device, direct engine use, P2P replication). */}
			{reconciliation.hasIssues && (
				<View
					testID="registration-policy-issues-card"
					style={[styles.cardSurface, { backgroundColor: colors.card, borderLeftWidth: 4, borderLeftColor: colors.warning }]}
				>
					<View style={localStyles.issuesHeadingRow}>
						<FontAwesome6 name="triangle-exclamation" size={16} color={colors.warning} />
						<ThemedText type="defaultSemiBold">{t("registrationPolicyIssuesSectionTitle")}</ThemedText>
					</View>

					{reconciliation.orphanDisclosures.map((issue) => {
						const status = issueStatus[issue.fieldName] ?? "idle";
						return (
							<View
								key={"orphan-" + issue.fieldName}
								testID={"registration-policy-issue-orphan-" + issue.fieldName}
								style={localStyles.issueRow}
							>
								<View style={localStyles.issueRowHeader}>
									<ThemedText type="smallBold">
										{t("registrationPolicyOrphanDisclosureFlag")} {issue.fieldName}
									</ThemedText>
									<View
										testID={"registration-policy-issue-repair-remove-" + issue.fieldName}
										pointerEvents={canWrite ? "auto" : "none"}
										style={canWrite ? undefined : localStyles.disabledControl}
									>
										<ChipButton
											label={t("registrationPolicyRemoveButton")}
											onPress={canWrite ? () => handleRepairRemoveDisclosure(issue.fieldName) : undefined}
										/>
									</View>
								</View>
								<ThemedText type="small">{t("registrationPolicyOrphanDisclosureBody")}</ThemedText>
								<View testID={"registration-policy-issue-status-" + issue.fieldName}>
									{status === "saving" && (
										<ThemedText type="small" style={{ color: colors.textSecondary }}>
											{t("registrationPolicyRowSaving")}
										</ThemedText>
									)}
									{status === "error" && (
										<>
											<ThemedText type="small" style={{ color: colors.error }}>
												{t("registrationPolicyRowError")}
											</ThemedText>
											<View testID={"registration-policy-issue-retry-" + issue.fieldName}>
												<ChipButton
													label={t("registrationPolicyRetryButton")}
													onPress={() => handleRetryIssue(issue.fieldName)}
												/>
											</View>
										</>
									)}
								</View>
							</View>
						);
					})}

					{reconciliation.audienceLessSelectiveFields.map((issue) => {
						const status = issueStatus[issue.fieldName] ?? "idle";
						const showAudienceChoices = audienceRepairFor === issue.fieldName;
						const districtAvailable = isDistrictAudienceAvailable(fields, hasDistrictedBallot);
						return (
							<View
								key={"no-audience-" + issue.fieldName}
								testID={"registration-policy-issue-no-audience-" + issue.fieldName}
								style={localStyles.issueRow}
							>
								<View style={localStyles.issueRowHeader}>
									<ThemedText type="smallBold">
										{t("registrationPolicyMissingAudienceFlag")} {issue.fieldName}
									</ThemedText>
									<View
										testID={"registration-policy-issue-repair-set-audience-" + issue.fieldName}
										pointerEvents={canWrite ? "auto" : "none"}
										style={canWrite ? undefined : localStyles.disabledControl}
									>
										<ChipButton
											label={t("registrationPolicySetAudienceButton")}
											onPress={canWrite ? () => setAudienceRepairFor(issue.fieldName) : undefined}
										/>
									</View>
								</View>
								<ThemedText type="small">{t("registrationPolicyMissingAudienceBody")}</ThemedText>

								{showAudienceChoices && (
									<View style={localStyles.issueAudienceChoices}>
										<View testID={"registration-policy-issue-audience-" + issue.fieldName + "-everyone"}>
											<ChipButton
												label={t("registrationPolicyAudienceEveryone")}
												onPress={() => handleRepairSetAudience(issue.fieldName, "everyone")}
											/>
										</View>
										{districtAvailable && (
											<View testID={"registration-policy-issue-audience-" + issue.fieldName + "-district"}>
												<ChipButton
													label={t("registrationPolicyAudienceDistrict")}
													onPress={() => handleRepairSetAudience(issue.fieldName, "district")}
												/>
											</View>
										)}
									</View>
								)}

								<View testID={"registration-policy-issue-status-" + issue.fieldName}>
									{status === "saving" && (
										<ThemedText type="small" style={{ color: colors.textSecondary }}>
											{t("registrationPolicyRowSaving")}
										</ThemedText>
									)}
									{status === "error" && (
										<>
											<ThemedText type="small" style={{ color: colors.error }}>
												{t("registrationPolicyRowError")}
											</ThemedText>
											<View testID={"registration-policy-issue-retry-" + issue.fieldName}>
												<ChipButton
													label={t("registrationPolicyRetryButton")}
													onPress={() => handleRetryIssue(issue.fieldName)}
												/>
											</View>
										</>
									)}
								</View>
							</View>
						);
					})}
				</View>
			)}

			{confirmForSection === "fields" && renderConfirmCard()}
			<View style={styles.section} testID="registration-policy-fields-section">
				<View testID="registration-policy-fields-toggle">
					<ChipButton
						label={t("registrationPolicyFieldsSectionTitle")}
						icon={fieldsOpen ? "chevron-down" : "chevron-right"}
						onPress={() => setFieldsOpen((v) => !v)}
					/>
				</View>
				{fieldsOpen && (
					<RegistrationFieldsSection
						key={"fields-" + sectionEpoch}
						fields={fields}
						canWrite={canWrite}
						onAddField={onAddField}
						onChangeField={onChangeField}
						onRemoveField={onRemoveField}
					/>
				)}
			</View>

			{/* DisclosurePolicySection and AttestationPolicySection each render their own
			    internal ThemedText type="title" header (their 46-06/46-07 contracts) — this
			    screen adds ONLY the ChipButton toggle above them and does not add a second
			    title. The resulting word-level redundancy between the toggle chip and those
			    inner titles is accepted this phase, since 46-06/46-07 are finished
			    contracts outside this plan's edit surface. */}
			{confirmForSection === "disclosure" && renderConfirmCard()}
			<View style={styles.section} testID="registration-policy-disclosure-section">
				<View testID="registration-policy-disclosure-toggle">
					<ChipButton
						label={t("registrationPolicyDisclosureSectionTitle")}
						icon={disclosureOpen ? "chevron-down" : "chevron-right"}
						onPress={() => setDisclosureOpen((v) => !v)}
					/>
				</View>
				{disclosureOpen && (
					<DisclosurePolicySection
						key={"disclosure-" + sectionEpoch}
						fields={fields}
						disclosures={disclosures}
						hasDistrictedBallot={hasDistrictedBallot}
						canWrite={canWrite}
						onSetAudience={onSetAudience}
						onRemoveDisclosure={onRemoveDisclosure}
					/>
				)}
			</View>

			{confirmForSection === "attestation" && renderConfirmCard()}
			<View style={styles.section} testID="registration-policy-attestation-section">
				<View testID="registration-policy-attestation-toggle">
					<ChipButton
						label={t("registrationPolicyAttestationSectionTitle")}
						icon={attestationOpen ? "chevron-down" : "chevron-right"}
						onPress={() => setAttestationOpen((v) => !v)}
					/>
				</View>
				{attestationOpen && (
					<AttestationPolicySection
						key={"attestation-" + sectionEpoch}
						policy={attestationPolicy}
						canWrite={canWrite}
						onSetAttestation={onSetAttestation}
						onRevertToDefault={onRevertToDefault}
					/>
				)}
			</View>

			{/* D-46: the device-change review mode is per-authority, so it is edited on the authority's
			    Registration Requests screen (user ruling 2026-10-07); this election screen only shows
			    the current value read-only. */}
			<View style={styles.section} testID="registration-policy-reassociation-section">
				<ReassociationReviewNote authorityId={authorityId} />
			</View>
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	banner: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		marginBottom: 12,
	},
	issuesHeadingRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		marginBottom: 8,
	},
	issueRow: {
		gap: 4,
		marginTop: 8,
	},
	issueRowHeader: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 8,
	},
	issueAudienceChoices: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		flexWrap: "wrap",
		marginTop: 4,
	},
	disabledControl: {
		opacity: 0.5,
	},
	confirmButtonRow: {
		flexDirection: "row",
		gap: 8,
		marginTop: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };
