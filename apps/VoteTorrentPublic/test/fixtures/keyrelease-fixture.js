/**
 * keyrelease-fixture.js — TEST-ONLY. Nothing under
 * `apps/VoteTorrentPublic/src` may import this file (D-17), for the same reason
 * `registrant-roll-fixture.js` states: a production bundle carrying these facts
 * would let a public page assert election facts that are not true.
 *
 * 62-02 (D-26): `Keyholder.InsertValid` now requires a signed
 * `KeyholderDkgBinding` in the SAME transaction, so the five `Keyholder` rows
 * below no longer use a bare context shoe-in — each is seeded through
 * `seed-bound-keyholder.js`'s `seedKeyholderPrerequisites`/`insertBoundKeyholder`
 * pair (the one import this file now carries). Every OTHER row (the five
 * `Task`/`ReleaseKeyTaskExtension` pairs) is still a plain context shoe-in —
 * `Task.MutationValid` is `context.IsMutationValid = true` and nothing else.
 *
 * TWO OPPOSITE TRANSACTION RULES LIVE IN THIS PHASE. They are stated side by
 * side here so the contrast reads as deliberate rather than as an
 * inconsistency a later reader should "fix":
 *
 *   - THIS FILE BATCHES. `Task.ExtensionExists` requires a matching
 *     `ReleaseKeyTaskExtension`, and `ReleaseKeyTaskExtension.TaskIdValid`
 *     requires the `Task`. Both contain subqueries and are therefore DEFERRED
 *     TO COMMIT. Under autocommit each statement commits alone, so inserting
 *     the `Task` by itself fails `ExtensionExists` and inserting the extension
 *     first fails `TaskIdValid`. The pair is only satisfiable inside ONE
 *     transaction whose commit evaluates them together.
 *   - `registrant-roll-fixture.js` MUST NOT BATCH its reissue.
 *     `RegistrantPublic.RegistrantCidMatch` is likewise deferred to commit, so
 *     batching there would evaluate the superseded row's check after
 *     `Registrant.PublicCid` had already moved forward, and the row would be
 *     rejected.
 *
 * CLOSING SPIKE 088'S RECORDED SEEDING LIMIT. Spike 088 seeded exactly ONE
 * keyholder and said so explicitly, because `User.InsertValid` admits the
 * unsigned shoe-in only while `(select count(*) from User) = 1`; a second user
 * needs a valid `InviteSlot` + `InviteSignature`. It chose not to pay for that
 * and recorded the single-keyholder roster as a SEEDING LIMIT rather than an
 * election state — the honest call at the time. The workaround is now cheap and
 * legitimate, because `InviteSlot`'s own integrity checks
 * (`InviteSignatureValid`, `InsertValid`) are context passthroughs: seed one
 * slot, then seed users against it. THE WALL WAS IN THE FIXTURE, NOT IN THE
 * SCHEMA'S MEANING, and it is gone — later fixture work should not re-derive
 * it.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { seedKeyholderPrerequisites, insertBoundKeyholder } from './seed-bound-keyholder.js';

/**
 * The four additional keyholder users. The founding fixture's `u1` is the
 * fifth keyholder and already exists (as a `User`; it gets its own `UserKey`
 * here, since the founding fixture never gives it one).
 * @type {ReadonlyArray<Readonly<{ id: string, name: string }>>}
 */
export const KEYRELEASE_USERS = Object.freeze([
	Object.freeze({ id: 'u-kh-2', name: 'vtx-fixture Keyholder Two' }),
	Object.freeze({ id: 'u-kh-3', name: 'vtx-fixture Keyholder Three' }),
	Object.freeze({ id: 'u-kh-4', name: 'vtx-fixture Keyholder Four' }),
	Object.freeze({ id: 'u-kh-5', name: 'vtx-fixture Keyholder Five' }),
]);

/**
 * One release-key `Task` per keyholder, three completed and two not.
 *
 * WHY THE MIX MATTERS. `0 of 0` and `N of N` both render a degenerate sentence
 * that hides an aggregate bug: an aggregate stuck at zero and an aggregate that
 * counts tasks instead of completions both look correct at those two extremes.
 * `released` must therefore be non-zero AND strictly less than `total`, and the
 * tier-1 suite asserts both of those RELATIONALLY, not just as the literals
 * below.
 * @type {ReadonlyArray<Readonly<{ id: string, userId: string, isCompleted: number }>>}
 */
export const KEYRELEASE_TASKS = Object.freeze([
	Object.freeze({ id: 't-rk-1', userId: 'u1', isCompleted: 1 }),
	Object.freeze({ id: 't-rk-2', userId: 'u-kh-2', isCompleted: 1 }),
	Object.freeze({ id: 't-rk-3', userId: 'u-kh-3', isCompleted: 1 }),
	Object.freeze({ id: 't-rk-4', userId: 'u-kh-4', isCompleted: 0 }),
	Object.freeze({ id: 't-rk-5', userId: 'u-kh-5', isCompleted: 0 }),
]);

/**
 * 62-126: keyholders whose KeyholderShareRelease row is PUBLISHED. This is what the public figure
 * counts. It deliberately differs from the completed-task set below (t-rk-1..3 -> u1, u-kh-2,
 * u-kh-3): the share rows are u-kh-2, u-kh-4, u-kh-5, so a reader that still counted completed
 * tasks would get 3 but name a different set, and the two-sided web-data test is the real
 * discriminator. The COUNT here is the same 3 so the rendered sentences are unchanged.
 * @type {ReadonlyArray<string>}
 */
export const SHARE_RELEASE_USER_IDS = Object.freeze(['u-kh-2', 'u-kh-4', 'u-kh-5']);

/** Keyholders with a published share row (the public "released" figure). @type {number} */
export const EXPECTED_RELEASED = 3;

/**
 * The `total` field: since 62-126 it is the keyholders of record (the denominator), no longer a
 * count of release-key tasks. @type {number}
 */
export const EXPECTED_TOTAL = 5;

/** Keyholders of record — the denominator the render layer says "of". @type {number} */
export const EXPECTED_KEYHOLDERS = 5;

/**
 * Row counts this fixture leaves behind.
 *
 * `User` IS 5, NOT 4: the founding fixture's single user plus the four seeded
 * here. THIS KEY OVERRIDES the founding fixture's `User: 1`, so any merge must
 * place this object LAST — see `seed-public-surface.js`, which asserts the
 * resulting value rather than trusting the spread order.
 * @type {Readonly<Record<string, number>>}
 */
export const KEYRELEASE_EXPECTED_COUNTS = Object.freeze({
	InviteSlot: 5,
	InviteResult: 5,
	User: 5,
	UserKey: 5,
	Keyholder: 5,
	KeyholderDkgBinding: 5,
	Task: 5,
	ReleaseKeyTaskExtension: 5,
	KeyholderDkgMessage: 5,
	ElectionKey: 1,
	KeyholderShareRelease: 3,
});

/**
 * Seed the keyholder roster and the release-key tasks that D-14's aggregate
 * counts: five `InviteSlot`+`InviteResult`+`UserKey`+`Keyholder`+
 * `KeyholderDkgBinding` tuples (62-02, D-26: one per keyholder, each
 * self-signed), four new `User`s (the fifth, `u1`, already exists), and five
 * `Task` + `ReleaseKeyTaskExtension` pairs.
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {{ electionId: string, revision: number, seedNow: string }} options
 * @returns {Promise<void>}
 */
export async function seedKeyReleaseTasks(db, options) {
	await seedKeyReleaseKeyholders(db, options);
	await seedKeyReleaseTaskRows(db, options);
}

/**
 * The five bound keyholders alone (no tasks, no share rows). 62-126 split this out of
 * `seedKeyReleaseTasks` so a test can build "share published, no task" and "task, no share".
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {{ electionId: string, revision: number, seedNow: string }} options
 * @returns {Promise<void>}
 */
export async function seedKeyReleaseKeyholders(db, options) {
	const { electionId, revision, seedNow } = options ?? {};
	if (!electionId) throw new Error('seedKeyReleaseKeyholders: options.electionId is required');
	if (revision === undefined || revision === null) throw new Error('seedKeyReleaseKeyholders: options.revision is required');
	if (!seedNow) throw new Error('seedKeyReleaseKeyholders: options.seedNow is required');

	// --- 1 & 2. Keyholders, EACH with its own InviteSlot + signed binding. ----
	// 62-02 (D-26): `Keyholder.InsertValid` requires a signed
	// `KeyholderDkgBinding` for the SAME (ElectionId, ElectionRevision, UserId)
	// triple, and `KeyholderDkgBinding.InviteAccepted` requires the slot's
	// `InviteResult.InvokedId` to equal the binding's UserId -- so a single
	// shared slot (the pre-62-02 shape) can no longer serve more than one
	// keyholder. Each of the five users (the founding fixture's `u1` plus the
	// four `KEYRELEASE_USERS`) now gets its OWN prerequisites.
	const keyholderNames = Object.freeze({
		u1: 'vtx-fixture Keyholder One',
		...Object.fromEntries(KEYRELEASE_USERS.map((u) => [u.id, u.name])),
	});
	for (const userId of ['u1', ...KEYRELEASE_USERS.map((u) => u.id)]) {
		// eslint-disable-next-line no-await-in-loop -- sequential against one shared handle, this project's tier-1 discipline
		const prereq = await seedKeyholderPrerequisites(db, {
			electionId,
			userId,
			userName: keyholderNames[userId],
			now: seedNow,
		});
		// eslint-disable-next-line no-await-in-loop
		await insertBoundKeyholder(db, prereq, { electionId, revision: Number(revision), tid: 1 });
	}
}

/**
 * The five `Task` + `ReleaseKeyTaskExtension` pairs (three completed). Needs the keyholders'
 * `User` rows to exist. Since 62-126 these no longer feed the public figure; they are kept so the
 * fixtures still carry the bookkeeping rows the old reader counted (a task without a share must
 * NOT be counted).
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {{ electionId: string, revision: number }} options
 * @returns {Promise<void>}
 */
export async function seedKeyReleaseTaskRows(db, options) {
	const { electionId, revision } = options ?? {};
	if (!electionId) throw new Error('seedKeyReleaseTaskRows: options.electionId is required');
	if (revision === undefined || revision === null) throw new Error('seedKeyReleaseTaskRows: options.revision is required');

	// --- 3. Tasks and their extensions, ONE EXPLICIT TRANSACTION PER PAIR. ----
	// See this file's header for why batching is mandatory here and forbidden in
	// `registrant-roll-fixture.js`. `BEGIN`/`COMMIT`/`ROLLBACK` through
	// `db.exec` is the form `elections-engine.ts` uses for this exact pair.
	//
	// `IsCompleted` is bound as a NUMBER (0/1) into a column declared
	// `integer default 0`, so it is stored as an integer. This is NOT the
	// `number`-column-stores-bound-integers-as-blobs hazard recorded elsewhere
	// in this project — that one is about columns DECLARED `number`. Nothing
	// here needs re-declaring.
	for (const task of KEYRELEASE_TASKS) {
		// eslint-disable-next-line no-await-in-loop
		await db.exec('BEGIN');
		try {
			// eslint-disable-next-line no-await-in-loop
			await db.exec(
				`insert into Task (Id, UserId, Type, SignatureType, SigningNonce, IsCompleted)
				 with context IsMutationValid = true, Tid = 1
				 values (:id, :uid, 'release-key', null, null, :done)`,
				{ id: task.id, uid: task.userId, done: Number(task.isCompleted) },
			);
			// eslint-disable-next-line no-await-in-loop
			await db.exec(
				`insert into ReleaseKeyTaskExtension (TaskId, ElectionId, ElectionRevision)
				 with context Tid = 1
				 values (:tid, :eid, :rev)`,
				{ tid: task.id, eid: electionId, rev: Number(revision) },
			);
			// eslint-disable-next-line no-await-in-loop
			await db.exec('COMMIT');
		} catch (err) {
			// eslint-disable-next-line no-await-in-loop
			await db.exec('ROLLBACK');
			throw err;
		}
	}
}

/** Verbatim mirror of seed-bound-keyholder.js's (unexported) per-user key derivation. */
function deterministicPrivateKey(seed) {
	let candidate = sha256(new TextEncoder().encode(`vtx-fixture-keyholder-key:${seed}`));
	let attempt = 0;
	while (!secp256k1.utils.isValidSecretKey(candidate)) {
		attempt += 1;
		if (attempt > 16) throw new Error(`deterministicPrivateKey: no valid scalar for seed=${seed}`);
		candidate = sha256(new TextEncoder().encode(`vtx-fixture-keyholder-key:${seed}:${attempt}`));
	}
	return candidate;
}

/** Same decoder as seed-bound-keyholder.js (64-char hex digest). */
function digestBytes(d) {
	if (typeof d === 'string' && d.length === 64 && /^[0-9a-fA-F]+$/.test(d)) return hexToBytes(d);
	if (typeof d === 'string' && d.length === 43 && /^[A-Za-z0-9_-]+$/.test(d)) {
		const b64 = d.replace(/-/g, '+').replace(/_/g, '/').padEnd(44, '=');
		return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
	}
	throw new Error(`digestBytes: unrecognized Digest() output shape: ${typeof d}`);
}

/** Sign a `Digest(...)` row the way every fixture user signs: their deterministic key. */
async function signDigest(db, userId, digestSql, binds) {
	const row = await db.prepare(`select ${digestSql} as d`).get(binds);
	if (row?.d == null) throw new Error('signDigest: Digest() returned null -- crypto plugin not registered?');
	const priv = deterministicPrivateKey(userId);
	return { signerKey: bytesToHex(secp256k1.getPublicKey(priv)), signature: bytesToHex(secp256k1.sign(digestBytes(row.d), priv)) };
}

/**
 * 62-126: publish `KeyholderShareRelease` rows for `userIds` -- the fact the public view counts.
 * The schema admits a release only for a user who signed the agreeing round-4 DKG message of a
 * published `ElectionKey`, so this seeds, once, a round-4 message from EVERY keyholder, the
 * `ElectionKey` (threshold 3 of 5, matching the election surface), then one signed release per
 * user. The share values are arbitrary (validity is reader-side, not schema-checked); the rows are
 * "published, not validated", which is exactly what the public count means.
 *
 * Requires the five keyholders from `seedKeyReleaseKeyholders`.
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {{ electionId: string, revision: number, userIds: ReadonlyArray<string> }} options
 * @returns {Promise<void>}
 */
export async function seedKeyReleaseShares(db, options) {
	const { electionId, revision, userIds } = options ?? {};
	if (!electionId) throw new Error('seedKeyReleaseShares: options.electionId is required');
	if (revision === undefined || revision === null) throw new Error('seedKeyReleaseShares: options.revision is required');
	const rev = Number(revision);
	const allUsers = ['u1', ...KEYRELEASE_USERS.map((u) => u.id)];
	const jointKey = bytesToHex(secp256k1.getPublicKey(deterministicPrivateKey('vtx-fixture-joint-key')));
	const sentAt = '2026-01-02T00:00:00.000Z';
	const attempt = 1;

	const existing = await db.prepare('select count(*) as c from ElectionKey where ElectionId = :e and ElectionRevision = :r').get({ e: electionId, r: rev });
	if (Number(existing?.c ?? 0) === 0) {
		for (const userId of allUsers) {
			const payload = JSON.stringify({ groupPublicKey: jointKey, groupCommitments: [jointKey] });
			// eslint-disable-next-line no-await-in-loop
			const sig = await signDigest(
				db,
				userId,
				"Digest('KeyholderDkgMessage', :e, :r, :a, 4, :u, :p, :k, :s)",
				{ e: electionId, r: rev, a: attempt, u: userId, p: payload, k: jointKey, s: sentAt },
			);
			// eslint-disable-next-line no-await-in-loop
			await db.exec(
				`insert into KeyholderDkgMessage (ElectionId, ElectionRevision, Attempt, DkgRound, SenderUserId, Payload, ResultKey, SentAt, SenderKey, Signature)
				 values (:e, :r, :a, 4, :u, :p, :k, :s, :sk, :sig)`,
				{ e: electionId, r: rev, a: attempt, u: userId, p: payload, k: jointKey, s: sentAt, sk: sig.signerKey, sig: sig.signature },
			);
		}
		const commitments = JSON.stringify([jointKey]);
		const publisher = 'u1';
		const sig = await signDigest(
			db,
			publisher,
			"Digest('ElectionKey', :e, :r, :a, :jk, :gc, 3, 5, :pa, :pu)",
			{ e: electionId, r: rev, a: attempt, jk: jointKey, gc: commitments, pa: sentAt, pu: publisher },
		);
		await db.exec(
			`insert into ElectionKey (ElectionId, ElectionRevision, Attempt, JointPublicKey, GroupCommitments, Threshold, Participants, PublishedAt, PublisherUserId, PublisherKey, Signature)
			 values (:e, :r, :a, :jk, :gc, 3, 5, :pa, :pu, :pk, :sig)`,
			{ e: electionId, r: rev, a: attempt, jk: jointKey, gc: commitments, pa: sentAt, pu: publisher, pk: sig.signerKey, sig: sig.signature },
		);
	}

	for (const userId of userIds ?? []) {
		const identifier = bytesToHex(sha256(new TextEncoder().encode(`vtx-fixture-identifier:${userId}`)));
		const signingShare = bytesToHex(sha256(new TextEncoder().encode(`vtx-fixture-share:${userId}`)));
		const releasedAt = '2026-01-03T00:00:00.000Z';
		// eslint-disable-next-line no-await-in-loop
		const sig = await signDigest(
			db,
			userId,
			"Digest('KeyholderShareRelease', :e, :r, :u, :i, :s, :ra)",
			{ e: electionId, r: rev, u: userId, i: identifier, s: signingShare, ra: releasedAt },
		);
		// eslint-disable-next-line no-await-in-loop
		await db.exec(
			`insert into KeyholderShareRelease (ElectionId, ElectionRevision, UserId, Identifier, SigningShare, ReleasedAt, SignerKey, Signature)
			 values (:e, :r, :u, :i, :s, :ra, :sk, :sig)`,
			{ e: electionId, r: rev, u: userId, i: identifier, s: signingShare, ra: releasedAt, sk: sig.signerKey, sig: sig.signature },
		);
	}
}
