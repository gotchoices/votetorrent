/**
 * key-release-ceremony.realschema.test.ts — RS1-RS5 (D-17, D-20). Two app identities on two
 * vaults/storages (each over its own fake secret wrapper, so unwrap counts are real) share one real
 * Quereus DB, complete a 2-of-2 DKG through this app's accept + driver code (the 62-26 R1 seed,
 * copied here because that test file is not ours to edit), then release through the ceremony.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import { ElectionsEngine, InvitationEngine, KeyholderDkgEngine, KeyReleaseEngine, KeysTasksEngine, peekNextElectionTid, releasingKeysAt } from '@votetorrent/vote-engine/rn';
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
import { createFakeSecretWrapper, createMapStorage } from '../../../engines/__fixtures__/fake-secret-wrapper';
import { getKeyholderIdentity, listKeyholderIdentities } from '../../../engines/keyholder-identity';
import { acceptKeyholderInvitation } from '../keyholder-accept';
import { driveKeyholderDkg } from '../keyholder-dkg-driver';
import { releaseKeyholderShare } from '../key-release-ceremony';

/**
 * A keyholder's own device context: the same strand db, no officer identity. The keyholder who accepts is never
 * the inviting officer (self-invite refusal, 62-103), so every 'k' accept runs on this context; slot creation
 * and reads may keep the inviter's context.
 */
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
	userId: string;
	vault: ReturnType<typeof createAuthorityKeyVault>;
	storage: ReturnType<typeof createMapStorage>;
	wrapper: ReturnType<typeof createFakeSecretWrapper>;
}

async function acceptOnDevice(
	seeded: Awaited<ReturnType<typeof seedElectionWithThreshold>>,
	name: string,
	reuse?: Device
): Promise<Device> {
	const invitationEngine = new InvitationEngine(inviteeCtx(seeded.auth.ctx));
	const privBytes = secp256k1.utils.randomSecretKey();
	const invitePrivate = bytesToHex(privBytes);
	const inviteKey = bytesToHex(secp256k1.getPublicKey(privBytes));
	await seeded.electionEngine.inviteKeyholder(makeKeyholderInvite(name, inviteKey), seeded.electionId, makeTestSignCallback(seeded.auth.user));
	const shareText = JSON.stringify({ invitePrivate, inviteKey, expiration: 'x', type: 'k', name });

	// Each simulated keyholder device owns its vault and storage (one seat per device per election).
	const wrapper = reuse?.wrapper ?? createFakeSecretWrapper();
	const vault =
		reuse?.vault ??
		createAuthorityKeyVault({
			wrapper,
			storage: createMapStorage() as unknown as KeyVaultStorage,
			authRequiredWrap: { keyAlias: VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1, prompt: keyholderVaultPrompt },
		});
	const storage = reuse?.storage ?? createMapStorage();
	const { userId } = await acceptKeyholderInvitation({ invitationEngine, vault, storage }, shareText);
	return { userId, vault, storage, wrapper };
}

async function countRows(db: { prepare(sql: string): { get(p: Record<string, unknown>): Promise<Record<string, unknown> | undefined> } }, sql: string, params: Record<string, unknown> = {}): Promise<number> {
	const row = await db.prepare(sql).get(params);
	return (row?.c as number | undefined) ?? 0;
}

describe('key release ceremony over the REAL schema (RS1-RS5)', () => {
	let seeded: Awaited<ReturnType<typeof seedElectionWithThreshold>>;
	let deviceA: Device;
	let deviceB: Device;
	let at: number;
	let setupMs = 0;

	const networkRef = { hash: 'h'.repeat(16), name: 'Test Network', relays: [], primaryAuthorityDomainName: 'authority.example.com' };

	const tasksEngineFor = (d: Device, now: () => number) => new KeysTasksEngine(networkRef as never, seeded.auth.ctx, { vault: d.vault, now });
	const ceremonyDeps = (d: Device, engine: unknown) => ({ getEngine: asGetEngine(engine), vault: d.vault, storage: d.storage });

	beforeAll(async () => {
		const start = Date.now();
		seeded = await seedElectionWithThreshold(2);
		deviceA = await acceptOnDevice(seeded, 'Alice');
		deviceB = await acceptOnDevice(seeded, 'Bob');
		const devices = [deviceA, deviceB];
		let lastStatus: KeyholderDkgStatus | null = null;
		for (let pass = 0; pass < 20 && lastStatus?.phase !== 'complete'; pass++) {
			for (const d of devices) {
				const dkg = new KeyholderDkgEngine(seeded.auth.ctx, { vault: d.vault });
				const outcome = await driveKeyholderDkg({ getEngine: asGetEngine(dkg), vault: d.vault, storage: d.storage }, seeded.electionId, d.userId);
				if (outcome.status) lastStatus = outcome.status;
			}
		}
		expect(lastStatus?.phase).toBe('complete');

		const row = await seeded.auth.ctx.db.prepare('select Timeline from ElectionRevision where ElectionId = :id').get({ id: seeded.electionId });
		const timeline = JSON.parse(row!.Timeline as string) as Record<string, number>;
		const releaseAt = releasingKeysAt(timeline as never);
		if (releaseAt === null) throw new Error('fixture has no releasingKeys');
		at = releaseAt;
		setupMs = Date.now() - start;
	});

	it('RS1 D-20: no release task exists one millisecond before releasingKeys', async () => {
		for (const d of [deviceA, deviceB]) {
			const tasks = await tasksEngineFor(d, () => at - 1).getKeysToRelease(true);
			expect(tasks).toEqual([]);
		}
		expect(await countRows(seeded.auth.ctx.db, 'select count(*) as c from KeyholderShareRelease')).toBe(0);
	});

	let taskA: ReleaseKeyTask;
	let taskB: ReleaseKeyTask;

	it('RS2 D-17: each device releases exactly once through the ceremony: 2 auth unwraps, own userId and signing key, task completed', async () => {
		const engineA = tasksEngineFor(deviceA, () => at);
		const engineB = tasksEngineFor(deviceB, () => at);

		const tasksA = await engineA.getKeysToRelease(true);
		expect(tasksA).toHaveLength(1);
		taskA = tasksA[0] as ReleaseKeyTask;
		expect(taskA.userId).toBe(deviceA.userId);
		const tasksB = await engineB.getKeysToRelease(true);
		expect(tasksB).toHaveLength(1);
		taskB = tasksB[0] as ReleaseKeyTask;
		expect(taskB.userId).toBe(deviceB.userId);

		for (const [d, task, engine] of [
			[deviceA, taskA, engineA],
			[deviceB, taskB, engineB],
		] as const) {
			const unwrapsBefore = d.wrapper.authUnwraps;
			const outcome = await releaseKeyholderShare(ceremonyDeps(d, engine), task);
			expect(outcome).toEqual({ kind: 'released' });
			expect(d.wrapper.authUnwraps - unwrapsBefore).toBe(2);

			const identity = await getKeyholderIdentity(d.userId, d.storage);
			const row = await seeded.auth.ctx.db
				.prepare('select SignerKey from KeyholderShareRelease where ElectionId = :e and UserId = :u')
				.get({ e: seeded.electionId, u: d.userId });
			expect(row?.SignerKey).toBe(identity!.signingPublicKey);
			const taskRow = await seeded.auth.ctx.db.prepare("select IsCompleted from Task where UserId = :u and Type = 'release-key'").get({ u: d.userId });
			expect(taskRow?.IsCompleted).toBe(1);
		}
		expect(await countRows(seeded.auth.ctx.db, 'select count(*) as c from KeyholderShareRelease')).toBe(2);
	});

	it('RS3 public reconstruction: a no-vault, no-user engine reports reconstructable with both releases and the published joint key', async () => {
		const engine = new KeyReleaseEngine({ db: seeded.auth.ctx.db } as never);
		const status = await engine.getKeyReleaseStatus(seeded.electionId);
		expect(status.phase).toBe('reconstructable');
		expect(status.releasedCount).toBe(2);
		expect([...status.releasedUserIds].sort()).toEqual([deviceA.userId, deviceB.userId].sort());

		const reconstructed = await engine.reconstructElectionKey(seeded.electionId);
		const keyRow = await seeded.auth.ctx.db.prepare('select JointPublicKey from ElectionKey where ElectionId = :e').get({ e: seeded.electionId });
		expect(reconstructed.jointPublicKey).toBe(keyRow!.JointPublicKey);
	});

	it('RS4 idempotent: a second ceremony run on a released task resolves released with 0 additional unwraps and no new row', async () => {
		const unwrapsBefore = deviceA.wrapper.unwrapCalls;
		const outcome = await releaseKeyholderShare(ceremonyDeps(deviceA, tasksEngineFor(deviceA, () => at)), taskA);

		expect(outcome).toEqual({ kind: 'released' });
		expect(deviceA.wrapper.unwrapCalls - unwrapsBefore).toBe(0);
		expect(await countRows(seeded.auth.ctx.db, 'select count(*) as c from KeyholderShareRelease')).toBe(2);
	});

	it('RS5 wrong device: running A\'s task through B\'s deps fails identity-not-found with 0 unwraps and no new row', async () => {
		const unwrapsBefore = deviceB.wrapper.unwrapCalls;
		const outcome = await releaseKeyholderShare(ceremonyDeps(deviceB, tasksEngineFor(deviceB, () => at)), taskA);

		expect(outcome).toEqual({ kind: 'failed', code: 'identity-not-found', authDenied: false });
		expect(deviceB.wrapper.unwrapCalls - unwrapsBefore).toBe(0);
		expect(await countRows(seeded.auth.ctx.db, 'select count(*) as c from KeyholderShareRelease')).toBe(2);
		// eslint-disable-next-line no-console
		console.info(`RS setup (accept + 2-of-2 DKG) duration: ${setupMs}ms`);
	});

	it('RS6 negative control: a third accept on device A\'s own storage is refused seat-already-held, with no extra wrap', async () => {
		const wrapsBefore = deviceA.wrapper.authWraps;
		await expect(acceptOnDevice(seeded, 'Cleo', deviceA)).rejects.toMatchObject({ code: 'seat-already-held' });
		expect(deviceA.wrapper.authWraps).toBe(wrapsBefore);
		expect(await listKeyholderIdentities(deviceA.storage)).toHaveLength(1);
	});
});
