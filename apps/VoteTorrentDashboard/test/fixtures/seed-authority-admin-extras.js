/**
 * seed-authority-admin-extras.js — Network + AuthorityPeer + InviteSlot seed
 * rungs on top of 50-05's founding fixture (`seed-founding-authority.js`).
 *
 * TEST SCAFFOLDING, NOT A PRODUCTION WRITE PATH. Phase 50's dashboard makes
 * NO writes (D-01); these rows exist only so
 * `src/screens/panels/authority-admin-queries.js`'s six fetchers have
 * something real to read. Same standing exception `seed-founding-
 * authority.js` and `seed-election-surface.js` (50-10) both record: the
 * engine entry points that would honour "write through vote-engine" for
 * these tables (`NetworksEngine` / `AuthorityEngine`) are exactly what the
 * outline's binding contract forbids this dashboard from importing, so this
 * fixture reaches the schema directly. This is not a precedent for any
 * production write path in this app.
 *
 * DATETIME LITERALS HERE ARE CANONICAL 19-CHARACTER, NO `Z` -- the same
 * convention `seed-election-surface.js` (50-10) uses and explains: every
 * literal here sits inside a `Digest(...)` tuple a signed ceremony
 * recomputes bit-for-bit, or inside an `ExpirationValid`/`now` comparison,
 * and a `Z`-suffixed value would make the digest mismatch or the comparison
 * wrong. `seed-founding-authority.js`'s OWN `Z`-suffixed literal
 * (`AdminEffectiveAt`) is the one exception re-declared verbatim below,
 * because `AdminSigning.UserIdValid` requires an EXACT match against the
 * founding Officer row's `AdminEffectiveAt` -- see the constant comment.
 */

const AUTHORITY_ID = 'a1';
const OFFICER_USER_ID = 'u1';
// Must match `seed-founding-authority.js`'s internal `EFFECTIVE_AT` literal
// EXACTLY -- that file does not export it, and `AdminSigning.UserIdValid`
// requires `O.AdminEffectiveAt = new.AdminEffectiveAt` against the founding
// Officer row. A mismatch fails closed with a bare
// `CHECK constraint failed: UserIdValid`, naming nothing about why.
const ADMIN_EFFECTIVE_AT = '2026-01-01T00:00:00.000Z';

// The pretend wall clock every ceremony in this file signs at, and the `now`
// every InviteSlot's `ExpirationValid` is checked against. Must be strictly
// before every `expiration` this file passes to `seedAuthorityInvite` /
// `seedOtherScopeInvite`.
const SEED_NOW = '2026-01-15T00:00:00';

let nonceSeq = 0;

/**
 * Run a signing ceremony for one privileged mutation and return its nonce.
 * Ported verbatim in shape from spike 078's `engine.js:74-85` (also mirrored
 * by 50-10's `seed-election-surface.js:123-137`). `digestSql` must reproduce
 * EXACTLY the `Digest(...)` tuple the target table's CHECK recomputes, in
 * order, with `Tid` bound as a real integer.
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {{ scope: string, tid: number, digestSql: string, params?: Record<string, unknown> }} options
 * @returns {Promise<string>}
 */
export async function ceremony(db, { scope, tid, digestSql, params = {} }) {
	const nonce = `n-${scope}-${++nonceSeq}`;
	await db.exec(
		`insert into AdminSigning (Nonce,AuthorityId,AdminEffectiveAt,Scope,Digest,UserId,SignerKey,Signature)
		 with context now = '${SEED_NOW}', IsSignerKeyValid = true, IsPlaceholderSignature = true
		 values (:nonce, '${AUTHORITY_ID}', '${ADMIN_EFFECTIVE_AT}', '${scope}',
		         (select Digest(${digestSql})), '${OFFICER_USER_ID}', 'placeholder-key', 'placeholder-sig')`,
		{ nonce, tid, ...params },
	);
	await db.exec(`insert into AdminSignature (SigningNonce) with context IsSignatureValid = true values (:nonce)`, { nonce });
	return nonce;
}

/**
 * One `Network` insert -- unsigned (`NoSigningNonceOnInsert` requires
 * `context.SigningNonce is null`; the first network in a database is
 * created without a ceremony). `NumberRequiredTSAs` is bound as a real JS
 * integer (`typeof(...) = 'integer'` is checked); `Relays` and
 * `TimestampAuthorities` are bound as JSON strings.
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {{ authorityId: string }} options
 * @returns {Promise<void>}
 */
export async function seedNetwork(db, { authorityId }) {
	const relays = JSON.stringify(['/dns4/relay1.gate50.example/tcp/4001', '/dns4/relay2.gate50.example/tcp/4001']);
	const timestampAuthorities = JSON.stringify([{ url: 'https://tsa1.gate50.example' }, { url: 'https://tsa2.gate50.example' }]);
	await db.exec(
		`insert into Network (Id,Hash,PrimaryAuthorityId,Name,ImageRef,Relays,TimestampAuthorities,NumberRequiredTSAs,ElectionType)
		 with context SigningNonce = null, Tid = 1
		 values (:id,:hash,:aid,:name,null,:relays,:tsa,:nreq,:type)`,
		{
			id: 'net1',
			hash: 'aa11networkhash',
			aid: authorityId,
			name: 'Gate County Network',
			relays,
			tsa: timestampAuthorities,
			nreq: 2,
			type: 'o',
		},
	);
}

/**
 * One `cap` ceremony per peer, `digestSql` reproducing
 * `Digest(context.Tid, new.AuthorityId, new.PeerId)` exactly, in that order,
 * with `Tid` bound as an integer -- a digest tuple that does not match, in
 * order, surfaces as a bare `InsertValid` failure naming nothing.
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {{ authorityId: string, peerIds: string[] }} options
 * @returns {Promise<void>}
 */
export async function seedAuthorityPeers(db, { authorityId, peerIds }) {
	let tid = 700;
	for (const peerId of peerIds) {
		tid += 1;
		// eslint-disable-next-line no-await-in-loop -- sequential against one shared handle, this project's tier-1 discipline
		const nonce = await ceremony(db, {
			scope: 'cap',
			tid,
			digestSql: ':tid, :aid, :peerId',
			params: { aid: authorityId, peerId },
		});
		// eslint-disable-next-line no-await-in-loop
		await db.exec(`insert into AuthorityPeer (AuthorityId,PeerId) with context SigningNonce = :n, Tid = :tid values (:aid,:peerId)`, {
			n: nonce,
			tid,
			aid: authorityId,
			peerId,
		});
	}
}

/**
 * The three rungs `authority-engine.ts`'s `saveInviteWithSigning` documents,
 * in the SAME order (D-19: nonce first, InviteSlot second, AdminSigning
 * third), plus one `InviteResult` row so `fetchAuthorityInvites` has a
 * populated positive control. Shared by `seedAuthorityInvite` (scope
 * `'iad'`) and `seedOtherScopeInvite` (scope `'uai'`) via the `scope`
 * parameter.
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {{ authorityId: string, name: string, expiration: string, scope: string }} options
 * @returns {Promise<string>} the InviteSlot's Cid
 */
async function seedInviteAtScope(db, { authorityId, name, expiration, scope }) {
	const nonce = `n-${scope}-invite-${++nonceSeq}`;
	// `:key` alone is a reserved SQL keyword in Quereus (the same
	// reserved-word hazard class as `:limit`/`:desc`/`:group`/`:order`/
	// `:type` -- see the module header and `src/reads/registrations.js`'s own
	// finding) -- bound here as `:inviteKey` instead.
	const inviteKey = `invite-pubkey-${scope}-${nonceSeq}`;
	const inviteSignature = `invite-sig-${scope}-${nonceSeq}`;
	const type = 'au';

	// TX1 (D-19 rung 1, folded into the Cid computation): compute the Cid in
	// SQL via the six-argument au/of branch of CidValid, in EXACTLY this
	// column order (Expiration, InviteKey, InviteSignature, Name,
	// SigningNonce, Type), with ResendSalt and ElectionId both null.
	const cidRow = await db
		.prepare(`select cid(Digest(:exp,:inviteKey,:inviteSignature,:name,:nonce,:type)) as Cid`)
		.get({ exp: expiration, inviteKey, inviteSignature, name, nonce, type });
	const cid = /** @type {string} */ (cidRow?.Cid);

	// TX2 (D-19 rung 2): insert InviteSlot BEFORE AdminSigning exists --
	// authority-engine.ts's saveInviteWithSigning documents this as the
	// mandatory order, and InviteSlot's own context envelope carries no
	// SigningNonce field to create a chicken-and-egg dependency on it.
	await db.exec(
		`insert into InviteSlot (Cid,Type,Name,Expiration,InviteKey,InviteSignature,SigningNonce,ResendSalt,ElectionId)
		 with context Tid = 1, now = :now, IsSignatureValid = true, IsInsertValid = true
		 values (:cid,:type,:name,:exp,:inviteKey,:inviteSignature,:nonce,null,null)`,
		{ cid, type, name, exp: expiration, inviteKey, inviteSignature, nonce, now: SEED_NOW },
	);

	// TX3 (D-19 rung 3): AdminSigning/AdminSignature at the given scope,
	// whose Digest is (select Digest(:cid)) over that same Cid -- required
	// by InviteSlotSigningValid, which fires only once the AdminSigning row
	// exists.
	await db.exec(
		`insert into AdminSigning (Nonce,AuthorityId,AdminEffectiveAt,Scope,Digest,UserId,SignerKey,Signature)
		 with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = true
		 values (:nonce,:aid,'${ADMIN_EFFECTIVE_AT}',:scope,(select Digest(:cid)),'${OFFICER_USER_ID}','placeholder-key','placeholder-sig')`,
		{ nonce, aid: authorityId, scope, cid, now: SEED_NOW },
	);
	await db.exec(`insert into AdminSignature (SigningNonce) with context IsSignatureValid = true values (:nonce)`, { nonce });

	// One InviteResult -- not accepted, Digest null (DigestValid requires
	// null when not accepted).
	await db.exec(
		`insert into InviteResult (SlotCid,IsAccepted,Digest,InviteSignature,InvokedId)
		 with context IsSigningValid = true, IsSignatureValid = true
		 values (:cid,false,null,:inviteSignature,null)`,
		{ cid, inviteSignature },
	);

	return cid;
}

/**
 * A `'iad'`-scoped authority invite: three rungs plus one `InviteResult`
 * row (`IsAccepted = false`) -- the positive control `fetchAuthorityInvites`
 * asserts against.
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {{ authorityId: string, name: string, expiration: string }} options
 * @returns {Promise<string>} the InviteSlot's Cid
 */
export async function seedAuthorityInvite(db, { authorityId, name, expiration }) {
	return seedInviteAtScope(db, { authorityId, name, expiration, scope: 'iad' });
}

/**
 * The identical three rungs, but signed at scope `'uai'` instead of `'iad'`
 * -- exists solely so `fetchAuthorityInvites`'s `Scope = 'iad'` filter has
 * something real to exclude (the paired negative control).
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {{ authorityId: string }} options
 * @returns {Promise<string>} the InviteSlot's Cid
 */
export async function seedOtherScopeInvite(db, { authorityId }) {
	return seedInviteAtScope(db, {
		authorityId,
		name: 'Wrong-Scope Invite (must not appear as an authority invite)',
		expiration: '2026-06-01T00:00:00',
		scope: 'uai',
	});
}

/**
 * A second Officer under the SAME (AuthorityId, AdminEffectiveAt) as the
 * founding officer, carrying a deliberately non-array `Scopes` value
 * (`'{}'` by default -- valid JSON, but not an array, so it passes
 * `Officer.ScopesValid`'s vacuous `json_each` scan while still exercising
 * `fetchAdministrationOfficers`'s malformed-Scopes handling). Reached
 * through the officer-invite branch of `Officer.InsertValid`/`User.
 * InsertValid` (NOT the unsigned shoe-in, which the schema hard-limits to
 * exactly one User -- `User.InsertValid` requires `count(*) from User = 1`,
 * measured empirically: a genuinely malformed JSON string, e.g. `'not-json'`,
 * makes the underlying `json_each` table-valued function throw AT INSERT
 * TIME, so it can never be persisted; only a well-formed-but-non-array value
 * reaches storage, which is exactly the shape `parseJsonArray` must handle).
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {{ authorityId: string, userId: string, title: string, scopes?: string }} options
 * @returns {Promise<void>}
 */
export async function seedOfficerWithMalformedScopes(db, { authorityId, userId, title, scopes = '{}' }) {
	const nonce = `n-of-invite-${++nonceSeq}`;
	const inviteKey = `invite-pubkey-of-${nonceSeq}`;
	const inviteSignature = `invite-sig-of-${nonceSeq}`;
	const name = 'Malformed-Scopes Officer Fixture';
	const type = 'of';
	const expiration = '2099-01-01T00:00:00';

	const cidRow = await db
		.prepare(`select cid(Digest(:exp,:inviteKey,:inviteSignature,:name,:nonce,:type)) as Cid`)
		.get({ exp: expiration, inviteKey, inviteSignature, name, nonce, type });
	const cid = /** @type {string} */ (cidRow?.Cid);

	await db.exec(
		`insert into InviteSlot (Cid,Type,Name,Expiration,InviteKey,InviteSignature,SigningNonce,ResendSalt,ElectionId)
		 with context Tid = 1, now = :now, IsSignatureValid = true, IsInsertValid = true
		 values (:cid,:type,:name,:exp,:inviteKey,:inviteSignature,:nonce,null,null)`,
		{ cid, type, name, exp: expiration, inviteKey, inviteSignature, nonce, now: SEED_NOW },
	);

	await db.exec(
		`insert into User (Id,Name,ImageRef)
		 with context SigningNonce = null, InviteSlotCid = :cid, InviteSignature = :inviteSignature, Tid = 1
		 values (:userId,:name,null)`,
		{ cid, inviteSignature, userId, name: 'Malformed-Scopes Officer' },
	);

	await db.exec(
		`insert into InviteResult (SlotCid,IsAccepted,Digest,InviteSignature,InvokedId)
		 with context IsSigningValid = true, IsSignatureValid = true
		 values (:cid,true,:digest,:inviteSignature,null)`,
		{ cid, digest: 'accept-digest-placeholder', inviteSignature },
	);

	await db.exec(
		`insert into Officer (AuthorityId,AdminEffectiveAt,UserId,Title,Scopes)
		 with context SigningNonce = null, InviteSlotCid = :cid, InviteSignature = :inviteSignature, Tid = 1
		 values (:aid,'${ADMIN_EFFECTIVE_AT}',:userId,:title,:scopes)`,
		{ cid, inviteSignature, aid: authorityId, userId, title, scopes },
	);
}
