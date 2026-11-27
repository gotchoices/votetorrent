/**
 * seed-bound-keyholder.js — TEST-ONLY. 62-02 (D-26): every `Keyholder` row now needs a signed
 * `KeyholderDkgBinding` in the SAME transaction (`Keyholder.InsertValid` requires it). This
 * replaces the four raw `insert into Keyholder` sites this app's fixtures/browser gates used
 * before 62-02 — none of them needs "no signing ceremony" anymore.
 *
 * ZERO IMPORTS from anything this app builds (D-17, same rule `registrant-roll-fixture.js` and
 * `keyrelease-fixture.js` state) — dependency-free except `@noble/curves/secp256k1.js` and
 * `@noble/hashes/sha2.js` (both already transitively installed under this app's own
 * `node_modules`; `packages/web-data` does not have them). `digestToBytes` below is a verbatim
 * copy of `packages/vote-engine/src/utils.ts`'s decoder (same rules: 64-char hex or 43-char
 * base64url) — this file cannot import vote-engine's `src/` (test-only code must not reach a
 * production bundle's dependency graph), so the decoding logic is duplicated, not imported.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';

/** Verbatim copy of packages/vote-engine/src/utils.ts's digestToBytes — see file header. */
function digestToBytes(d) {
	if (d instanceof Uint8Array) return d;
	if (typeof d !== 'string') {
		throw new Error(`digestToBytes: unrecognized Digest() output type: ${typeof d}`);
	}
	if (d.length === 64 && /^[0-9a-fA-F]+$/.test(d)) return hexToBytes(d);
	if (d.length === 43 && /^[A-Za-z0-9_-]+$/.test(d)) {
		const b64 = d.replace(/-/g, '+').replace(/_/g, '/').padEnd(44, '=');
		return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
	}
	throw new Error(`digestToBytes: unrecognized Digest() output shape: len=${d.length}`);
}

/** A deterministic, per-fixture-user secp256k1 private key — stable across runs. */
function deterministicPrivateKey(seed) {
	let candidate = sha256(new TextEncoder().encode(`vtx-fixture-keyholder-key:${seed}`));
	let attempt = 0;
	while (!secp256k1.utils.isValidSecretKey(candidate)) {
		attempt += 1;
		if (attempt > 16) throw new Error(`deterministicPrivateKey: could not derive a valid scalar for seed=${seed}`);
		candidate = sha256(new TextEncoder().encode(`vtx-fixture-keyholder-key:${seed}:${attempt}`));
	}
	return candidate;
}

/**
 * Insert, for ONE user, the prerequisites a signed keyholder binding needs: a Type 'k' InviteSlot
 * (per-user Name so multiple users never collide on the slot's content-addressed Cid), an accepted
 * InviteResult naming this user as InvokedId, the User row (through that slot, ONLY if the user
 * does not already exist), and a bootstrap UserKey (ONLY if the user has no key yet) from a
 * deterministic fixture keypair.
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {{ electionId: string, userId: string, userName: string, now: string }} options
 * @returns {Promise<{ userId: string, inviteSlotCid: string, signerPublicKey: string }>}
 */
export async function seedKeyholderPrerequisites(db, options) {
	const { electionId, userId, userName, now } = options ?? {};
	if (!electionId) throw new Error('seedKeyholderPrerequisites: options.electionId is required');
	if (!userId) throw new Error('seedKeyholderPrerequisites: options.userId is required');
	if (!userName) throw new Error('seedKeyholderPrerequisites: options.userName is required');
	if (!now) throw new Error('seedKeyholderPrerequisites: options.now is required');

	const priv = deterministicPrivateKey(userId);
	const signerPublicKey = bytesToHex(secp256k1.getPublicKey(priv));

	// --- 1. InviteSlot (Type 'k'), per-user Name so the Cid never collides. ---
	const slotName = `vtx-fixture Keyholder Invite (${userId})`;
	const expiration = '2026-12-31T00:00:00';
	const inviteKey = 'vtx-fixture-invite-key';
	const inviteSignature = '';
	const nonce = `vtx-fixture-invite-nonce-${userId}`;
	const cidRow = await db
		.prepare('select cid(Digest(:eid, :exp, :ikey, :isig, :iname, :nonce, :itype)) as c')
		.get({ eid: electionId, exp: expiration, ikey: inviteKey, isig: inviteSignature, iname: slotName, nonce, itype: 'k' });
	if (cidRow?.c == null) {
		throw new Error('seedKeyholderPrerequisites: cid(Digest(...)) returned null — crypto plugin not registered?');
	}
	const inviteSlotCid = String(cidRow.c);

	await db.exec(
		`insert into InviteSlot (Cid,Type,Name,Expiration,InviteKey,InviteSignature,SigningNonce,ResendSalt,ElectionId)
		 with context Tid = 1, now = '${now}', IsSignatureValid = true, IsInsertValid = true
		 values (:cid,:itype,:iname,:exp,:ikey,:isig,:nonce,null,:eid)`,
		{ cid: inviteSlotCid, itype: 'k', iname: slotName, exp: expiration, ikey: inviteKey, isig: inviteSignature, nonce, eid: electionId },
	);

	// --- 2. Accepted InviteResult naming this user. ---------------------------
	await db.exec(
		`insert into InviteResult (SlotCid, IsAccepted, Digest, InviteSignature, InvokedId)
		 with context IsSigningValid = true, IsSignatureValid = true
		 values (:slot, true, :slot, 'vtx-fixture-invite-result-signature', :userId)`,
		{ slot: inviteSlotCid, userId },
	);

	// --- 3. User (through the slot), only if it does not already exist. ------
	const existingUser = await db.prepare('select Id from User where Id = :id').get({ id: userId });
	if (!existingUser) {
		await db.exec(
			`insert into User (Id, Name, ImageRef)
			 with context SigningNonce = null, InviteSlotCid = :slot, InviteSignature = :sig, Tid = 1
			 values (:id,:uname,null)`,
			{ slot: inviteSlotCid, sig: inviteSignature, id: userId, uname: userName },
		);
	}

	// --- 4. Bootstrap UserKey, only if the user has no key yet. --------------
	const existingKey = await db.prepare('select PubKey from UserKey where UserId = :id').get({ id: userId });
	if (!existingKey) {
		await db.exec(
			`insert into UserKey (UserId, Type, PubKey, Expiration)
			 with context UserKey = null, Signature = null, Tid = 1, now = :now, IsSignatureValid = true
			 values (:uid, 'M', :pub, :exp)`,
			{ uid: userId, pub: signerPublicKey, exp: '2036-12-31T00:00:00', now },
		);
	}

	return { userId, inviteSlotCid, signerPublicKey };
}

/**
 * Insert the Keyholder + KeyholderDkgBinding pair for one already-prerequisite-seeded user, in ONE
 * transaction (D-26: `Keyholder.InsertValid` requires a same-transaction binding; both CHECKs are
 * deferred to COMMIT, so statement order within the transaction does not matter).
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {{ userId: string, inviteSlotCid: string, signerPublicKey: string }} prereq
 * @param {{ electionId: string, revision: number, tid: number }} options
 * @returns {Promise<void>}
 */
export async function insertBoundKeyholder(db, prereq, options) {
	const { electionId, revision, tid } = options ?? {};
	if (!electionId) throw new Error('insertBoundKeyholder: options.electionId is required');
	if (revision === undefined || revision === null) throw new Error('insertBoundKeyholder: options.revision is required');
	if (tid === undefined || tid === null) throw new Error('insertBoundKeyholder: options.tid is required');

	const { userId, inviteSlotCid, signerPublicKey } = prereq;
	const priv = deterministicPrivateKey(userId);
	// The DKG receiving key is independent of the signing key -- a second deterministic keypair,
	// seeded off a distinct string so it never collides with the signing key above.
	const dkgPriv = deterministicPrivateKey(`${userId}-dkg-receiving`);
	const dkgPublicKey = bytesToHex(secp256k1.getPublicKey(dkgPriv));
	const boundAt = '2026-01-01T00:00:00.000Z';

	await db.exec('BEGIN');
	try {
		await db.exec(
			`insert into Keyholder (ElectionId,ElectionRevision,UserId)
			 with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${Number(tid)}
			 values (:eid,:rev,:uid)`,
			{ eid: electionId, rev: Number(revision), uid: userId },
		);

		const digestRow = await db
			.prepare("select Digest('KeyholderDkgBinding', :eid, :rev, :uid, :slot, :dkgKey, :boundAt) as d")
			.get({ eid: electionId, rev: Number(revision), uid: userId, slot: inviteSlotCid, dkgKey: dkgPublicKey, boundAt });
		if (digestRow?.d == null) {
			throw new Error('insertBoundKeyholder: Digest() returned null — crypto plugin not registered?');
		}
		const signature = bytesToHex(secp256k1.sign(digestToBytes(digestRow.d), priv));

		await db.exec(
			`insert into KeyholderDkgBinding (ElectionId,ElectionRevision,UserId,InviteSlotCid,DkgPublicKey,BoundAt,SignerKey,Signature)
			 values (:eid,:rev,:uid,:slot,:dkgKey,:boundAt,:signerKey,:signature)`,
			{ eid: electionId, rev: Number(revision), uid: userId, slot: inviteSlotCid, dkgKey: dkgPublicKey, boundAt, signerKey: signerPublicKey, signature },
		);

		await db.exec('COMMIT');
	} catch (err) {
		await db.exec('ROLLBACK');
		throw err;
	}
}
