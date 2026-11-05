/**
 * keyholder-reaccept.realschema.test.ts — R1 (D-21, D-26, D-19). A keyholder who accepted an earlier revision of an
 * election accepts a new invitation on the SAME device after a signed revision bump (the user's re-accept ruling),
 * while a device can never hold two live seats of one revision. Real schema, real engines, one storage per simulated
 * device. The signed bump copies the statements of the engine fixture `bumpElectionRevision` (there is no product
 * path that bumps ElectionRevision), signed with the officer's test signer.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import { ElectionsEngine, InvitationEngine, KeyholderDkgEngine, SigningEngine, peekNextElectionTid } from '@votetorrent/vote-engine/rn';
import {
	addTestAuthority,
	createTestNetwork,
	makeElectionInit,
	makeTestSignCallback,
} from '@votetorrent/vote-engine/test/fixtures/test-context';
import type { KeyholderInvite, Signature } from '@votetorrent/vote-core';
import { createAuthorityKeyVault } from '../../../engines/key-vault';
import type { KeyVaultStorage } from '../../../engines/key-vault';
import { VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1, keyholderVaultPrompt } from '../../../engines/keyholder-vault';
import { createFakeSecretWrapper, createMapStorage } from '../../../engines/__fixtures__/fake-secret-wrapper';
import { listKeyholderIdentities } from '../../../engines/keyholder-identity';
import { acceptKeyholderInvitation } from '../keyholder-accept';

jest.setTimeout(120_000);

/** A keyholder's own device context: the same strand db, no officer identity. */
const inviteeCtx = <C extends { db: unknown }>(ctx: C): C => ({ db: ctx.db }) as unknown as C;

async function seedElection() {
	const net = await createTestNetwork();
	const auth = await addTestAuthority(net);
	const electionsEngine = new ElectionsEngine(auth.ctx);
	const init = makeElectionInit({ authorityId: auth.authority.id });
	init.revision.keyholderThreshold = 2;
	const { election: e } = init;
	const pastRevTimestamp = Date.now() - 1000;
	const sign = makeTestSignCallback(auth.user);
	const signingNonce = await electionsEngine.seedElectionSigning(
		{ id: e.id, authorityId: e.authorityId, title: e.title, date: e.date, revisionDeadline: e.revisionDeadline, ballotDeadline: e.ballotDeadline, type: e.type },
		sign
	);
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
			keyholderThreshold: 2,
		},
		revTid,
		sign
	);
	await electionsEngine.createElection({ ...init, revision: { ...init.revision, revisionTimestamp: pastRevTimestamp } }, { signingNonce, revisionSigningNonce });
	const electionEngine = await electionsEngine.openElection(e.id);
	return { auth, electionsEngine, electionEngine, electionId: e.id };
}

type Seeded = Awaited<ReturnType<typeof seedElection>>;

/** The canonical datetime form is UTC without a 'Z' suffix. */
const fromCanonical = (v: string): number => new Date(`${v}Z`).getTime();
const toCanonical = (ms: number): string => new Date(ms).toISOString().slice(0, 19);

/** Copy of the engine fixture bumpElectionRevision: a real signed AdminSigning + `update ElectionRevision`. */
async function bumpRevision(seeded: Seeded): Promise<number> {
	const { auth, electionId } = seeded;
	const db = auth.ctx.db;
	const authorityId = auth.authority.id;
	const revRow = await db
		.prepare('select ElectionId, Revision, RevisionTimestamp, Tags, Instructions, Timeline, KeyholderThreshold from ElectionRevision where ElectionId = :electionId')
		.get({ electionId });
	if (!revRow) throw new Error('bumpRevision: ElectionRevision not found');
	const newRevision = (revRow.Revision as number) + 1;
	const oldMs = fromCanonical(revRow.RevisionTimestamp as string);
	const revTimestamp = toCanonical(oldMs + 1000);
	const now = toCanonical(oldMs + 2000);
	const digestParams = {
		electionId,
		revision: newRevision,
		revTimestamp,
		tags: revRow.Tags as string,
		instructions: revRow.Instructions as string,
		timeline: revRow.Timeline as string,
		keyholderThreshold: revRow.KeyholderThreshold as number,
	};
	const tid = (await peekNextElectionTid(db)) + 1;
	const digestRow = await db
		.prepare('select Digest(:tid, :electionId, :revision, :revTimestamp, :tags, :instructions, :timeline, :keyholderThreshold) as d')
		.get({ ...digestParams, tid });
	if (!digestRow || digestRow.d == null) throw new Error('bumpRevision: Digest() returned null');
	const sig = await makeTestSignCallback(auth.user)(new Uint8Array(Buffer.from(digestRow.d as string, 'base64url')));
	const adminRow = await db.prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId').get({ authorityId });
	if (!adminRow) throw new Error('bumpRevision: CurrentAdmin not found');
	const nonce = crypto.randomUUID();
	await db.exec(
		`insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
		 with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = false
		 values (:nonce, :authorityId, :adminEffectiveAt, 'mel',
		   Digest(:tid, :electionId, :revision, :revTimestamp, :tags, :instructions, :timeline, :keyholderThreshold),
		   :userId, :signerKey, :signature)`,
		{ ...digestParams, tid, nonce, authorityId, adminEffectiveAt: adminRow.EffectiveAt as number | string, userId: auth.user.id, signerKey: sig.signerKey, signature: sig.signature, now }
	);
	await new SigningEngine(auth.ctx).sign(nonce, sig);
	await db.exec(
		`update ElectionRevision with context SigningNonce = :nonce, Tid = ${tid}, now = :now
		   set Revision = :revision, RevisionTimestamp = :revTimestamp where ElectionId = :electionId`,
		{ ...digestParams, nonce, now }
	);
	return newRevision;
}

function makeDevice() {
	const wrapper = createFakeSecretWrapper();
	const vault = createAuthorityKeyVault({
		wrapper,
		storage: createMapStorage() as unknown as KeyVaultStorage,
		authRequiredWrap: { keyAlias: VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1, prompt: keyholderVaultPrompt },
	});
	return { wrapper, vault, storage: createMapStorage() };
}
type Device = ReturnType<typeof makeDevice>;

async function invite(seeded: Seeded, name: string): Promise<string> {
	const priv = bytesToHex(secp256k1.utils.randomSecretKey());
	const inviteKey = bytesToHex(secp256k1.getPublicKey(Uint8Array.from(Buffer.from(priv, 'hex'))));
	const keyholder: KeyholderInvite = { name, type: 'k', expiration: new Date(Date.now() + 3_600_000).toISOString(), inviteKey, inviteSignature: '' };
	await seeded.electionEngine.inviteKeyholder(keyholder, seeded.electionId, makeTestSignCallback(seeded.auth.user));
	return JSON.stringify({ invitePrivate: priv, inviteKey, expiration: 'x', type: 'k', name });
}

describe('keyholder re-accept after a signed revision bump (R1, real schema)', () => {
	it('R1: the same device accepts again after the bump; a second live seat is still refused', async () => {
		const seeded = await seedElection();
		const S = makeDevice();
		const T = makeDevice();
		const invitationEngine = new InvitationEngine(inviteeCtx(seeded.auth.ctx));
		const readKeyholderSeatFacts = async (electionId: string) => {
			const s = await new KeyholderDkgEngine(seeded.auth.ctx, { vault: S.vault }).getDkgStatus(electionId);
			return { revision: s.revision, liveRoster: s.liveRoster, earlierRevisionUserIds: s.earlierRevisionUserIds };
		};
		const accept = (d: Device, share: string) => acceptKeyholderInvitation({ invitationEngine, vault: d.vault, storage: d.storage, readKeyholderSeatFacts }, share);

		const first = await accept(S, await invite(seeded, 'K'));
		await accept(T, await invite(seeded, 'L'));

		// While the seat is live, a further invitation on S is refused with no prompt.
		const wrapsBefore = S.wrapper.authWraps;
		await expect(accept(S, await invite(seeded, 'M'))).rejects.toMatchObject({ code: 'seat-already-held' });
		expect(S.wrapper.authWraps).toBe(wrapsBefore);

		expect(await bumpRevision(seeded)).toBe(1);

		const again = await accept(S, await invite(seeded, 'K'));
		expect(again.userId).not.toBe(first.userId);
		const row = await seeded.auth.ctx.db.prepare('select ElectionRevision from Keyholder where UserId = :u').get({ u: again.userId });
		expect(row?.ElectionRevision).toBe(1);
		expect(await listKeyholderIdentities(S.storage)).toHaveLength(2);

		// The new identity now holds the live seat: another invitation on S is refused again.
		const wraps2 = S.wrapper.authWraps;
		await expect(accept(S, await invite(seeded, 'N'))).rejects.toMatchObject({ code: 'seat-already-held' });
		expect(S.wrapper.authWraps).toBe(wraps2);
	});
});
