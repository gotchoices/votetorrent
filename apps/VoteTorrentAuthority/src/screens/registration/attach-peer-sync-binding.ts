import type {
	Signature,
	ReassociationIntake,
	ReassociationOpener,
	ReassociationProcessingSummary,
	RegistrationDecisionPublication,
	RegistrationDecisionPublishPort,
	RegistrationDecisionPublishResult,
	RegistrationDuplicateClosureRepairReport,
} from '@votetorrent/vote-core';
import type {
	IKeyVault,
	P2pAssociationTransport,
	P2pRegistrationTransport,
	P2pStagedAssociationRequest,
	P2pStagedAttestation,
	P2pStagedRequest,
	StagingDecisionSigner,
	StagingOpener,
	StagingReadReport,
	StagingUnreadableRow,
} from '@votetorrent/vote-engine/rn';
import {
	registerSyncBinding,
	runAssociationSync,
	type PeerSyncCounts,
	type SyncBindingContext,
	type SyncBindingHandle,
	type TransportSyncReport,
} from './bulk-import-sync-model';
import { resolveAuthorityKeyVault } from '../../engines/key-vault';
import type { PeerStagingTransports } from '../../engines/engine-factory';

/**
 * attach-peer-sync-binding.ts — Phase 62 Plan 21 (D-28/D-31/D-32), extended by Phase 62 Plan 25
 * (D-28/D-44/D-46 — the 62-19/62-18/62-01 orchestrator assignments).
 *
 * The 'peer' `SyncBindingHandle`: `syncNow` intakes this authority's staged registration and
 * association requests from the strand, publishes officer-signed registration decisions for
 * locally-decided peer requests through 62-19's closure-aware drain, drives first-association
 * processing AND 62-18's automatic re-association pass with the P2P transport AS the intake, both
 * legs. `readCounts` derives pending/synced/failed from the transport's own reports, signing
 * nothing.
 *
 * D-28: `attachPeerSyncBinding` is called UNCONDITIONALLY from `AppProvider.tsx` — no dev-only
 * build gate, no configuration. P2P is the default intake path. As of 62-25, association has NO
 * REST or filesystem app binding at all (the dev-only association REST harness is deleted) — this
 * file's `processPending` step is the ONLY place association requests, first or re-association,
 * are ever processed by the Authority app.
 *
 * D-32: the transports come from the factory's `createPeerStagingTransports`, bound to
 * `strandId = currentNetworkHash`; this file never opens a strand itself.
 *
 * D-23: the peer leg is code-complete and unverified on devices (proof debt against P2P-11).
 *
 * D-44 (62-19 assignment): every registration decision this file publishes goes through
 * `RegistrationEngine.listUnpublishedRegistrationDecisions` -> `publishRegistrationDecision`
 * (automatic closure) plus one `completeDuplicateClosures` resume per sync — never the
 * registration transport's `publishDecision` directly. `createRegistrationDecisionPublisher` is
 * the ONE wrapper shape through which a decision may reach the strand (see that function's own
 * doc comment). The drain covers every decided request of this authority, including a request
 * intaken over the REST bridge (62-25's `attach-sync-bindings.ts`) — a decision row carries no
 * staging-row dependency (62-01), and the strand is the authoritative decision record regardless
 * of which transport intook the original request.
 *
 * D-46 (62-18 assignment): after `processPendingAssociationRequests`, this file ALWAYS also calls
 * `AssociationEngine.processPendingReassociations`, so an authority's configured automatic
 * re-association mode actually takes effect. Without this call every re-association would wait
 * for manual officer review regardless of the authority's saved `reassociationMode` — a fail-safe
 * default, but not what D-46 configures when an authority opts into automatic mode.
 *
 * Count semantics (D-31, planner discretion): `pending`/`synced` are derived from the transport's
 * own delivered reports against this authority's local read model — pending = delivered and not
 * yet locally present, synced = delivered and locally present. `failed` = the set of unreadable
 * row ids (excluding `'not-a-recipient'` — those rows are sealed to OTHER officers/authorities
 * sharing the strand, never a failure of this device) unioned with the ids this device's last run
 * itself failed to submit/publish.
 *
 * This file imports no filesystem or REST transport module, and contains no dev-only build gate. `createSigner`
 * is a REQUIRED injected dependency — this file never imports the injected signer factory module
 * directly, so it is not a new rollout invoker (see `officer-intake-key.ts`'s identical discipline).
 */

export interface PeerSyncBindingDeps {
	getEngine: <T>(engineName: string) => Promise<T>;
	createTransports: (deps: { opener: StagingOpener; decisionSigner: StagingDecisionSigner }) => PeerStagingTransports;
	resolveVault?: () => IKeyVault;
	createSigner: () => Promise<(digest: Uint8Array) => Promise<Signature>>;
}

/** The minimal local structural type this file needs from `IntakeEngine`. */
interface PeerIntakeEngine {
	createOpener(vault: IKeyVault): StagingOpener;
}

/** The minimal local structural type this file needs from `RegistrationEngine`. Widened by 62-25
 * (D-44, the 62-19 assignment) with the closure-aware decision-publish drain. */
interface PeerRegistrationEngine {
	getRegistrationRequest(
		requestId: string,
	): Promise<{ status: string; decidedAt?: string; rejectionReason?: string } | undefined>;
	submitRegistrationRequest(init: unknown, requesterKey: string, signatureOrCallback: Signature): Promise<string>;
	listUnpublishedRegistrationDecisions(authorityId: string): Promise<string[]>;
	publishRegistrationDecision(
		publisher: RegistrationDecisionPublishPort,
		requestId: string,
	): Promise<RegistrationDecisionPublishResult>;
	completeDuplicateClosures(publisher: RegistrationDecisionPublishPort): Promise<RegistrationDuplicateClosureRepairReport>;
}

/** The minimal local structural type this file needs from `AssociationEngine`. Widened by 62-25
 * (D-46, the 62-18 assignment) with the automatic re-association driver. */
interface PeerAssociationEngine {
	getAssociationRequest(requestId: string): Promise<{ status: string } | undefined>;
	submitAssociationRequest(init: unknown, requesterKey: string, signatureOrCallback: Signature): Promise<string>;
	submitAssociationAttestation(answer: unknown, requesterKey: string, signatureOrCallback: Signature): Promise<void>;
	processPendingAssociationRequests(
		authorityId: string,
		signatureOrCallback: Signature | ((digest: Uint8Array) => Promise<Signature>),
		intake: P2pAssociationTransport,
	): Promise<{ challengesIssued: number; associated: number; rejected: number }>;
	processPendingReassociations(
		authorityId: string,
		signatureOrCallback: Signature | ((digest: Uint8Array) => Promise<Signature>),
		intake: ReassociationIntake,
		opener: ReassociationOpener,
	): Promise<ReassociationProcessingSummary>;
}

/**
 * The ONLY shape through which a registration decision may reach the strand (D-44, 62-19
 * coordination) — the transport's own decision-publish method is called exactly once in this
 * file's comment-stripped source, right here. Wraps the registration transport so
 * `RegistrationEngine`'s closure-aware drain (`listUnpublishedRegistrationDecisions` /
 * `publishRegistrationDecision` / `completeDuplicateClosures`) can write through it. The publisher
 * writes into the SAME strand `Database` the engine reads, because both come from the SAME
 * `createPeerStagingTransports` call over the established ctx (D-32) —
 * `RegistrationEngine.publishRegistrationDecision` probes the write back through its own `ctx.db`
 * and refuses `'publisher-db-mismatch'` if they ever diverge.
 */
export function createRegistrationDecisionPublisher(
	transport: { publishDecision: (decision: RegistrationDecisionPublication) => Promise<string> },
	authorityId: string,
): RegistrationDecisionPublishPort {
	return {
		authorityId,
		publishDecision: (decision) => transport.publishDecision(decision),
	};
}

/** Structural check (not `instanceof`) — `P2pStagingError` crosses from vote-engine's barrel. */
function isP2pStagingError(err: unknown, code?: string): boolean {
	if (typeof err !== 'object' || err === null) return false;
	const e = err as { name?: unknown; code?: unknown };
	if (e.name !== 'P2pStagingError') return false;
	return code === undefined ? typeof e.code === 'string' : e.code === code;
}

/** Memoizes the first `createSigner()` call; `sign` itself is invoked lazily, on its own first call. */
function lazySigner(
	createSigner: () => Promise<(digest: Uint8Array) => Promise<Signature>>,
): (digest: Uint8Array) => Promise<Signature> {
	let resolved: Promise<(digest: Uint8Array) => Promise<Signature>> | undefined;
	return async (digest: Uint8Array): Promise<Signature> => {
		if (resolved === undefined) {
			resolved = createSigner();
		}
		const signer = await resolved;
		return signer(digest);
	};
}

/** Drops `'not-a-recipient'` rows — sealed to other officers/authorities sharing the strand, not a
 * failure of this device (see the module header). */
function countableUnreadableIds<T>(report: StagingReadReport<T>): string[] {
	return report.unreadable
		.filter((row: StagingUnreadableRow) => row.reason !== 'not-a-recipient')
		.map((row) => row.requestId);
}

/** Closes each transport in its own try/catch: a transport's close() re-awaits its strand
 * promise, so a failed strand open rejects again here — that must neither skip the other close
 * nor replace the sync's own outcome (initial/G3 WR-04). Logs the error class name only. */
async function closeTransports(...transports: Array<{ close?: () => unknown }>): Promise<void> {
	for (const transport of transports) {
		try {
			await transport.close?.();
		} catch (err) {
			const name = err instanceof Error ? err.name : 'unknown';
			console.warn(`attach-peer-sync-binding: transport close failed (${name})`);
		}
	}
}

export function createPeerSyncBinding(deps: PeerSyncBindingDeps): SyncBindingHandle {
	let lastRunRejected = new Set<string>();

	async function requireAuthorityId(context: SyncBindingContext | undefined): Promise<string> {
		const authorityId = context?.authorityId;
		if (typeof authorityId !== 'string' || authorityId.length === 0) {
			throw new Error('peer sync requires an authority');
		}
		return authorityId;
	}

	async function syncNow(context?: SyncBindingContext): Promise<TransportSyncReport> {
		const authorityId = await requireAuthorityId(context);

		const intake = await deps.getEngine<PeerIntakeEngine>('intake');
		const vault = (deps.resolveVault ?? resolveAuthorityKeyVault)();
		const opener = intake.createOpener(vault);
		const sign = lazySigner(deps.createSigner);
		const decisionSigner: StagingDecisionSigner = { authorityId, sign };
		const { registration, association } = deps.createTransports({ opener, decisionSigner });

		const errorItemIds = new Set<string>();
		let imported = 0;
		let pending = 0;

		try {
			const regEngine = await deps.getEngine<PeerRegistrationEngine>('registration');

			// (a) registration intake.
			const regReport = await registration.readStagedRequestsReport();
			for (const id of countableUnreadableIds(regReport)) errorItemIds.add(id);
			const authRegDocs = regReport.delivered.filter((doc: P2pStagedRequest) => doc.init.authorityId === authorityId);
			for (const doc of authRegDocs) {
				const existing = await regEngine.getRegistrationRequest(doc.requestId);
				if (existing) continue;
				try {
					await regEngine.submitRegistrationRequest(doc.init, doc.requesterKey, doc.signature);
					imported += 1;
				} catch {
					errorItemIds.add(doc.requestId);
				}
			}

			// (b) registration decision drain (D-44, 62-19 coordination) — the ONLY Authority path
			// that publishes registration decisions to the strand, and the only caller of
			// `createRegistrationDecisionPublisher`. Runs on the officer's peer sync, never at
			// decide time (62-27 adds the decide-time publish). Covers EVERY decided request of
			// this authority with no decision row yet — including a request intaken over the REST
			// bridge (62-25's `attach-sync-bindings.ts`), because a decision row carries no
			// staging-row dependency (62-01) and the strand is the authoritative decision record.
			const publisher = createRegistrationDecisionPublisher(registration, authorityId);
			const unpublishedIds = await regEngine.listUnpublishedRegistrationDecisions(authorityId);
			for (const requestId of unpublishedIds) {
				try {
					// Options omitted: automatic closure (62-19 coordination) — the oldest flagged
					// pending duplicate candidate, if any, closes alongside this decision.
					await regEngine.publishRegistrationDecision(publisher, requestId);
				} catch (err) {
					if (!isP2pStagingError(err, 'duplicate-decision')) {
						errorItemIds.add(requestId);
					}
				}
			}
			// Resume any interrupted two-transaction duplicate close exactly once per sync. A
			// throw here is swallowed: the next sync resumes it (62-19 makes this idempotent).
			try {
				const repair = await regEngine.completeDuplicateClosures(publisher);
				for (const failure of repair.failed) errorItemIds.add(failure.requestId);
			} catch {
				// Swallowed — see comment above.
			}

			// (c) association — the P2P transport IS the intake (D-06 via 62-15).
			const assocEngine = await deps.getEngine<PeerAssociationEngine>('association');
			const assocReqReport = await association.readStagedRequestsReport();
			const assocAttReport = await association.readStagedAttestationsReport();
			for (const id of countableUnreadableIds(assocReqReport)) errorItemIds.add(id);
			for (const id of countableUnreadableIds(assocAttReport)) errorItemIds.add(id);
			const authAssocDocs = assocReqReport.delivered.filter(
				(doc: P2pStagedAssociationRequest) => doc.init.authorityId === authorityId,
			);

			const assocResult = await runAssociationSync<P2pStagedAssociationRequest, P2pStagedAttestation>({
				readStagedRequests: async () => authAssocDocs,
				readStagedAttestations: async () => assocAttReport.delivered,
				requestIdOf: (doc) => doc.requestId,
				attestationIdOf: (doc) => doc.requestId,
				submitRequest: (doc) => assocEngine.submitAssociationRequest(doc.init, doc.requesterKey, doc.signature),
				submitAttestation: (doc) =>
					assocEngine.submitAssociationAttestation(doc.answer, doc.requesterKey, doc.signature),
				alreadyImportedRequest: async (doc) => (await assocEngine.getAssociationRequest(doc.requestId)) !== undefined,
				alreadyImportedAttestation: async (doc) => {
					const row = await assocEngine.getAssociationRequest(doc.requestId);
					return row === undefined || row.status !== 'c';
				},
				// D-46 (62-18 assignment): first-association processing, THEN the automatic
				// re-association pass — unconditionally, even when the first driver throws, so one
				// driver's failure can never starve the other (fail-safe: without this call every
				// re-association would silently wait for manual review regardless of the
				// authority's configured mode). `opener` is the SAME instance passed to
				// `createTransports` above. The first error wins the rethrow; the reassociation
				// error is reported only when the first driver succeeded.
				processPending: async () => {
					let firstError: unknown;
					try {
						await assocEngine.processPendingAssociationRequests(authorityId, sign, association);
					} catch (err) {
						firstError = err;
					}
					try {
						await assocEngine.processPendingReassociations(authorityId, sign, association, opener);
					} catch (err) {
						if (firstError === undefined) firstError = err;
					}
					if (firstError !== undefined) throw firstError;
				},
			});
			imported += assocResult.imported;
			for (const id of assocResult.errorItemIds) errorItemIds.add(id);

			// (d) pending — delivered authorityId requests (registration + association) still not
			// local after the run.
			for (const doc of authRegDocs) {
				if (!(await regEngine.getRegistrationRequest(doc.requestId))) pending += 1;
			}
			for (const doc of authAssocDocs) {
				if (!(await assocEngine.getAssociationRequest(doc.requestId))) pending += 1;
			}
		} finally {
			lastRunRejected = new Set(errorItemIds);
			await closeTransports(registration, association);
		}

		return {
			syncedAt: new Date().toISOString(),
			imported,
			pending,
			errorItemIds: [...errorItemIds],
		};
	}

	async function readCounts(context: SyncBindingContext): Promise<PeerSyncCounts> {
		const authorityId = await requireAuthorityId(context);

		const intake = await deps.getEngine<PeerIntakeEngine>('intake');
		const vault = (deps.resolveVault ?? resolveAuthorityKeyVault)();
		const opener = intake.createOpener(vault);
		// Read-only: this signer must never be invoked. readCounts never signs, submits, publishes
		// a decision, or drives processPending.
		const readOnlySign = async (): Promise<Signature> => {
			throw new Error('attach-peer-sync-binding: readCounts must never sign');
		};
		const decisionSigner: StagingDecisionSigner = { authorityId, sign: readOnlySign };
		const { registration, association } = deps.createTransports({ opener, decisionSigner });

		const failed = new Set<string>(lastRunRejected);
		let pending = 0;
		let synced = 0;

		try {
			const regEngine = await deps.getEngine<PeerRegistrationEngine>('registration');
			const assocEngine = await deps.getEngine<PeerAssociationEngine>('association');

			const regReport = await registration.readStagedRequestsReport();
			for (const id of countableUnreadableIds(regReport)) failed.add(id);
			for (const doc of regReport.delivered.filter((d: P2pStagedRequest) => d.init.authorityId === authorityId)) {
				if (await regEngine.getRegistrationRequest(doc.requestId)) synced += 1;
				else pending += 1;
			}

			const assocReqReport = await association.readStagedRequestsReport();
			for (const id of countableUnreadableIds(assocReqReport)) failed.add(id);
			for (const doc of assocReqReport.delivered.filter(
				(d: P2pStagedAssociationRequest) => d.init.authorityId === authorityId,
			)) {
				if (await assocEngine.getAssociationRequest(doc.requestId)) synced += 1;
				else pending += 1;
			}

			const assocAttReport = await association.readStagedAttestationsReport();
			for (const id of countableUnreadableIds(assocAttReport)) failed.add(id);
		} finally {
			await closeTransports(registration, association);
		}

		return { pending, synced, failed: failed.size };
	}

	return { id: 'peer', syncNow, readCounts };
}

/** Registers the 'peer' binding unconditionally (D-28 — no dev-only build gate). */
export function attachPeerSyncBinding(deps: PeerSyncBindingDeps): void {
	registerSyncBinding(createPeerSyncBinding(deps));
}
