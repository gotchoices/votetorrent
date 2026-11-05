/**
 * Phase 62 Plan 21 (D-28/D-31/D-32/D-04), extended by Phase 62 Plan 25 (D-44/D-46):
 * attach-peer-sync-binding.ts — the 'peer' sync binding's intake, closure-aware decision
 * publishing drain, first + re-association processing and live counts
 * (P1-P3, P4a-P4d, P5a-P5b, P6-P8, C1, C2, C2b, R1-R3).
 */

import * as fs from 'fs';
import * as path from 'path';
import {
	attachPeerSyncBinding,
	createPeerSyncBinding,
	createRegistrationDecisionPublisher,
	type PeerSyncBindingDeps,
} from '../attach-peer-sync-binding';
import { clearSyncBindings, resolveSyncBinding } from '../bulk-import-sync-model';

function regDoc(id: string, authorityId = 'auth-1') {
	return {
		requestId: id,
		init: { id, authorityId },
		requesterKey: `rk-${id}`,
		signature: { signerUserId: 'req-user', signerKey: 'req-key', signature: `sig-${id}` },
		stagedAt: '2026-01-01T00:00:00.000Z',
		cursor: '0000000000000001',
		digest: 'dg',
	};
}

function assocDoc(id: string, authorityId = 'auth-1') {
	return {
		requestId: id,
		init: { id, authorityId },
		requesterKey: `rk-${id}`,
		signature: { signerUserId: 'req-user', signerKey: 'req-key', signature: `sig-${id}` },
		stagedAt: '2026-01-01T00:00:00.000Z',
		cursor: '0000000000000001',
		digest: 'dg',
	};
}

function makeFakeTransports(overrides: {
	regReport?: { delivered: unknown[]; unreadable: unknown[] };
	decisionRecords?: Array<{ requestId: string }>;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	publishDecisionImpl?: (input: any) => Promise<string>;
	assocReqReport?: { delivered: unknown[]; unreadable: unknown[] };
	assocAttReport?: { delivered: unknown[]; unreadable: unknown[] };
	callLog?: string[];
}) {
	const registration = {
		readStagedRequestsReport: jest.fn(async () => overrides.regReport ?? { delivered: [], unreadable: [] }),
		readDecisionRecords: jest.fn(async () => overrides.decisionRecords ?? []),
		publishDecision: jest.fn<Promise<string>, [unknown]>(async (input: unknown) => {
			overrides.callLog?.push('transport.publishDecision');
			return (overrides.publishDecisionImpl ?? (async () => 'cursor'))(input);
		}),
		close: jest.fn(async () => undefined),
	};
	const association = {
		readStagedRequestsReport: jest.fn(async () => overrides.assocReqReport ?? { delivered: [], unreadable: [] }),
		readStagedAttestationsReport: jest.fn(async () => overrides.assocAttReport ?? { delivered: [], unreadable: [] }),
		close: jest.fn(async () => undefined),
	};
	return { registration, association };
}

function makeDeps(opts: {
	regReport?: { delivered: unknown[]; unreadable: unknown[] };
	decisionRecords?: Array<{ requestId: string }>;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	publishDecisionImpl?: (input: any) => Promise<string>;
	assocReqReport?: { delivered: unknown[]; unreadable: unknown[] };
	assocAttReport?: { delivered: unknown[]; unreadable: unknown[] };
	localReg?: Record<string, { status: string; decidedAt?: string; rejectionReason?: string }>;
	localAssoc?: Record<string, { status: string }>;
	submitRegistrationImpl?: (...args: unknown[]) => Promise<unknown>;
	submitAssocReqImpl?: (...args: unknown[]) => Promise<unknown>;
	submitAssocAttImpl?: (...args: unknown[]) => Promise<unknown>;
	createSignerImpl?: () => Promise<(digest: Uint8Array) => Promise<unknown>>;
	listUnpublishedIds?: string[];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	publishRegistrationDecisionImpl?: (publisher: any, requestId: string) => Promise<any>;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	completeDuplicateClosuresImpl?: (publisher: any) => Promise<{ completed: string[]; failed: Array<{ requestId: string; reason: string }> }>;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	processPendingReassociationsImpl?: (...args: any[]) => Promise<unknown>;
	callLog?: string[];
}) {
	const localReg = opts.localReg ?? {};
	const localAssoc = opts.localAssoc ?? {};
	const callLog: string[] = opts.callLog ?? [];

	const regEngine = {
		getRegistrationRequest: jest.fn(async (id: string) => localReg[id]),
		submitRegistrationRequest: jest.fn(async (...args: unknown[]) => {
			callLog.push('submitRegistrationRequest');
			return (opts.submitRegistrationImpl ?? (async () => 'ok'))(...args);
		}),
		listUnpublishedRegistrationDecisions: jest.fn(async () => {
			callLog.push('listUnpublishedRegistrationDecisions');
			return opts.listUnpublishedIds ?? [];
		}),
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		publishRegistrationDecision: jest.fn(async (publisher: any, requestId: string) => {
			callLog.push(`publishRegistrationDecision:${requestId}`);
			if (opts.publishRegistrationDecisionImpl) return opts.publishRegistrationDecisionImpl(publisher, requestId);
			// Mirrors what the real RegistrationEngine does: writes through the injected publisher.
			const cursor = await publisher.publishDecision({
				requestId,
				status: 'a',
				decidedAt: '2026-01-01T00:00:00.000Z',
			});
			return { requestId, outcome: 'published', publishedStatus: 'a', cursor, closure: 'none' };
		}),
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		completeDuplicateClosures: jest.fn(async (publisher: any) => {
			callLog.push('completeDuplicateClosures');
			if (opts.completeDuplicateClosuresImpl) return opts.completeDuplicateClosuresImpl(publisher);
			return { completed: [], failed: [] };
		}),
	};
	const assocEngine = {
		getAssociationRequest: jest.fn(async (id: string) => localAssoc[id]),
		submitAssociationRequest: jest.fn(opts.submitAssocReqImpl ?? (async () => 'ok')),
		submitAssociationAttestation: jest.fn(opts.submitAssocAttImpl ?? (async () => undefined)),
		processPendingAssociationRequests: jest.fn<
			Promise<{ challengesIssued: number; associated: number; rejected: number }>,
			[string, unknown, unknown]
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		>(async (..._args: any[]) => {
			callLog.push('processPendingAssociationRequests');
			return { challengesIssued: 0, associated: 0, rejected: 0 };
		}),
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		processPendingReassociations: jest.fn(async (...args: any[]) => {
			callLog.push('processPendingReassociations');
			if (opts.processPendingReassociationsImpl) return opts.processPendingReassociationsImpl(...args);
			return { challengesIssued: 0, associated: 0, rejected: 0, awaitingReview: 0 };
		}),
	};
	const openerInstance = { open: jest.fn() };
	const intakeEngine = { createOpener: jest.fn(() => openerInstance) };

	const getEngine = jest.fn(async (name: string) => {
		if (name === 'intake') return intakeEngine;
		if (name === 'registration') return regEngine;
		if (name === 'association') return assocEngine;
		throw new Error(`unknown engine ${name}`);
	});

	const transports = makeFakeTransports({ ...opts, callLog });
	const createTransports = jest.fn(() => ({ strandId: 'hash-1', ...transports }));
	const createSigner = jest.fn(
		opts.createSignerImpl ??
			(async () => async (_digest: Uint8Array) => ({ signerUserId: 'u1', signerKey: 'k1', signature: 'sig1' })),
	);

	const deps: PeerSyncBindingDeps = {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		getEngine: getEngine as any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		createTransports: createTransports as any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		createSigner: createSigner as any,
	};

	return { deps, regEngine, assocEngine, intakeEngine, transports, createTransports, createSigner, callLog, openerInstance };
}

beforeEach(() => {
	clearSyncBindings();
});

describe('createPeerSyncBinding — syncNow (D-28/D-32)', () => {
	it('P1: submits delivered auth-1 docs absent locally, exactly (init, requesterKey, signature); skips other-authority and already-local docs', async () => {
		const docLocal = regDoc('r-local');
		const docNew = regDoc('r-new');
		const docOtherAuth = regDoc('r-other', 'auth-2');
		const { deps, regEngine } = makeDeps({
			regReport: { delivered: [docLocal, docNew, docOtherAuth], unreadable: [] },
			localReg: { 'r-local': { status: 'p' } },
		});
		const binding = createPeerSyncBinding(deps);
		const report = await binding.syncNow({ authorityId: 'auth-1' });

		expect(regEngine.submitRegistrationRequest).toHaveBeenCalledTimes(1);
		expect(regEngine.submitRegistrationRequest).toHaveBeenCalledWith(docNew.init, docNew.requesterKey, docNew.signature);
		expect(report.imported).toBe(1);
	});

	it('P2: a submit rejection adds the requestId to errorItemIds without leaking the thrown message', async () => {
		const doc = regDoc('r1');
		const { deps } = makeDeps({
			regReport: { delivered: [doc], unreadable: [] },
			submitRegistrationImpl: async () => {
				throw new Error('super-secret-leak');
			},
		});
		const binding = createPeerSyncBinding(deps);
		const report = await binding.syncNow({ authorityId: 'auth-1' });

		expect(report.errorItemIds).toContain('r1');
		expect(JSON.stringify(report)).not.toContain('super-secret-leak');
	});

	it("P3: unreadable rows add to errorItemIds except 'not-a-recipient'", async () => {
		const unreadable = [
			{ requestId: 'u1', cursor: '1', requesterKey: 'rk', stagedAt: 't', reason: 'authentication-failed' },
			{ requestId: 'u2', cursor: '2', requesterKey: 'rk', stagedAt: 't', reason: 'no-local-key' },
			{ requestId: 'u3', cursor: '3', requesterKey: 'rk', stagedAt: 't', reason: 'malformed-row' },
			{ requestId: 'u4', cursor: '4', requesterKey: 'rk', stagedAt: 't', reason: 'not-a-recipient' },
		];
		const { deps } = makeDeps({ regReport: { delivered: [], unreadable } });
		const binding = createPeerSyncBinding(deps);
		const report = await binding.syncNow({ authorityId: 'auth-1' });

		expect([...report.errorItemIds].sort()).toEqual(['u1', 'u2', 'u3']);
	});

	it('P4a: drains listUnpublishedRegistrationDecisions through publishRegistrationDecision with options omitted (publisher, id) only, then calls completeDuplicateClosures exactly once after the last publish', async () => {
		const { deps, regEngine } = makeDeps({ listUnpublishedIds: ['r1', 'r2'] });
		const binding = createPeerSyncBinding(deps);
		await binding.syncNow({ authorityId: 'auth-1' });

		expect(regEngine.publishRegistrationDecision).toHaveBeenCalledTimes(2);
		const calls = regEngine.publishRegistrationDecision.mock.calls;
		expect(calls[0]!).toHaveLength(2);
		expect(calls[0]![1]).toBe('r1');
		expect(calls[1]![1]).toBe('r2');
		const publisher = calls[0]![0];
		expect(publisher.authorityId).toBe('auth-1');
		expect(regEngine.completeDuplicateClosures).toHaveBeenCalledTimes(1);
		expect(regEngine.completeDuplicateClosures).toHaveBeenCalledWith(publisher);
	});

	it("P4a2: the publisher hands the registration transport's publishDecision the IDENTICAL object it was given", async () => {
		const { transports } = makeDeps({});
		const publisher = createRegistrationDecisionPublisher(transports.registration, 'auth-1');
		const decision = { requestId: 'z1', status: 'a' as const, decidedAt: '2026-02-01T00:00:00.000Z' };
		await publisher.publishDecision(decision);
		expect(transports.registration.publishDecision).toHaveBeenCalledWith(decision);
		expect(publisher.authorityId).toBe('auth-1');
	});

	it('P4b: the drain starts after every registration intake submit of this sync and before processPendingAssociationRequests', async () => {
		const docNew = regDoc('r-new');
		const callLog: string[] = [];
		const { deps } = makeDeps({
			regReport: { delivered: [docNew], unreadable: [] },
			listUnpublishedIds: ['r1'],
			callLog,
		});
		const binding = createPeerSyncBinding(deps);
		await binding.syncNow({ authorityId: 'auth-1' });

		const submitIdx = callLog.indexOf('submitRegistrationRequest');
		const drainIdx = callLog.indexOf('listUnpublishedRegistrationDecisions');
		const assocIdx = callLog.indexOf('processPendingAssociationRequests');
		expect(submitIdx).toBeGreaterThanOrEqual(0);
		expect(drainIdx).toBeGreaterThan(submitIdx);
		expect(assocIdx).toBeGreaterThan(drainIdx);
	});

	it('P4c: a rejected publish adds the id to errorItemIds and still attempts the rest plus completeDuplicateClosures; a pending-retry closure is not itself an error; a repair failure adds its id; a rejected completeDuplicateClosures adds no id and does not abort association processing', async () => {
		const publishRegistrationDecisionImpl = jest.fn(async (_publisher: unknown, requestId: string) => {
			if (requestId === 'r1') throw new Error('leak-should-not-appear');
			if (requestId === 'r2') return { requestId, outcome: 'published', publishedStatus: 'a', closure: 'pending-retry', closureErrorCode: 'timeout' };
			return { requestId, outcome: 'published', publishedStatus: 'a', closure: 'none' };
		});
		const { deps, assocEngine } = makeDeps({
			listUnpublishedIds: ['r1', 'r2'],
			publishRegistrationDecisionImpl,
			completeDuplicateClosuresImpl: async () => {
				throw new Error('closure-repair-boom');
			},
		});
		const binding = createPeerSyncBinding(deps);
		const report = await binding.syncNow({ authorityId: 'auth-1' });

		expect(publishRegistrationDecisionImpl).toHaveBeenCalledTimes(2);
		expect(report.errorItemIds).toContain('r1');
		expect(JSON.stringify(report)).not.toContain('leak-should-not-appear');
		// r2's 'pending-retry' closure is not itself an error.
		expect(report.errorItemIds).not.toContain('r2');
		expect(assocEngine.processPendingAssociationRequests).toHaveBeenCalledTimes(1);

		// A repair report naming a failed id DOES add it to errorItemIds (separate run).
		const { deps: deps2 } = makeDeps({
			completeDuplicateClosuresImpl: async () => ({ completed: [], failed: [{ requestId: 'r9', reason: 'publish-failed' }] }),
		});
		const binding2 = createPeerSyncBinding(deps2);
		const report2 = await binding2.syncNow({ authorityId: 'auth-1' });
		expect(report2.errorItemIds).toContain('r9');
	});

	it('P4d: no direct transport.publishDecision call outside the publisher wrapper, and the source contains publishDecision( exactly once with no readDecisionRecords(', async () => {
		const { deps, transports } = makeDeps({ listUnpublishedIds: ['r1'] });
		const binding = createPeerSyncBinding(deps);
		await binding.syncNow({ authorityId: 'auth-1' });
		// Every call into the transport's publishDecision came through the publisher (spy counts equal).
		expect(transports.registration.publishDecision).toHaveBeenCalledTimes(1);

		const stripped = fs
			.readFileSync(path.resolve(__dirname, '../attach-peer-sync-binding.ts'), 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.split('\n')
			.map((l) => l.replace(/\/\/.*$/, ''))
			.join('\n');
		expect((stripped.match(/publishDecision\(/g) || []).length).toBe(1);
		expect(stripped).not.toMatch(/readDecisionRecords\(/);
	});

	it('P5a: processPendingAssociationRequests runs, THEN processPendingReassociations runs, each exactly once, with the SAME sign/association/opener instances', async () => {
		const docAuth = assocDoc('as1');
		const docOther = assocDoc('as2', 'auth-2');
		const callLog: string[] = [];
		const { deps, assocEngine, transports, openerInstance } = makeDeps({
			assocReqReport: { delivered: [docAuth, docOther], unreadable: [] },
			submitAssocReqImpl: async () => {
				throw new Error('boom');
			},
			callLog,
		});
		const binding = createPeerSyncBinding(deps);
		await binding.syncNow({ authorityId: 'auth-1' });

		expect(assocEngine.submitAssociationRequest).toHaveBeenCalledTimes(1);
		expect(assocEngine.submitAssociationRequest).toHaveBeenCalledWith(docAuth.init, docAuth.requesterKey, docAuth.signature);
		expect(assocEngine.processPendingAssociationRequests).toHaveBeenCalledTimes(1);
		expect(assocEngine.processPendingReassociations).toHaveBeenCalledTimes(1);

		const call = assocEngine.processPendingAssociationRequests.mock.calls[0]!;
		expect(call[0]).toBe('auth-1');
		expect(typeof call[1]).toBe('function');
		expect(call[2]).toBe(transports.association);

		const reassocCall = assocEngine.processPendingReassociations.mock.calls[0]!;
		expect(reassocCall[0]).toBe('auth-1');
		expect(reassocCall[1]).toBe(call[1]); // same sign
		expect(reassocCall[2]).toBe(transports.association); // same association transport
		expect(reassocCall[3]).toBe(openerInstance); // same opener instance passed to createTransports

		const firstIdx = callLog.indexOf('processPendingAssociationRequests');
		const secondIdx = callLog.indexOf('processPendingReassociations');
		expect(firstIdx).toBeGreaterThanOrEqual(0);
		expect(secondIdx).toBeGreaterThan(firstIdx);
	});

	it('P5b: processPendingReassociations still runs when processPendingAssociationRequests throws, and syncNow rejects with both transports closed; a reassociation-only throw also rejects with both closed', async () => {
		const { deps, assocEngine, transports } = makeDeps({
			submitAssocReqImpl: async () => undefined, // irrelevant to the throw path below
		});
		(assocEngine.processPendingAssociationRequests as jest.Mock).mockRejectedValueOnce(new Error('first-driver-failed'));
		const binding = createPeerSyncBinding(deps);
		await expect(binding.syncNow({ authorityId: 'auth-1' })).rejects.toThrow('first-driver-failed');
		expect(assocEngine.processPendingReassociations).toHaveBeenCalledTimes(1);
		expect(transports.registration.close).toHaveBeenCalledTimes(1);
		expect(transports.association.close).toHaveBeenCalledTimes(1);

		const reassocError = Object.assign(new Error('co-sign required'), {
			name: 'ReassociationError',
			code: 'threshold-requires-co-sign',
		});
		const { deps: deps2, assocEngine: assocEngine2, transports: transports2 } = makeDeps({});
		(assocEngine2.processPendingReassociations as jest.Mock).mockRejectedValueOnce(reassocError);
		const binding2 = createPeerSyncBinding(deps2);
		await expect(binding2.syncNow({ authorityId: 'auth-1' })).rejects.toMatchObject({ code: 'threshold-requires-co-sign' });
		expect(transports2.registration.close).toHaveBeenCalledTimes(1);
		expect(transports2.association.close).toHaveBeenCalledTimes(1);
	});

	it('P6: createSigner is never called when nothing needs signing, and is called at most once and propagates its rejection to the first sign() call', async () => {
		const { deps, createSigner, createTransports } = makeDeps({});
		const binding = createPeerSyncBinding(deps);
		await binding.syncNow({ authorityId: 'auth-1' });
		expect(createSigner).not.toHaveBeenCalled();

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const decisionSigner = (createTransports as any).mock.calls[0][0].decisionSigner;
		const rejection = new Error('signer unavailable');
		createSigner.mockImplementationOnce(async () => {
			throw rejection;
		});
		await expect(decisionSigner.sign(new Uint8Array([1]))).rejects.toBe(rejection);
		await expect(decisionSigner.sign(new Uint8Array([1]))).rejects.toBe(rejection);
		expect(createSigner).toHaveBeenCalledTimes(1);
	});

	it('P7: both transports are closed exactly once per sync, even when an earlier step throws', async () => {
		const { deps, transports } = makeDeps({});
		(transports.association.readStagedRequestsReport as jest.Mock).mockRejectedValueOnce(new Error('kaboom'));
		const binding = createPeerSyncBinding(deps);
		await expect(binding.syncNow({ authorityId: 'auth-1' })).rejects.toThrow('kaboom');
		expect(transports.registration.close).toHaveBeenCalledTimes(1);
		expect(transports.association.close).toHaveBeenCalledTimes(1);
	});

	it('S-4: a rejecting registration.close still closes association, and syncNow returns its own report with this run\'s failed items', async () => {
		const { deps, transports } = makeDeps({
			regReport: { delivered: [regDoc('rej-close')], unreadable: [] },
			submitRegistrationImpl: async () => {
				throw new Error('boom');
			},
		});
		(transports.registration.close as jest.Mock).mockRejectedValueOnce(new Error('strand open failed'));
		const binding = createPeerSyncBinding(deps);
		const report = await binding.syncNow({ authorityId: 'auth-1' });
		expect(transports.association.close).toHaveBeenCalledTimes(1);
		expect(report.errorItemIds).toContain('rej-close');
		const counts = await binding.readCounts!({ authorityId: 'auth-1' });
		expect(counts.failed).toBeGreaterThanOrEqual(1);
	});

	it('S-4b: association.close rejecting does not hide the sync report; readCounts closes both even when the first close rejects', async () => {
		const { deps, transports } = makeDeps({});
		(transports.association.close as jest.Mock).mockRejectedValueOnce(new Error('assoc close failed'));
		const binding = createPeerSyncBinding(deps);
		await expect(binding.syncNow({ authorityId: 'auth-1' })).resolves.toMatchObject({ errorItemIds: [] });
		(transports.registration.close as jest.Mock).mockRejectedValueOnce(new Error('reg close failed'));
		await expect(binding.readCounts!({ authorityId: 'auth-1' })).resolves.toMatchObject({ failed: 0 });
		expect(transports.association.close).toHaveBeenCalledTimes(2);
	});

	it('P8: syncNow rejects before createTransports with no/empty context; a createTransports throw propagates', async () => {
		const { deps, createTransports } = makeDeps({});
		const binding = createPeerSyncBinding(deps);

		await expect(binding.syncNow()).rejects.toThrow();
		await expect(binding.syncNow({ authorityId: '' })).rejects.toThrow();
		expect(createTransports).not.toHaveBeenCalled();

		class FakePeerStrandUnavailableError extends Error {}
		(createTransports as jest.Mock).mockImplementationOnce(() => {
			throw new FakePeerStrandUnavailableError('no-network');
		});
		await expect(binding.syncNow({ authorityId: 'auth-1' })).rejects.toBeInstanceOf(FakePeerStrandUnavailableError);
	});
});

describe('createPeerSyncBinding — readCounts (D-31)', () => {
	it('C1: derives pending/synced/failed from the transport reports plus the last run\'s rejected ids (deduped)', async () => {
		const { deps, transports } = makeDeps({
			regReport: { delivered: [regDoc('rej1')], unreadable: [] },
			submitRegistrationImpl: async () => {
				throw new Error('boom');
			},
		});
		const binding = createPeerSyncBinding(deps);
		const firstReport = await binding.syncNow({ authorityId: 'auth-1' });
		expect(firstReport.errorItemIds).toContain('rej1');

		const regDocLocal = regDoc('r-local');
		const regDocPending = regDoc('r-pending');
		const assocDocPending = assocDoc('as-pending');
		const unreadableAuth = { requestId: 'u-auth', cursor: '1', requesterKey: 'rk', stagedAt: 't', reason: 'authentication-failed' };
		const unreadableNotRecipient = { requestId: 'u-not-recipient', cursor: '2', requesterKey: 'rk', stagedAt: 't', reason: 'not-a-recipient' };

		(transports.registration.readStagedRequestsReport as jest.Mock).mockResolvedValue({
			delivered: [regDocLocal, regDocPending],
			unreadable: [unreadableAuth, unreadableNotRecipient],
		});
		(transports.association.readStagedRequestsReport as jest.Mock).mockResolvedValue({
			delivered: [assocDocPending],
			unreadable: [],
		});
		(transports.association.readStagedAttestationsReport as jest.Mock).mockResolvedValue({ delivered: [], unreadable: [] });
		deps.getEngine = (async (name: string) => {
			if (name === 'intake') return { createOpener: jest.fn(() => ({ open: jest.fn() })) };
			if (name === 'registration') {
				return { getRegistrationRequest: jest.fn(async (id: string) => (id === 'r-local' ? { status: 'p' } : undefined)) };
			}
			if (name === 'association') {
				return { getAssociationRequest: jest.fn(async () => undefined) };
			}
			throw new Error(`unknown engine ${name}`);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		}) as any;

		const counts = await binding.readCounts!({ authorityId: 'auth-1' });
		expect(counts).toEqual({ pending: 2, synced: 1, failed: 2 });
	});

	it('C2: never signs, submits, publishes a decision, or drives processPending; its decision signer rejects if invoked', async () => {
		const { deps, regEngine, assocEngine, createSigner, transports, createTransports } = makeDeps({});
		const binding = createPeerSyncBinding(deps);
		const counts = await binding.readCounts!({ authorityId: 'auth-1' });

		expect(counts).toEqual({ pending: 0, synced: 0, failed: 0 });
		expect(createSigner).not.toHaveBeenCalled();
		expect(regEngine.submitRegistrationRequest).not.toHaveBeenCalled();
		expect(assocEngine.submitAssociationRequest).not.toHaveBeenCalled();
		expect(assocEngine.submitAssociationAttestation).not.toHaveBeenCalled();
		expect(assocEngine.processPendingAssociationRequests).not.toHaveBeenCalled();
		expect(transports.registration.publishDecision).not.toHaveBeenCalled();

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const decisionSigner = (createTransports as any).mock.calls[0][0].decisionSigner;
		await expect(decisionSigner.sign(new Uint8Array([1]))).rejects.toThrow();
	});

	it('C2b: readCounts calls none of listUnpublishedRegistrationDecisions, publishRegistrationDecision, completeDuplicateClosures, processPendingAssociationRequests or processPendingReassociations', async () => {
		const { deps, regEngine, assocEngine } = makeDeps({});
		const binding = createPeerSyncBinding(deps);
		await binding.readCounts!({ authorityId: 'auth-1' });

		expect(regEngine.listUnpublishedRegistrationDecisions).not.toHaveBeenCalled();
		expect(regEngine.publishRegistrationDecision).not.toHaveBeenCalled();
		expect(regEngine.completeDuplicateClosures).not.toHaveBeenCalled();
		expect(assocEngine.processPendingAssociationRequests).not.toHaveBeenCalled();
		expect(assocEngine.processPendingReassociations).not.toHaveBeenCalled();
	});
});

describe('attachPeerSyncBinding / registration (R1-R3, D-28)', () => {
	it('R1: registers a handle resolvable at id "peer" with a readCounts function', () => {
		const { deps } = makeDeps({});
		attachPeerSyncBinding(deps);
		const handle = resolveSyncBinding('peer');
		expect(handle?.id).toBe('peer');
		expect(typeof handle?.readCounts).toBe('function');
	});

	it('R2: the AppProvider effect registering the peer binding has no __DEV__ gate', () => {
		const src = fs.readFileSync(path.resolve(__dirname, '../../../providers/AppProvider.tsx'), 'utf8');
		const idx = src.indexOf('attachPeerSyncBinding(');
		expect(idx).toBeGreaterThan(-1);
		const before = src.lastIndexOf('useEffect(', idx);
		const after = src.indexOf('}, [', idx);
		const block = src.slice(before, after);
		expect(block).not.toContain('__DEV__');
	});

	it('R3: officer-intake-key.ts and attach-peer-sync-binding.ts carry zero createDeviceSigner(/getOrCreateDeviceUser; AppProvider wires createSigner: resolveDeviceSigner', () => {
		function stripComments(s: string): string {
			return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
		}
		const officer = stripComments(fs.readFileSync(path.resolve(__dirname, '../officer-intake-key.ts'), 'utf8'));
		const binding = stripComments(fs.readFileSync(path.resolve(__dirname, '../attach-peer-sync-binding.ts'), 'utf8'));
		expect((officer.match(/createDeviceSigner\(|getOrCreateDeviceUser/g) || []).length).toBe(0);
		expect((binding.match(/createDeviceSigner\(|getOrCreateDeviceUser/g) || []).length).toBe(0);

		const appProvider = fs.readFileSync(path.resolve(__dirname, '../../../providers/AppProvider.tsx'), 'utf8');
		expect(appProvider).toMatch(/createSigner:\s*resolveDeviceSigner/);
	});
});
