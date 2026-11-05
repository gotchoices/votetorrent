/**
 * keyholder-seat-batching.realschema.test.ts — prompt batching, Tier 1, end to end over the REAL schema.
 * Two keyholder devices (each its own fake wrapper, storage and seat vault) share one real Quereus DB and run
 * accept -> 2-of-2 DKG -> release through this app's own accept, driver and ceremony code. A prompt is one
 * auth-required native wrap or unwrap (`authWraps + authUnwraps`).
 *
 * Budget asserted per device, sealed seat (the default build): accept 0, every DKG drive that signs a row exactly
 * 1 (any other drive 0), release 1. Wrap-only seat (no sealer: an older binary, or no secure hardware): accept 1,
 * the rest the same. Before batching the same run cost 2 + 13-14 + 2.
 * B2 drives one LEGACY seat (accepted on the per-alias vault, i.e. before this change) and one new seat in the
 * same DKG, so an election already in flight on an upgraded phone still completes and releases.
 * The seed below is copied from `key-release-ceremony.realschema.test.ts` (not a mapped helper path).
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import { ElectionsEngine, InvitationEngine, KeyholderDkgEngine, KeysTasksEngine, keyholderDkgShareAlias, peekNextElectionTid, releasingKeysAt } from '@votetorrent/vote-engine/rn';
import type { IKeyVault } from '@votetorrent/vote-engine/rn';
import {
	addTestAuthority,
	createTestNetwork,
	makeElectionInit,
	makeTestSignCallback,
} from '@votetorrent/vote-engine/test/fixtures/test-context';
import type { KeyholderDkgStatus, KeyholderInvite, ReleaseKeyTask, Signature } from '@votetorrent/vote-core';
import { createAuthorityKeyVault } from '../../../engines/key-vault';
import type { KeyVaultStorage } from '../../../engines/key-vault';
import { VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1, keyholderVaultPrompt } from '../../../engines/keyholder-vault';
import { KEYHOLDER_SEAT_KEY_STORAGE_PREFIX, createKeyholderSeatVault } from '../../../engines/keyholder-seat-vault';
import { createFakeSecretSealer, createFakeSecretWrapper, createMapStorage } from '../../../engines/__fixtures__/fake-secret-wrapper';
import { acceptKeyholderInvitation } from '../keyholder-accept';
import { driveKeyholderDkg } from '../keyholder-dkg-driver';
import { releaseKeyholderShare } from '../key-release-ceremony';

const inviteeCtx = <C extends { db: unknown }>(ctx: C): C => ({ db: ctx.db }) as unknown as C;

jest.setTimeout(120_000);

function asGetEngine<E>(engine: E): <T>(engineName: string) => Promise<T> {
	return (async () => engine) as unknown as <T>(engineName: string) => Promise<T>;
}

function makeKeyholderInvite(name: string, inviteKey = 'k'.repeat(66)): KeyholderInvite {
	return { name, type: 'k', expiration: new Date(Date.now() + 3_600_000).toISOString(), inviteKey, inviteSignature: '' };
}

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
	name: string;
	userId: string;
	vault: IKeyVault;
	storage: ReturnType<typeof createMapStorage>;
	vaultStorage: ReturnType<typeof createMapStorage>;
	wrapper: ReturnType<typeof createFakeSecretWrapper>;
	prompts: () => number;
	acceptPrompts: number;
	drivePrompts: number[];
}

/** `sealed`: the default build. `wrap`: a seat vault with no sealer. `legacy`: the seat is accepted on the plain
 * per-alias vault (the pre-batching app) and driven later on the sealed seat vault over the SAME storage, i.e. an
 * upgraded phone. */
type Mode = 'sealed' | 'wrap' | 'legacy';

async function acceptOnDevice(seeded: Awaited<ReturnType<typeof seedElectionWithThreshold>>, name: string, mode: Mode = 'sealed'): Promise<Device> {
	const invitationEngine = new InvitationEngine(inviteeCtx(seeded.auth.ctx));
	const privBytes = secp256k1.utils.randomSecretKey();
	const invitePrivate = bytesToHex(privBytes);
	const inviteKey = bytesToHex(secp256k1.getPublicKey(privBytes));
	await seeded.electionEngine.inviteKeyholder(makeKeyholderInvite(name, inviteKey), seeded.electionId, makeTestSignCallback(seeded.auth.user));
	const shareText = JSON.stringify({ invitePrivate, inviteKey, expiration: 'x', type: 'k', name });

	const wrapper = createFakeSecretWrapper();
	const sealer = createFakeSecretSealer();
	const vaultStorage = createMapStorage();
	const inner = createAuthorityKeyVault({
		wrapper,
		storage: vaultStorage as unknown as KeyVaultStorage,
		authRequiredWrap: { keyAlias: VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1, prompt: keyholderVaultPrompt },
	});
	const seatVault = createKeyholderSeatVault({
		inner,
		wrapper,
		storage: vaultStorage as unknown as KeyVaultStorage,
		wrapKeyAlias: VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1,
		prompt: keyholderVaultPrompt,
		...(mode === 'wrap' ? {} : { sealer }),
	});
	const storage = createMapStorage();
	const prompts = () => wrapper.authWraps + wrapper.authUnwraps + sealer.unsealCalls;
	const { userId } = await acceptKeyholderInvitation({ invitationEngine, vault: mode === 'legacy' ? inner : seatVault, storage }, shareText);
	return { name, userId, vault: seatVault, storage, vaultStorage, wrapper, prompts, acceptPrompts: prompts(), drivePrompts: [] };
}

async function driveToComplete(
	seeded: Awaited<ReturnType<typeof seedElectionWithThreshold>>,
	budgeted: Device[],
	unbudgeted: Device[] = []
): Promise<KeyholderDkgStatus | null> {
	let lastStatus: KeyholderDkgStatus | null = null;
	for (let pass = 0; pass < 20 && lastStatus?.phase !== 'complete'; pass++) {
		for (const d of [...unbudgeted, ...budgeted]) {
			const checked = budgeted.includes(d);
			const dkg = new KeyholderDkgEngine(seeded.auth.ctx, { vault: d.vault });
			const before = d.prompts();
			const outcome = await driveKeyholderDkg({ getEngine: asGetEngine(dkg), vault: d.vault, storage: d.storage }, seeded.electionId, d.userId);
			expect(outcome.error).toBeUndefined();
			const used = d.prompts() - before;
			// A drive that signs a row (posted-*/published-*) costs exactly one prompt; any other drive (nothing due,
			// or only a vault sweep) costs none.
			const signedSomething = outcome.actions.some((a) => a.startsWith('posted-') || a === 'published-election-key');
			if (checked) expect(used).toBe(signedSomething ? 1 : 0);
			if (signedSomething) d.drivePrompts.push(used);
			if (outcome.status) lastStatus = outcome.status;
		}
	}
	return lastStatus;
}

async function releaseAll(seeded: Awaited<ReturnType<typeof seedElectionWithThreshold>>, devices: Device[]): Promise<number[]> {
	const row = await seeded.auth.ctx.db.prepare('select Timeline from ElectionRevision where ElectionId = :id').get({ id: seeded.electionId });
	const at = releasingKeysAt(JSON.parse(row!.Timeline as string) as never);
	if (at === null) throw new Error('fixture has no releasingKeys');
	const networkRef = { hash: 'h'.repeat(16), name: 'Test Network', relays: [], primaryAuthorityDomainName: 'authority.example.com' };
	const used: number[] = [];
	for (const d of devices) {
		const engine = new KeysTasksEngine(networkRef as never, seeded.auth.ctx, { vault: d.vault, now: () => at });
		const tasks = await engine.getKeysToRelease(true);
		expect(tasks).toHaveLength(1);
		const before = d.prompts();
		const outcome = await releaseKeyholderShare({ getEngine: asGetEngine(engine), vault: d.vault, storage: d.storage }, tasks[0] as ReleaseKeyTask);
		expect(outcome).toEqual({ kind: 'released' });
		used.push(d.prompts() - before);
	}
	return used;
}

describe('keyholder prompt batching over the REAL schema', () => {
	it.each([
		['sealed', 0],
		['wrap', 1],
	] as const)('B1 two new %s seats: accept %i prompt(s), each signing DKG drive exactly 1, release 1 — per device', async (mode, acceptBudget) => {
		const seeded = await seedElectionWithThreshold(2);
		const devices = [await acceptOnDevice(seeded, 'Alice', mode), await acceptOnDevice(seeded, 'Bob', mode)];
		for (const d of devices) {
			expect(d.acceptPrompts).toBe(acceptBudget);
			expect(await d.vaultStorage.getItem(KEYHOLDER_SEAT_KEY_STORAGE_PREFIX + d.userId)).not.toBeNull();
		}

		const status = await driveToComplete(seeded, devices);
		expect(status?.phase).toBe('complete');
		const electionKey = await new KeyholderDkgEngine(seeded.auth.ctx, { vault: devices[0]!.vault }).getElectionKey(seeded.electionId);
		expect(electionKey).not.toBeNull();
		for (const d of devices) {
			expect(d.drivePrompts.length).toBeGreaterThan(0);
			for (const p of d.drivePrompts) expect(p).toBe(1);
			expect(await d.vault.hasSecret(keyholderDkgShareAlias(seeded.electionId, electionKey!.revision, d.userId))).toBe(true);
		}

		const releasePrompts = await releaseAll(seeded, devices);
		expect(releasePrompts).toEqual([1, 1]);
		const releases = await seeded.auth.ctx.db.prepare('select count(*) as c from KeyholderShareRelease').get({});
		expect(releases?.c).toBe(2);

		const summary = devices.map((d, i) => `${d.name}: accept ${d.acceptPrompts}, DKG drives [${d.drivePrompts.join(', ')}], release ${releasePrompts[i]}, total ${d.acceptPrompts + d.drivePrompts.reduce((a, b) => a + b, 0) + releasePrompts[i]!}`);
		// eslint-disable-next-line no-console
		console.info(`B1 (${mode}) prompts per device: ${summary.join(' | ')}`);
	});

	it('B2 a legacy seat (accepted before batching) and a new seat finish one DKG and both release', async () => {
		const seeded = await seedElectionWithThreshold(2);
		const legacy = await acceptOnDevice(seeded, 'Carol', 'legacy');
		const fresh = await acceptOnDevice(seeded, 'Dave', 'sealed');
		expect(legacy.acceptPrompts).toBe(2);
		expect(fresh.acceptPrompts).toBe(0);
		expect(await legacy.vaultStorage.getItem(KEYHOLDER_SEAT_KEY_STORAGE_PREFIX + legacy.userId)).toBeNull();

		// The legacy device keeps per-operation prompts, so only the new seat's drives are budget-checked.
		const status = await driveToComplete(seeded, [fresh], [legacy]);
		expect(status?.phase).toBe('complete');
		expect(fresh.drivePrompts.length).toBeGreaterThan(0);
		// The legacy seat never gained a seat key: its secrets stayed on the per-alias path.
		expect(await legacy.vaultStorage.getItem(KEYHOLDER_SEAT_KEY_STORAGE_PREFIX + legacy.userId)).toBeNull();

		const releasePrompts = await releaseAll(seeded, [legacy, fresh]);
		expect(releasePrompts).toEqual([2, 1]);

		const total = (d: Device, release: number) => d.acceptPrompts + d.drivePrompts.reduce((a, b) => a + b, 0) + release;
		// eslint-disable-next-line no-console
		console.info(
			`B2 prompts per device: legacy ${legacy.name}: accept ${legacy.acceptPrompts}, DKG drives [${legacy.drivePrompts.join(', ')}], release ${releasePrompts[0]}, total ${total(legacy, releasePrompts[0]!)}` +
				` | new ${fresh.name}: accept ${fresh.acceptPrompts}, DKG drives [${fresh.drivePrompts.join(', ')}], release ${releasePrompts[1]}, total ${total(fresh, releasePrompts[1]!)}`
		);
	});
});
