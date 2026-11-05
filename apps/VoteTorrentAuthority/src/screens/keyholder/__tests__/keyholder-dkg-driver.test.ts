/**
 * keyholder-dkg-driver.test.ts — Phase 62 Plan 26 (D-16, D-19). M1 (pure mapping), D1-D4 (fakes),
 * R1-R3 (real schema, two devices = two vaults/storages over one shared DB — the same
 * two-identity recipe `dkg-keyholders.ts`'s `seedDkgElection`/`inviteAndAcceptKeyholder` use,
 * replicated here through the mapped `@votetorrent/vote-engine/test/fixtures/test-context`
 * helpers and this app's own `acceptKeyholderInvitation`/`createAuthorityKeyVault`, since
 * `dkg-keyholders.ts` itself is not a mapped jest path).
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import { ElectionsEngine, InvitationEngine, KeyholderDkgEngine, peekNextElectionTid, keyholderDkgShareAlias } from '@votetorrent/vote-engine/rn';
import {
	addTestAuthority,
	createTestNetwork,
	makeElectionInit,
	makeTestSignCallback,
} from '@votetorrent/vote-engine/test/fixtures/test-context';
import type { KeyholderDkgStatus, KeyholderInvite, Signature } from '@votetorrent/vote-core';
import { createAuthorityKeyVault } from '../../../engines/key-vault';
import { VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1, keyholderVaultPrompt } from '../../../engines/keyholder-vault';
import { createFakeSecretWrapper, createMapStorage } from '../../../engines/__fixtures__/fake-secret-wrapper';
import { getKeyholderIdentity, keyholderSigningKeyAlias } from '../../../engines/keyholder-identity';
import type { KeyVaultStorage } from '../../../engines/key-vault';
import { acceptKeyholderInvitation } from '../keyholder-accept';
import { driveKeyholderDkg, keyholderDkgRowState } from '../keyholder-dkg-driver';

/**
 * A keyholder's own device context: the same strand db, no officer identity. The keyholder who accepts is never
 * the inviting officer (self-invite refusal, 62-103), so every 'k' accept runs on this context; slot creation
 * and reads may keep the inviter's context.
 */
const inviteeCtx = <C extends { db: unknown }>(ctx: C): C => ({ db: ctx.db }) as unknown as C;

jest.setTimeout(30_000);

/** Wraps a jest mock resolving a fixed engine instance into the generic `<T>(name) => Promise<T>`
 * shape `KeyholderDkgDriverDeps.getEngine` declares — a plain `jest.fn(async () => x)` infers a
 * concrete (non-generic) return type that TS rejects at the call site. */
function asGetEngine<E>(mock: jest.Mock<Promise<E>, []>): <T>(engineName: string) => Promise<T> {
	return mock as unknown as <T>(engineName: string) => Promise<T>;
}

// ---------------------------------------------------------------------------
// M1 — pure mapping
// ---------------------------------------------------------------------------

function statusWith(overrides: Partial<KeyholderDkgStatus>): KeyholderDkgStatus {
	return {
		electionId: 'e1',
		revision: 0,
		threshold: 2,
		phase: 'not-started',
		currentAttempt: null,
		currentRound: null,
		roster: [],
		awaitingUserIds: [],
		attempts: [],
		disqualified: [],
		electionKey: null,
		...overrides,
	};
}

describe('keyholderDkgRowState (M1)', () => {
	it('null -> loading', () => {
		expect(keyholderDkgRowState(null)).toBe('loading');
	});

	it.each([
		['not-started', 'pending'],
		['blocked', 'pending'],
		['in-progress', 'inProgress'],
		['restarting', 'complaint'],
		['complete', 'complete'],
		['failed', 'failed'],
	] as const)('%s -> %s', (phase, expected) => {
		expect(keyholderDkgRowState(statusWith({ phase }))).toBe(expected);
	});

	// UAT 62 M: a 1-of-1 policy read "Waiting for other keyholders to join" forever. The DKG needs
	// 2 <= threshold <= participants, so a threshold below 2 is blocked for good.
	it.each(['no-keyholders', 'threshold-out-of-range'] as const)('blocked (%s) at threshold 1 -> thresholdTooLow', (blockedReason) => {
		expect(keyholderDkgRowState(statusWith({ phase: 'blocked', blockedReason, threshold: 1 }))).toBe('thresholdTooLow');
	});

	it('blocked at threshold 2 with too few accepted keyholders is still a real wait -> pending', () => {
		expect(keyholderDkgRowState(statusWith({ phase: 'blocked', blockedReason: 'threshold-out-of-range', threshold: 2 }))).toBe('pending');
	});

	it('blocked with no current revision (threshold null) -> pending', () => {
		expect(keyholderDkgRowState(statusWith({ phase: 'blocked', blockedReason: 'no-current-revision', threshold: null }))).toBe('pending');
	});

	it.each(['not-started', 'blocked', 'in-progress', 'restarting', 'complete', 'failed'] as const)(
		'self.isDisqualified -> failed, never complaint (phase %s)',
		(phase) => {
			const result = keyholderDkgRowState(statusWith({ phase, self: { userId: 'u', isParticipant: true, isDisqualified: true, hasShare: false } }));
			expect(result).toBe('failed');
			expect(result).not.toBe('complaint');
		}
	);
});

// ---------------------------------------------------------------------------
// D1-D4 — driver with fakes
// ---------------------------------------------------------------------------

function makeFakeDkgEngine(overrides?: {
	getDkgStatus?: jest.Mock;
	advanceDkg?: jest.Mock;
}) {
	return {
		getDkgStatus: overrides?.getDkgStatus ?? jest.fn(async () => statusWith({ phase: 'in-progress', self: { userId: 'u1', isParticipant: true, isDisqualified: false, hasShare: false } })),
		advanceDkg: overrides?.advanceDkg ?? jest.fn(async () => ({ actions: ['posted-round-1'], status: statusWith({ phase: 'in-progress' }) })),
		getElectionKey: jest.fn(async () => null),
		verifyDkgTranscript: jest.fn(),
	};
}

function makeVaultHarness(options?: { failUnwrapCode?: string }) {
	const wrapper = createFakeSecretWrapper(options);
	const vault = createAuthorityKeyVault({
		wrapper,
		storage: createMapStorage() as unknown as KeyVaultStorage,
		authRequiredWrap: { keyAlias: VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1, prompt: keyholderVaultPrompt },
	});
	const storage = createMapStorage();
	return { wrapper, vault, storage };
}

describe('driveKeyholderDkg with fakes (D1-D4)', () => {
	it('D1: no identity record for keyholderUserId -> getDkgStatus(electionId, undefined), advanceDkg never called, 0 wraps/unwraps', async () => {
		const dkgEngine = makeFakeDkgEngine();
		const { vault, storage, wrapper } = makeVaultHarness();
		const getEngine = asGetEngine(jest.fn(async () => dkgEngine));

		const outcome = await driveKeyholderDkg({ getEngine, vault, storage }, 'election-1', 'no-such-user');

		expect(dkgEngine.getDkgStatus).toHaveBeenCalledWith('election-1', undefined);
		expect(dkgEngine.advanceDkg).not.toHaveBeenCalled();
		expect(outcome.advanced).toBe(false);
		expect(wrapper.wrapCalls + wrapper.unwrapCalls).toBe(0);
	});

	it.each(['complete', 'failed', 'blocked'] as const)('D2: terminal phase %s never calls advanceDkg', async (phase) => {
		const dkgEngine = makeFakeDkgEngine({
			getDkgStatus: jest.fn(async () => statusWith({ phase, self: { userId: 'u1', isParticipant: true, isDisqualified: false, hasShare: false } })),
		});
		const { vault, storage } = makeVaultHarness();
		await vault.putSecret(keyholderSigningKeyAlias('u1'), new Uint8Array(32).fill(1), { requireUserAuth: true });
		const record = { v: 1 as const, userId: 'u1', inviteSlotCid: 'slot', signingPublicKey: '02'.repeat(33), signingKeyType: 'M' as const, dkgReceivingPublicKey: '03'.repeat(33), createdAt: new Date().toISOString() };
		await storage.setItem('vt.keyholder-identities.v1', JSON.stringify({ v: 1, identities: [record] }));
		const getEngine = asGetEngine(jest.fn(async () => dkgEngine));

		await driveKeyholderDkg({ getEngine, vault, storage }, 'election-1', 'u1');

		expect(dkgEngine.advanceDkg).not.toHaveBeenCalled();
	});

	it('D2b: self.isParticipant false never calls advanceDkg', async () => {
		const dkgEngine = makeFakeDkgEngine({
			getDkgStatus: jest.fn(async () => statusWith({ phase: 'in-progress', self: { userId: 'u1', isParticipant: false, isDisqualified: false, hasShare: false } })),
		});
		const { vault, storage } = makeVaultHarness();
		await vault.putSecret(keyholderSigningKeyAlias('u1'), new Uint8Array(32).fill(1), { requireUserAuth: true });
		const record = { v: 1 as const, userId: 'u1', inviteSlotCid: 'slot', signingPublicKey: '02'.repeat(33), signingKeyType: 'M' as const, dkgReceivingPublicKey: '03'.repeat(33), createdAt: new Date().toISOString() };
		await storage.setItem('vt.keyholder-identities.v1', JSON.stringify({ v: 1, identities: [record] }));
		const getEngine = asGetEngine(jest.fn(async () => dkgEngine));

		await driveKeyholderDkg({ getEngine, vault, storage }, 'election-1', 'u1');

		expect(dkgEngine.advanceDkg).not.toHaveBeenCalled();
	});

	it('D3: a due local identity (in-progress, participant) calls advanceDkg once with a matching signer', async () => {
		const dkgEngine = makeFakeDkgEngine();
		const { vault, storage, wrapper } = makeVaultHarness();
		await vault.putSecret(keyholderSigningKeyAlias('u1'), new Uint8Array(32).fill(1), { requireUserAuth: true });
		const signingPublicKey = '02' + '11'.repeat(32);
		const record = { v: 1 as const, userId: 'u1', inviteSlotCid: 'slot', signingPublicKey, signingKeyType: 'M' as const, dkgReceivingPublicKey: '03'.repeat(33), createdAt: new Date().toISOString() };
		await storage.setItem('vt.keyholder-identities.v1', JSON.stringify({ v: 1, identities: [record] }));
		const getEngine = asGetEngine(jest.fn(async () => dkgEngine));

		const outcome = await driveKeyholderDkg({ getEngine, vault, storage }, 'election-1', 'u1');

		expect(dkgEngine.advanceDkg).toHaveBeenCalledTimes(1);
		const [, signer] = dkgEngine.advanceDkg.mock.calls[0];
		expect(signer.userId).toBe('u1');
		expect(outcome.advanced).toBe(true);
		expect(outcome.actions).toEqual(['posted-round-1']);
	});

	it('D4a: an advanceDkg auth-denied rejection returns { advanced:false, error.authDenied:true } with the pre-advance status, never throws', async () => {
		const preAdvanceStatus = statusWith({ phase: 'in-progress', self: { userId: 'u1', isParticipant: true, isDisqualified: false, hasShare: false } });
		const dkgEngine = makeFakeDkgEngine({
			getDkgStatus: jest.fn(async () => preAdvanceStatus),
			advanceDkg: jest.fn(async () => {
				throw Object.assign(new Error('nope'), { code: 'auth-denied' });
			}),
		});
		const { vault, storage } = makeVaultHarness();
		await vault.putSecret(keyholderSigningKeyAlias('u1'), new Uint8Array(32).fill(1), { requireUserAuth: true });
		const record = { v: 1 as const, userId: 'u1', inviteSlotCid: 'slot', signingPublicKey: '02'.repeat(33), signingKeyType: 'M' as const, dkgReceivingPublicKey: '03'.repeat(33), createdAt: new Date().toISOString() };
		await storage.setItem('vt.keyholder-identities.v1', JSON.stringify({ v: 1, identities: [record] }));
		const getEngine = asGetEngine(jest.fn(async () => dkgEngine));

		const outcome = await driveKeyholderDkg({ getEngine, vault, storage }, 'election-1', 'u1');

		expect(outcome.advanced).toBe(false);
		expect(outcome.error).toMatchObject({ code: 'auth-denied', authDenied: true });
		expect(outcome.status).toBe(preAdvanceStatus);
	});

	it('D4b: a getDkgStatus rejection returns { status: null, error }, never throws, and the message carries no vault key hex', async () => {
		const dkgEngine = makeFakeDkgEngine({
			getDkgStatus: jest.fn(async () => {
				throw new Error('engine unavailable');
			}),
		});
		const { vault, storage } = makeVaultHarness();
		const getEngine = asGetEngine(jest.fn(async () => dkgEngine));

		const outcome = await driveKeyholderDkg({ getEngine, vault, storage }, 'election-1', undefined);

		expect(outcome.status).toBeNull();
		expect(outcome.error).toBeDefined();
		expect(Object.keys(outcome.error!).sort()).toEqual(['authDenied', 'code']);
		expect(JSON.stringify(outcome)).not.toContain('engine unavailable');
	});

	it('D4c: a getEngine failure and an advanceDkg failure carry no message text either; a peer-unavailable failure classifies by code', async () => {
		const { vault, storage } = makeVaultHarness();
		const failing = asGetEngine(
			jest.fn(async () => {
				throw new Error('vault alias foo');
			})
		);
		const a = await driveKeyholderDkg({ getEngine: failing, vault, storage }, 'election-1', undefined);
		expect(Object.keys(a.error!).sort()).toEqual(['authDenied', 'code']);
		expect(JSON.stringify(a)).not.toContain('vault alias foo');

		const peer = makeFakeDkgEngine({
			getDkgStatus: jest.fn(async () => {
				throw new Error('Block abc is unavailable (cohort-unreachable)');
			}),
		});
		const b = await driveKeyholderDkg({ getEngine: asGetEngine(jest.fn(async () => peer)), vault, storage }, 'election-1', undefined);
		expect(b.error).toEqual({ code: 'peer-unavailable', authDenied: false });
		expect(JSON.stringify(b)).not.toContain('abc');
	});
});

// ---------------------------------------------------------------------------
// R1-R3 — real schema, two devices over one shared DB
// ---------------------------------------------------------------------------

function makeKeyholderInvite(name: string, inviteKey = 'k'.repeat(66)): KeyholderInvite {
	return { name, type: 'k', expiration: new Date(Date.now() + 3_600_000).toISOString(), inviteKey, inviteSignature: '' };
}

/** Builds a fresh election whose revision-0 KeyholderThreshold = `threshold`, mirroring 62-17's
 * `dkg-keyholders.ts` `setKeyholderThreshold` (not a mapped jest path, so replicated here via the
 * mapped test-context fixtures + `/rn`'s `ElectionsEngine`/`peekNextElectionTid`). */
async function seedElectionWithThreshold(threshold: number) {
	const net = await createTestNetwork();
	const auth = await addTestAuthority(net);
	const electionsEngine = new ElectionsEngine(auth.ctx);
	const init = makeElectionInit({ authorityId: auth.authority.id });
	init.revision.keyholderThreshold = threshold;
	const { election: e } = init;
	const pastRevTimestamp = Date.now() - 1000;
	const electionFields = {
		id: e.id,
		authorityId: e.authorityId,
		title: e.title,
		date: e.date,
		revisionDeadline: e.revisionDeadline,
		ballotDeadline: e.ballotDeadline,
		type: e.type,
	};
	const sign = makeTestSignCallback(auth.user);
	const signingNonce = await electionsEngine.seedElectionSigning(electionFields, sign);
	const revTid = (await peekNextElectionTid(auth.ctx.db)) + 1;
	const revisionSigningNonce = await (
		electionsEngine as unknown as {
			seedElectionRevisionSigning(
				electionId: string,
				authorityId: string,
				revision: { revision: number; revisionTimestamp: number; tags: string[]; instructions: string; timeline: Record<string, number>; keyholderThreshold: number },
				tid: number,
				sign: (digest: Uint8Array) => Promise<Signature>
			): Promise<string>;
		}
	).seedElectionRevisionSigning(
		e.id,
		e.authorityId,
		{
			revision: 0,
			revisionTimestamp: pastRevTimestamp,
			tags: init.revision.tags,
			instructions: init.revision.instructions,
			timeline: init.revision.timeline as Record<string, number>,
			keyholderThreshold: threshold,
		},
		revTid,
		sign
	);
	const initWithPastTs = { ...init, revision: { ...init.revision, revisionTimestamp: pastRevTimestamp } };
	await electionsEngine.createElection(initWithPastTs, { signingNonce, revisionSigningNonce });
	const electionEngine = await electionsEngine.openElection(e.id);
	return { auth, electionsEngine, electionEngine, electionId: e.id };
}

interface Device {
	userId: string;
	vault: ReturnType<typeof createAuthorityKeyVault>;
	storage: ReturnType<typeof createMapStorage>;
	wrapper: ReturnType<typeof createFakeSecretWrapper>;
}

async function acceptOnDevice(
	seeded: Awaited<ReturnType<typeof seedElectionWithThreshold>>,
	name: string
): Promise<Device> {
	const invitationEngine = new InvitationEngine(inviteeCtx(seeded.auth.ctx));
	const privBytes = secp256k1.utils.randomSecretKey();
	const invitePrivate = bytesToHex(privBytes);
	const inviteKey = bytesToHex(secp256k1.getPublicKey(privBytes));
	await seeded.electionEngine.inviteKeyholder(makeKeyholderInvite(name, inviteKey), seeded.electionId, makeTestSignCallback(seeded.auth.user));
	const shareText = JSON.stringify({ invitePrivate, inviteKey, expiration: 'x', type: 'k', name });

	const wrapper = createFakeSecretWrapper();
	const vault = createAuthorityKeyVault({
		wrapper,
		storage: createMapStorage() as unknown as KeyVaultStorage,
		authRequiredWrap: { keyAlias: VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1, prompt: keyholderVaultPrompt },
	});
	const storage = createMapStorage();

	const { userId } = await acceptKeyholderInvitation({ invitationEngine, vault, storage }, shareText);
	return { userId, vault, storage, wrapper };
}

describe('driveKeyholderDkg over the REAL schema (R1-R3)', () => {
	it('R1 (D-19/D-16): two devices drive a 2-of-2 DKG to one ElectionKey by alternating driveKeyholderDkg calls; each vault holds only its own share', async () => {
		const seeded = await seedElectionWithThreshold(2);
		const deviceA = await acceptOnDevice(seeded, 'Alice');
		const deviceB = await acceptOnDevice(seeded, 'Bob');

		const getEngineFor = (vault: ReturnType<typeof createAuthorityKeyVault>) =>
			asGetEngine(jest.fn(async () => new KeyholderDkgEngine(seeded.auth.ctx, { vault })));

		const deps = [
			{ getEngine: getEngineFor(deviceA.vault), vault: deviceA.vault, storage: deviceA.storage, device: deviceA },
			{ getEngine: getEngineFor(deviceB.vault), vault: deviceB.vault, storage: deviceB.storage, device: deviceB },
		];

		const start = Date.now();
		let lastStatus: KeyholderDkgStatus | null = null;
		for (let pass = 0; pass < 20; pass++) {
			let anyAdvanced = false;
			for (const d of deps) {
				const outcome = await driveKeyholderDkg({ getEngine: d.getEngine, vault: d.vault, storage: d.storage }, seeded.electionId, d.device.userId);
				expect(outcome.error).toBeUndefined();
				if (outcome.advanced) anyAdvanced = true;
				if (outcome.status) lastStatus = outcome.status;
			}
			if (lastStatus?.phase === 'complete') break;
			if (!anyAdvanced && pass > 1) break;
		}
		const durationMs = Date.now() - start;

		expect(lastStatus?.phase).toBe('complete');
		expect(lastStatus?.threshold).toBe(2);

		const dkgEngine = new KeyholderDkgEngine(seeded.auth.ctx, { vault: deviceA.vault });
		const electionKey = await dkgEngine.getElectionKey(seeded.electionId);
		expect(electionKey).not.toBeNull();
		expect(electionKey?.threshold).toBe(2);
		expect(electionKey?.participants).toBe(2);

		const revision = electionKey!.revision;
		expect(await deviceA.vault.hasSecret(keyholderDkgShareAlias(seeded.electionId, revision, deviceA.userId))).toBe(true);
		expect(await deviceA.vault.hasSecret(keyholderDkgShareAlias(seeded.electionId, revision, deviceB.userId))).toBe(false);
		expect(await deviceB.vault.hasSecret(keyholderDkgShareAlias(seeded.electionId, revision, deviceB.userId))).toBe(true);
		expect(await deviceB.vault.hasSecret(keyholderDkgShareAlias(seeded.electionId, revision, deviceA.userId))).toBe(false);

		const rows = [];
		for await (const row of seeded.auth.ctx.db.eval('select SenderUserId, SenderKey from KeyholderDkgMessage')) {
			rows.push(row);
		}
		expect(rows.length).toBeGreaterThan(0);
		const recordA = await getKeyholderIdentity(deviceA.userId, deviceA.storage);
		const recordB = await getKeyholderIdentity(deviceB.userId, deviceB.storage);
		for (const row of rows) {
			const expectedKey = row.SenderUserId === deviceA.userId ? recordA!.signingPublicKey : recordB!.signingPublicKey;
			expect(row.SenderKey).toBe(expectedKey);
		}
		const senders = new Set(rows.map((r) => r.SenderUserId));
		expect(senders.has(deviceA.userId)).toBe(true);
		expect(senders.has(deviceB.userId)).toBe(true);

		// eslint-disable-next-line no-console
		console.info(`R1 measured duration: ${durationMs}ms`);
	});

	it('R2 prompt budget: a further drive after completion performs 0 auth-required vault operations and 0 actions', async () => {
		const seeded = await seedElectionWithThreshold(2);
		const deviceA = await acceptOnDevice(seeded, 'Carol');
		const deviceB = await acceptOnDevice(seeded, 'Dave');
		const deps = [deviceA, deviceB].map((d) => ({
			device: d,
			getEngine: asGetEngine(jest.fn(async () => new KeyholderDkgEngine(seeded.auth.ctx, { vault: d.vault }))),
		}));

		let lastStatus: KeyholderDkgStatus | null = null;
		for (let pass = 0; pass < 20 && lastStatus?.phase !== 'complete'; pass++) {
			for (const d of deps) {
				const outcome = await driveKeyholderDkg({ getEngine: d.getEngine, vault: d.device.vault, storage: d.device.storage }, seeded.electionId, d.device.userId);
				if (outcome.status) lastStatus = outcome.status;
			}
		}
		expect(lastStatus?.phase).toBe('complete');

		const wrapsBefore = deviceA.wrapper.authWraps + deviceA.wrapper.authUnwraps;
		const outcome = await driveKeyholderDkg({ getEngine: deps[0]!.getEngine, vault: deviceA.vault, storage: deviceA.storage }, seeded.electionId, deviceA.userId);
		expect(outcome.advanced).toBe(false);
		expect(outcome.actions).toEqual([]);
		expect(deviceA.wrapper.authWraps + deviceA.wrapper.authUnwraps).toBe(wrapsBefore);
	});

	it('R3 officer view: a keyholderUserId with no identity on this device performs 0 auth-required operations', async () => {
		const seeded = await seedElectionWithThreshold(2);
		const deviceA = await acceptOnDevice(seeded, 'Erin');
		const deviceB = await acceptOnDevice(seeded, 'Frank');

		const before = deviceA.wrapper.authWraps + deviceA.wrapper.authUnwraps;
		const getEngine = asGetEngine(jest.fn(async () => new KeyholderDkgEngine(seeded.auth.ctx, { vault: deviceA.vault })));
		const outcome = await driveKeyholderDkg({ getEngine, vault: deviceA.vault, storage: deviceA.storage }, seeded.electionId, deviceB.userId);

		expect(outcome.advanced).toBe(false);
		expect(deviceA.wrapper.authWraps + deviceA.wrapper.authUnwraps).toBe(before);
	});
});
