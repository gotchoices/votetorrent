import type { TransportSyncState } from "../../components/TransportStatusCard";

/**
 * bulk-import-sync-model.ts — the pure, RN-safe view-model for the Bulk Import / Sync screen
 * (D-01/D-11). Owns the binding injection seam (the registry below), the per-card state
 * resolution (`resolveTransportCardState`), and the error-row derivation (`toSyncErrorRefs`).
 * Plain TypeScript only — no React, no `react-native`, no `@votetorrent/*` import of any kind —
 * so every rule this file owns is unit-testable without a renderer.
 *
 * (b) THE BUNDLING RULE. `FilesystemRegistrationTransport` (48-09) imports `node:fs/promises` and
 * is therefore NOT RN-bundleable: it carries no `transport/index.ts` barrel and is unreachable
 * from the engine package's root barrel for exactly that reason. Neither this file nor the
 * screen may import ANY transport module — by barrel OR by deep path — because either route would
 * drag `node:fs` toward the Metro bundle and reproduce the failure class Phase 44's `@peculiar`
 * device-boot wall cost two plans to unstick, invisibly to jest (jest runs on Node, where the
 * import resolves fine; the failure only surfaces as a device boot crash). Instead, bindings
 * arrive through the registry below, attached by whichever host CAN construct them — exactly as
 * the app already reaches its engines through `useApp().getEngine()` instead of importing engine
 * classes directly.
 *
 * (c) THE D-11/D-23/D-28 RULE, updated 62-21/62-25. The peer-cluster leg ships **code-complete,
 * unverified**: P2P-11 is device-REFUTED, its wall has moved repeatedly, and this project has
 * already lived through "implemented but unproven" being read as "done" more than once. Through
 * 62-20 this file deliberately attached no peer binding. **62-21 is the plan that changes that**:
 * per D-28, the `'peer'` binding IS attached in every build (no `__DEV__` gate, no configuration —
 * see `attach-peer-sync-binding.ts`), and per D-31 its card (`PeerTransportStatusCard.tsx`, which
 * replaces the retired `Experimental`-prefixed peer card) reports real numeric pending/synced/failed counts
 * read from the P2P transport's own reports. The peer leg itself remains code-complete and
 * unverified on devices (D-23, proof debt against P2P-11) — attaching it unconditionally and
 * showing real counts does not change that; `PeerTransportStatusCard`'s hardcoded warning frame
 * and verbatim caveat are what keep that distinction visible to the officer.
 *
 * **62-25 closes D-28 the rest of the way**: association processing (first association AND D-46
 * re-association) is now driven ENTIRELY by the `'peer'` binding's `processPending` step — there is
 * no association REST or filesystem app binding of any kind. The `'rest'` binding registered by
 * `attach-sync-bindings.ts` is REGISTRATION-ONLY, and is attached in every build (D-29) the same
 * unconditional way the `'peer'` binding is — it is simply inert (refuses before any network call)
 * until an officer saves a bridge URL. `mergeTransportSyncReports`/`runAssociationSync` below stay
 * exported: `runAssociationSync` is still the ordering/pre-filter helper the `'peer'` binding's
 * association leg uses; `mergeTransportSyncReports` is retained for any future binding composition
 * but currently has no caller (the association REST composition it served is retired).
 *
 * (d) THE PII RULE. A sync error carries an **identifier** and nothing else. A failing item is a
 * registration payload containing real registrant PII, so `SyncErrorRef` and
 * `TransportSyncReport.errorItemIds` are structured so no payload value, requester name, or
 * transport error/response-body text can travel from a binding to this screen.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The set of transports this screen can drive from a real, attached binding. `'peer'` was
 * DELIBERATELY ABSENT through 48-20 — the same structural-severance discipline 48-17 used when it
 * left `'p2p'` out of `TransportKind` — so that registering a peer binding and driving the peer
 * card from it would be a type error here, not a style choice: the out-loud step this severance
 * existed to force.
 *
 * **48-23, 2026-08-06: `'peer'` is now admitted.** This member's addition IS that out-loud step.
 * The peer-cluster leg it routes to is **code-complete, unverified** (D-11) — admitting the id at
 * this seam does not change that. Through 62-20 the peer card showed no state at all
 * (the retired `Experimental`-prefixed peer card, `disabled?`/`onTrySync` only). **62-21** replaces that card
 * with `PeerTransportStatusCard` (D-31), which DOES render real numeric counts — but every count,
 * the caveat, the heading and the border are still structurally fixed by the card itself, never by
 * a prop a caller controls (see that component's own doc comment).
 */
export type SyncBindingId = "filesystem" | "rest" | "peer";

/**
 * What a binding's `syncNow()` resolves to. `errorItemIds` is an array of `string` and NOT a
 * record type — there is structurally no field through which a payload value, a requester name,
 * or an HTTP response body could travel from a transport to this screen. A host adapting 48-09's
 * `skipped` accumulator or 48-10's non-2xx error mapping takes the filename / item id and drops
 * everything else. Do NOT widen this to carry a `reason`, a `message`, or a `detail` — doing so
 * would reopen exactly the leak 48-10 closed at the binding.
 */
export interface TransportSyncReport {
	syncedAt: string;
	imported: number;
	pending: number;
	errorItemIds: readonly string[];
}

/**
 * 62-21 (D-32): an optional context a binding's `syncNow`/`readCounts` may need — currently just
 * `authorityId`, since the peer binding's transports and signer all scope to one authority. The
 * filesystem/REST bindings ignore it (their own `syncNow` closures already capture everything they
 * need at attach time).
 */
export interface SyncBindingContext {
	authorityId: string;
}

/**
 * 62-21 (D-31): numbers only — the SAME T-48-20-02 PII rule `TransportSyncReport.errorItemIds`
 * already follows. `pending`/`synced`/`failed` never carry a requester name, a payload value, or a
 * transport error string.
 */
export interface PeerSyncCounts {
	pending: number;
	synced: number;
	failed: number;
}

/**
 * A view-model shape, NOT `IRegistrationRequestTransport` itself. The screen must never hold a
 * transport instance, because holding one would require importing one (see the bundling rule
 * above). A host wraps its real binding — `FilesystemRegistrationTransport` reading staged
 * documents, or `RestRegistrationTransport` polling its endpoint — in this handle and registers
 * it via `registerSyncBinding`. The transport seam's own discipline is unchanged and unweakened:
 * a handle never receives, derives, or holds key material.
 *
 * 62-21 widens `syncNow` to take an OPTIONAL `SyncBindingContext` (additive — the filesystem/REST
 * bindings' existing zero-arg calls stay valid) and adds an OPTIONAL `readCounts`, which the peer
 * binding implements (D-31) to report numeric counts without signing or submitting anything.
 */
export interface SyncBindingHandle {
	id: SyncBindingId;
	syncNow: (context?: SyncBindingContext) => Promise<TransportSyncReport>;
	readCounts?: (context: SyncBindingContext) => Promise<PeerSyncCounts>;
}

/**
 * Exactly two members. THE TYPE IS THE PII GATE (T-48-20-02): there is no third member and no
 * optional member. Adding one is precisely how this screen would begin to leak a payload value or
 * a transport's error text into the rendered errors section — any future addition must justify
 * itself against T-48-20-02 in `48-20-PLAN.md`.
 */
export interface SyncErrorRef {
	transport: SyncBindingId;
	itemId: string;
}

/** The per-transport screen state `resolveTransportCardState` consumes. */
export interface TransportCardEntry {
	report?: TransportSyncReport;
	failed?: boolean;
}

// ---------------------------------------------------------------------------
// The registry — the injection seam a host attaches a real binding through.
// ---------------------------------------------------------------------------

const bindings = new Map<SyncBindingId, SyncBindingHandle>();

/**
 * Stores `handle` by `handle.id`. This is the attachment point for the real D-01/D-28/D-29
 * bindings — the REST binding (registration only, D-29) is RN-constructible (built-in `fetch`
 * only) and is attached at app boot in EVERY build, reading its target URL from the replicated
 * `AuthorityIntakePolicy` at every sync rather than from a configured constant; the filesystem
 * binding is attached by the Node-side host that owns the drop directory (the bulk-import bridge
 * process, or the on-device harness leg 48-22 drives), because `node:fs/promises` is not
 * Metro-resolvable and can never be attached from inside the RN app itself.
 *
 * This plan registers nothing here — it owns the seam and the screen, not the app's transport
 * configuration. A later host wiring plan is responsible for calling this function.
 */
export function registerSyncBinding(handle: SyncBindingHandle): void {
	bindings.set(handle.id, handle);
}

/** Resolves the handle registered for `id`, or `undefined` when nothing has attached yet. */
export function resolveSyncBinding(id: SyncBindingId): SyncBindingHandle | undefined {
	return bindings.get(id);
}

/**
 * Test hygiene only: clears every registered binding. Module-level mutable state that no test can
 * reset is its own defect class — one test's `registerSyncBinding` call must never leak into the
 * next test's assertions.
 */
export function clearSyncBindings(): void {
	bindings.clear();
}

// ---------------------------------------------------------------------------
// The inert peer action.
// ---------------------------------------------------------------------------

/**
 * Through 48-20, this was the peer card's ONLY handler — pressing it invoked this no-op and
 * nothing else, and the peer card's action was inert by construction.
 *
 * **48-23: the peer card's `onTrySync` now routes through `runSync('peer')` in the screen
 * instead of this export.** `INERT_PEER_SYNC` stays exported anyway — 48-20's own test suite
 * asserts it exists and returns `undefined` (Suite F), and this export is retained precisely so
 * that assertion keeps documenting the transition it was written to describe: the peer card WAS
 * structurally inert through 48-20, and is now wired through the seam. **62-21: `PeerTransportStatusCard`
 * is the live card this wiring now drives** — the peer-cluster leg itself remains **code-complete,
 * unverified** (D-23) either way; this export's retirement from the call site changes nothing about
 * that.
 */
export const INERT_PEER_SYNC = (): void => {};

// ---------------------------------------------------------------------------
// State resolution — the interdependent card props, resolved together.
// ---------------------------------------------------------------------------

export interface TransportCardState {
	syncState: TransportSyncState;
	lastSyncedAt?: string;
	importedCount?: number;
	pendingCount?: number;
	errorCount?: number;
}

/**
 * One pure function returning the interdependent props TOGETHER, mirroring the
 * `provisioningCopy` / `transportCopy` discipline (`AttestationProvisioningStatusScreen.tsx`,
 * `TransportStatusCard.tsx`), so a state can never be paired with the wrong counts. Three
 * explicit branches, no fallthrough:
 *
 * - no `report` and not `failed` -> `'never'`, every other member `undefined` — the card renders
 *   `bulkImportSyncNeverSyncedBody` and omits its counts line entirely.
 * - `failed` -> `'error'`, carrying the LAST successful report's values when one exists,
 *   otherwise `undefined`. A failed sync must not erase what the previous successful sync
 *   legitimately reported. As of 48-24, the card consumes that carried-forward `lastSyncedAt` as
 *   a separately-labelled "last successful sync" line that is omitted entirely when undefined —
 *   so carrying the previous report's timestamp forward through an error state is now honest
 *   instead of being the source of a dangling claim (48-UAT.md gap 1).
 * - a `report` with no failure -> `'success'`, with `lastSyncedAt`/`importedCount`/
 *   `pendingCount`/`errorCount` read straight off the report.
 */
export function resolveTransportCardState(entry: TransportCardEntry): TransportCardState {
	if (entry.failed) {
		const report = entry.report;
		return {
			syncState: "error",
			lastSyncedAt: report?.syncedAt,
			importedCount: report?.imported,
			pendingCount: report?.pending,
			errorCount: report ? report.errorItemIds.length : undefined,
		};
	}

	if (!entry.report) {
		return { syncState: "never" };
	}

	return {
		syncState: "success",
		lastSyncedAt: entry.report.syncedAt,
		importedCount: entry.report.imported,
		pendingCount: entry.report.pending,
		errorCount: entry.report.errorItemIds.length,
	};
}

// ---------------------------------------------------------------------------
// Error-row derivation.
// ---------------------------------------------------------------------------

/**
 * Returns `SyncErrorRef[]` in FIXED transport order (filesystem, then rest, then peer) and, within
 * a transport, in the order the binding reported. This mirrors the card order above it — an officer
 * reading top-to-bottom never has to reconcile two different orderings on one screen. Reads ONLY
 * `errorItemIds`; it must never read `imported`, `pending`, or `syncedAt`, and it accepts no
 * free-text argument of any kind.
 *
 * WR-15: the order array now covers all THREE `SyncBindingId` members. 48-23 widened
 * `SyncBindingId` to include `'peer'` and routed the peer card's press through `runSync('peer')`,
 * but left this array at `["filesystem", "rest"]` — so a peer binding's `errorItemIds` had nowhere
 * to go and were discarded AFTER the seam had already admitted the id. `TransportSyncReport` is
 * structurally a per-transport contract, which makes that a silent DROP rather than a display
 * choice: the officer saw a card and a press that reported nothing.
 *
 * What this widening does NOT do: it softens the D-11 posture nowhere. The peer card still carries
 * no state channel at all (its props type was exactly
 * `{disabled?, onTrySync}`) and still renders its unconditional warning treatment; this function
 * still reads ONLY `errorItemIds`, never `imported`/`pending`/`syncedAt`; and a caught transport
 * error's `message` is never placed into a report in the first place
 * (`BulkImportSyncScreen`'s `.catch()`), so no endpoint- or peer-supplied text can reach a rendered
 * row through this path (T-48-20-02). Only opaque item identifiers do, exactly as for the two
 * proven bindings.
 *
 * Keep this array EXHAUSTIVE over `SyncBindingId`. A fourth member added to the union without a
 * matching entry here reintroduces exactly this defect, and nothing in the type system catches it.
 */
export function toSyncErrorRefs(
	entries: Partial<Record<SyncBindingId, TransportSyncReport>>,
): SyncErrorRef[] {
	const order: SyncBindingId[] = ["filesystem", "rest", "peer"];
	const refs: SyncErrorRef[] = [];
	for (const transport of order) {
		const report = entries[transport];
		if (!report) continue;
		for (const itemId of report.errorItemIds) {
			refs.push({ transport, itemId });
		}
	}
	return refs;
}

// ---------------------------------------------------------------------------
// D-19 — the association processing trigger, composed onto the SAME "rest"
// binding registration already uses.
// ---------------------------------------------------------------------------

/**
 * D-19 SHAPE DECISION (51-10): `SyncBindingId` stays exactly
 * `"filesystem" | "rest" | "peer"` — NO fourth `"association"` member was
 * added. `BulkImportSyncScreen.tsx` is untouched by this plan and renders
 * exactly three cards, each with its own "Sync Now" press wired to
 * `runSync(id)`; a fourth `SyncBindingId` with no card ever calling
 * `runSync("association")` would register a binding NOTHING in the running
 * app ever invokes — the exact "correct code, unreachable by the app"
 * defect class this phase is scored against (`e64e112`, the Phase 48
 * registration stack the voter never referenced). D-19 also says ONE
 * trigger, and a fourth card would itself be a NEW pressable control, which
 * is what the rejected-alternatives note in `51-CONTEXT.md` calls out.
 *
 * Instead, `attach-association-sync-bindings.ts` COMPOSES onto the existing
 * `"rest"` id through this module's own registry seam
 * (`resolveSyncBinding`/`registerSyncBinding` — exactly the "attached by
 * whichever host CAN construct them" mechanism this file's header already
 * documents): it resolves whatever `"rest"` handle registration's
 * `attach-sync-bindings.ts` already registered, wraps it so `syncNow()`
 * calls the ORIGINAL handle first and then drives association processing,
 * merges the two `TransportSyncReport`s with `mergeTransportSyncReports`
 * below, and re-registers the combined handle under the SAME `"rest"` id.
 * The REST card's existing "Sync Now" press is therefore the one press that
 * now drives both legs. `TransportSyncReport` keeps its 4 fields unchanged
 * — merging counts and concatenating `errorItemIds` needs no new field.
 *
 * Composition ordering is load-bearing: `attach-sync-bindings.ts` must
 * attach FIRST (registering the real registration `"rest"` handle) before
 * `attach-association-sync-bindings.ts` attaches (capturing that handle as
 * its `previous`, then overwriting the registry entry with the combined
 * one). `AppProvider.tsx` sequences the two calls in that order.
 */
export function mergeTransportSyncReports(
	a: TransportSyncReport,
	b: TransportSyncReport,
): TransportSyncReport {
	return {
		syncedAt: b.syncedAt,
		imported: a.imported + b.imported,
		pending: a.pending + b.pending,
		errorItemIds: [...a.errorItemIds, ...b.errorItemIds],
	};
}

/**
 * WR-07 helper: resolve an optional "already imported" predicate to a plain boolean.
 * An absent predicate means "unknown", and so does one that throws — both fall through to
 * attempting the submit, which is the pre-WR-07 behaviour. Only an explicit `true` skips.
 */
async function skipsAsAlreadyImported<TDoc>(
	predicate: ((doc: TDoc) => Promise<boolean>) | undefined,
	doc: TDoc,
): Promise<boolean> {
	if (!predicate) return false;
	try {
		return await predicate(doc);
	} catch {
		return false;
	}
}

/**
 * The D-19 ordering/pre-filter discipline (T-51-10-09), extracted as a pure,
 * plain-TypeScript helper so it is directly unit-testable without a
 * renderer, an engine, or a network call — `attach-association-sync-bindings.ts`
 * supplies the real staged-document reads, the real engine submit calls, and
 * the real driver call; this function owns only the ORDER and the
 * unconditional-driver-call guarantee.
 *
 * ORDERING, AND WHAT IS AND IS NOT LOAD-BEARING: `submitRequest` and
 * `submitAttestation` STAGE and PRE-FILTER only; they mutate nothing in the
 * transport intake a caller's `processPending` reads from, so a real driver
 * (`processPendingAssociationRequests`, 51-09) independently RE-READS and
 * RE-VALIDATES every staged document through its own
 * `validateStagedAttestationAnswer` check (51-08). A pre-filter rejection
 * here therefore does not — and must not be read as — preventing the driver
 * from seeing the document. `processPending` is called EXACTLY ONCE,
 * UNCONDITIONALLY, after both loops — regardless of whether either loop
 * produced an error. Do NOT add a branch that skips `processPending` when
 * `errorItemIds` is non-empty: that is precisely how a security check
 * becomes correct code the running app never reaches.
 *
 * Both staged-read calls are independently fail-conservative: a rejected
 * `readStagedRequests`/`readStagedAttestations` is treated as an empty
 * batch (an honest, empty sync), never a thrown error that would abort the
 * unconditional `processPending` call below.
 *
 * WR-07 (51-REVIEW) — RE-OFFERED DOCUMENTS ARE NOT ERRORS. The staged reads
 * take no cursor and nothing ever deletes a staged document, so EVERY
 * document ever staged is re-offered on EVERY sync. Without the two optional
 * `alreadyImported*` predicates below, the second press of "Sync Now"
 * reported the first press's successful import as a sync ERROR — a duplicate
 * primary key on the request leg, a `Status !== 'c'` rejection on the
 * attestation leg — and kept doing so forever, for every previously-imported
 * document, drowning the genuine-error signal from the second press onward.
 *
 * A predicate returning `true` makes the document a silent no-op: neither
 * counted as an import nor recorded as an error, because neither is true of
 * a document a previous run already handled. Supplying them is OPTIONAL and
 * omitting them preserves the old behaviour exactly. A predicate that THROWS
 * is treated as "unknown" and the submit is attempted as before — a broken
 * predicate must never silently swallow a document.
 */
export async function runAssociationSync<TReq, TAtt>(params: {
	readStagedRequests: () => Promise<readonly TReq[]>;
	readStagedAttestations: () => Promise<readonly TAtt[]>;
	requestIdOf: (doc: TReq) => string;
	attestationIdOf: (doc: TAtt) => string;
	submitRequest: (doc: TReq) => Promise<unknown>;
	submitAttestation: (doc: TAtt) => Promise<unknown>;
	processPending: () => Promise<unknown>;
	/** WR-07: true when a previous sync already imported this request — skip, do not error. */
	alreadyImportedRequest?: (doc: TReq) => Promise<boolean>;
	/** WR-07: true when this attestation is not actionable now (already decided, or not yet
	 * challenged) — skip, do not error. The driver re-reads every staged document regardless. */
	alreadyImportedAttestation?: (doc: TAtt) => Promise<boolean>;
}): Promise<TransportSyncReport> {
	const errorItemIds: string[] = [];
	let imported = 0;

	let stagedRequests: readonly TReq[] = [];
	try {
		stagedRequests = await params.readStagedRequests();
	} catch {
		stagedRequests = [];
	}
	for (const doc of stagedRequests) {
		if (await skipsAsAlreadyImported(params.alreadyImportedRequest, doc)) continue;
		try {
			await params.submitRequest(doc);
			imported += 1;
		} catch {
			errorItemIds.push(params.requestIdOf(doc));
		}
	}

	let stagedAttestations: readonly TAtt[] = [];
	try {
		stagedAttestations = await params.readStagedAttestations();
	} catch {
		stagedAttestations = [];
	}
	for (const doc of stagedAttestations) {
		if (await skipsAsAlreadyImported(params.alreadyImportedAttestation, doc)) continue;
		try {
			await params.submitAttestation(doc);
			imported += 1;
		} catch {
			errorItemIds.push(params.attestationIdOf(doc));
		}
	}

	// UNCONDITIONAL — see the doc comment above. No branch above this line
	// may return early or otherwise skip this call.
	await params.processPending();

	return { syncedAt: new Date().toISOString(), imported, pending: 0, errorItemIds };
}
