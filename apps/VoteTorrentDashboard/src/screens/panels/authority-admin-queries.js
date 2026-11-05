/**
 * authority-admin-queries.js — `resolveAuthorityId` plus the six read-only
 * fetchers backing the Authority Administration panels (Network Settings,
 * Authority Profile, Authority Peers, Administration & Officers, Keyholders,
 * Invite Authorities). Every export here is a READ. No function in this
 * module inserts, updates or deletes a single row.
 *
 * RAW-HANDLE READS ARE DELIBERATE HERE, NOT AN OVERSIGHT of the standing
 * "write through vote-engine, never the raw handle" rule. That rule governs
 * WRITES — the raw handle silently loses tier-2 enforcement (`iad`/`ik` have
 * zero schema sites; their only enforcement is `context.Is*Valid` booleans
 * inside `authority-engine.ts`, which a write against the raw handle would
 * bypass). Phase 50 makes no writes at all (D-01), so that failure mode
 * cannot occur here. The engine class that WOULD honour the rule for these
 * reads (`AuthorityEngine`) is not exported on the `@votetorrent/vote-engine`
 * `./browser` subpath, and the phase outline's own binding contract forbids
 * this dashboard from importing `NetworksEngine`. Reading on `db` directly is
 * therefore the only reachable path, disclosed and reasoned rather than a
 * quiet exception.
 *
 * `ThresholdPolicies` / `Scopes` / `Relays` / `TimestampAuthorities` arrive
 * from the schema as JSON TEXT and are parsed HERE, not in the components —
 * so a malformed value is a tier-1-provable behaviour (an empty array, never
 * a throw) instead of a runtime crash in a browser tab.
 *
 * The module also holds the live helpers for these panels, appended after
 * the fetchers: one table list per fetcher, the change-mark row mappers, the
 * open-invite rule and two small read-settling helpers. All of them are
 * pure; none reads or writes a row. Each `*_TABLES` list names exactly the
 * base tables its fetcher's SQL reads (a view that reads a table counts as
 * that table), and the drift test in `authority-admin-queries.test.mjs`
 * proves every list against the SQL above it, so a panel's "did this pass
 * touch my tables" check can never silently miss a table it reads.
 */
import { toCanonicalDatetime } from '@votetorrent/vote-engine/browser';

/** Parse a JSON array column. Never throws: null, a non-string, malformed
 * JSON and a well-formed-but-non-array value (e.g. `'{}'`, `'null'`) all
 * resolve to `[]`. Mirrors `vote-engine`'s `parseJsonOr` intent without
 * importing it -- that helper is not on the browser subpath.
 * @param {unknown} text
 * @returns {unknown[]} */
function parseJsonArray(text) {
	if (typeof text !== 'string') return [];
	try {
		const parsed = JSON.parse(text);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/** WR-02: Quereus/SQLite returns boolean columns as 0/1 on some paths.
 * Normalize to a real boolean so a strict `=== true` downstream, and a
 * declined invite, are never mistaken for an accepted one.
 * @param {unknown} v
 * @returns {boolean} */
function toBool(v) {
	return v === true || v === 1;
}

/**
 * Resolve which authority's data this browser's snapshot shows.
 * `PanelProps` carries no officer id and no authority id (contract C7), so
 * every panel that needs one calls this first. Three branches, in order:
 *   1. `Network.PrimaryAuthorityId` -- present in any real snapshot, because
 *      a network created by the authority app always inserts
 *      Authority -> User -> Admin -> Officer -> Network.
 *   2. No `Network` row: fall back to the single `Authority` row.
 *   3. Neither resolves (or more than one `Authority` exists with no
 *      `Network`): resolve `null`. Multi-authority navigation is out of
 *      scope (D-01); this module builds no authority picker.
 *
 * @param {import('@quereus/quereus').Database | null} db
 * @returns {Promise<string | null>}
 */
export async function resolveAuthorityId(db) {
	if (db == null) return null;

	const networkRow = await db.prepare(`select PrimaryAuthorityId from Network`).get({});
	if (networkRow && networkRow.PrimaryAuthorityId != null) {
		return /** @type {string} */ (networkRow.PrimaryAuthorityId);
	}

	/** @type {string[]} */
	const authorityIds = [];
	for await (const row of db.eval(`select Id from Authority`, {})) {
		authorityIds.push(/** @type {string} */ (row.Id));
	}
	return authorityIds.length === 1 ? authorityIds[0] : null;
}

/**
 * @typedef {object} NetworkSettings
 * @property {string} Name
 * @property {string} Hash
 * @property {string} PrimaryAuthorityId
 * @property {unknown[]} Relays
 * @property {unknown[]} TimestampAuthorities
 * @property {number} NumberRequiredTSAs
 * @property {string} ElectionType
 * @property {string | null} ElectionTypeName
 */

/**
 * @param {import('@quereus/quereus').Database | null} db
 * @returns {Promise<NetworkSettings | null>}
 */
export async function fetchNetworkSettings(db) {
	if (db == null) return null;
	const row = await db
		.prepare(
			`select N.Name, N.Hash, N.PrimaryAuthorityId, N.Relays, N.TimestampAuthorities, N.NumberRequiredTSAs, N.ElectionType, ET.Name as ElectionTypeName
			 from Network N left join ElectionType ET on ET.Code = N.ElectionType`,
		)
		.get({});
	if (!row) return null;
	return {
		Name: /** @type {string} */ (row.Name),
		Hash: /** @type {string} */ (row.Hash),
		PrimaryAuthorityId: /** @type {string} */ (row.PrimaryAuthorityId),
		Relays: parseJsonArray(row.Relays),
		TimestampAuthorities: parseJsonArray(row.TimestampAuthorities),
		NumberRequiredTSAs: /** @type {number} */ (row.NumberRequiredTSAs),
		ElectionType: /** @type {string} */ (row.ElectionType),
		ElectionTypeName: row.ElectionTypeName == null ? null : /** @type {string} */ (row.ElectionTypeName),
	};
}

/**
 * @typedef {object} AuthorityProfile
 * @property {string} Id
 * @property {string} Name
 * @property {string | null} DomainName
 * @property {string | null} ImageRef
 */

/**
 * @param {import('@quereus/quereus').Database | null} db
 * @returns {Promise<AuthorityProfile | null>}
 */
export async function fetchAuthorityProfile(db) {
	if (db == null) return null;
	const authorityId = await resolveAuthorityId(db);
	if (authorityId == null) return null;
	const row = await db.prepare(`select Id, Name, DomainName, ImageRef from Authority where Id = :id`).get({ id: authorityId });
	if (!row) return null;
	return {
		Id: /** @type {string} */ (row.Id),
		Name: /** @type {string} */ (row.Name),
		DomainName: row.DomainName == null ? null : /** @type {string} */ (row.DomainName),
		ImageRef: row.ImageRef == null ? null : /** @type {string} */ (row.ImageRef),
	};
}

/**
 * @param {import('@quereus/quereus').Database | null} db
 * @returns {Promise<string[]>}
 */
export async function fetchAuthorityPeers(db) {
	if (db == null) return [];
	const authorityId = await resolveAuthorityId(db);
	if (authorityId == null) return [];
	/** @type {string[]} */
	const out = [];
	for await (const row of db.eval(`select PeerId from AuthorityPeer where AuthorityId = :aid order by PeerId asc`, { aid: authorityId })) {
		out.push(/** @type {string} */ (row.PeerId));
	}
	return out;
}

/**
 * @typedef {object} AdministrationOfficer
 * @property {string} UserId
 * @property {string | null} Name
 * @property {string} Title
 * @property {unknown[]} Scopes
 */

/**
 * @typedef {object} AdministrationOfficers
 * @property {{ EffectiveAt: string, ThresholdPolicies: unknown[] } | null} admin
 * @property {AdministrationOfficer[]} officers
 */

/**
 * Reads the admin via `Admin ⋈ CurrentAdmin` -- the same wall-clock
 * fail-closed join `isPrivileged` uses (50-06). When that join yields
 * nothing (every `Admin` row for this authority is future-dated), this
 * resolves `{ admin: null, officers: [] }` WITHOUT falling back to a query
 * that ignores `CurrentAdmin` -- a fallback would paper over the
 * deliberately pinned wall-clock fail-closed behaviour.
 *
 * @param {import('@quereus/quereus').Database | null} db
 * @returns {Promise<AdministrationOfficers>}
 */
export async function fetchAdministrationOfficers(db) {
	if (db == null) return { admin: null, officers: [] };
	const authorityId = await resolveAuthorityId(db);
	if (authorityId == null) return { admin: null, officers: [] };

	const adminRow = await db
		.prepare(
			`select A.EffectiveAt, A.ThresholdPolicies
			 from Admin A join CurrentAdmin CA on A.AuthorityId = CA.AuthorityId and A.EffectiveAt = CA.EffectiveAt
			 where A.AuthorityId = :aid`,
		)
		.get({ aid: authorityId });
	if (!adminRow) return { admin: null, officers: [] };

	/** @type {AdministrationOfficer[]} */
	const officers = [];
	for await (const row of db.eval(
		`select O.UserId, U.Name, O.Title, O.Scopes
		 from Officer O left join User U on U.Id = O.UserId
		 where O.AuthorityId = :aid and O.AdminEffectiveAt = :effectiveAt`,
		{ aid: authorityId, effectiveAt: adminRow.EffectiveAt },
	)) {
		officers.push({
			UserId: /** @type {string} */ (row.UserId),
			Name: row.Name == null ? null : /** @type {string} */ (row.Name),
			Title: /** @type {string} */ (row.Title),
			Scopes: parseJsonArray(row.Scopes),
		});
	}

	return {
		admin: {
			EffectiveAt: /** @type {string} */ (adminRow.EffectiveAt),
			ThresholdPolicies: parseJsonArray(adminRow.ThresholdPolicies),
		},
		officers,
	};
}

/**
 * @typedef {object} KeyholderRow
 * @property {string} ElectionId
 * @property {number} ElectionRevision
 * @property {string} UserId
 * @property {string | null} Name
 * @property {number | null} KeyholderThreshold
 */

/**
 * Projects exactly `K.ElectionId, K.ElectionRevision, K.UserId, U.Name,
 * ER.KeyholderThreshold` and nothing else -- `Keyholder`'s own PK carries no
 * key column of any kind, and this function must never grow a join that
 * would add one. Naming who holds a key share is a governance fact about the
 * election; it is not, and must never become, exposure of the share itself.
 *
 * A populated result is UNREACHABLE in Phase 50: a `Keyholder` row needs an
 * `Election`, an `ElectionRevision` and an accepted `k` (keyholder) invite,
 * and the keyholder invite ceremony is out of scope (D-01). The empty state
 * this resolves in every real Phase 50 snapshot is the true state, not a
 * stub waiting to be filled in.
 *
 * @param {import('@quereus/quereus').Database | null} db
 * @returns {Promise<KeyholderRow[]>}
 */
export async function fetchKeyholders(db) {
	if (db == null) return [];
	/** @type {KeyholderRow[]} */
	const out = [];
	for await (const row of db.eval(
		`select K.ElectionId, K.ElectionRevision, K.UserId, U.Name, ER.KeyholderThreshold
		 from Keyholder K
		 left join User U on U.Id = K.UserId
		 left join ElectionRevision ER on ER.ElectionId = K.ElectionId and ER.Revision = K.ElectionRevision`,
		{},
	)) {
		out.push({
			ElectionId: /** @type {string} */ (row.ElectionId),
			ElectionRevision: /** @type {number} */ (row.ElectionRevision),
			UserId: /** @type {string} */ (row.UserId),
			Name: row.Name == null ? null : /** @type {string} */ (row.Name),
			KeyholderThreshold: row.KeyholderThreshold == null ? null : /** @type {number} */ (row.KeyholderThreshold),
		});
	}
	return out;
}

/**
 * @typedef {object} AuthorityInvite
 * @property {string} Cid
 * @property {string} Name
 * @property {string} Type
 * @property {string | null} TypeName
 * @property {string} Expiration
 * @property {boolean | null} IsAccepted
 * @property {string | null} CancelledAt
 */

/**
 * Shows invite STATE only. The multi-officer invite ceremony and the
 * keyholder invite ceremony are both out of scope (D-01), and the schema
 * admits exactly one user through the unsigned shoe-in
 * (`User.InsertValid` requires `count(*) from User = 1`), so there is no
 * second officer for a ceremony here to produce -- this function has nothing
 * to offer beyond reading what already exists.
 *
 * `InviteSlot` is aliased `IS_` -- `IS` is a reserved word in Quereus (the
 * same reserved-word hazard class as `:limit`/`:desc`/`:group`/`:order`/
 * `:type`/`:key` as bind-parameter names), mirroring
 * `invitation-engine.ts`'s own `getOfficerInvite`.
 *
 * @param {import('@quereus/quereus').Database | null} db
 * @returns {Promise<AuthorityInvite[]>}
 */
export async function fetchAuthorityInvites(db) {
	if (db == null) return [];
	const authorityId = await resolveAuthorityId(db);
	if (authorityId == null) return [];
	/** @type {AuthorityInvite[]} */
	const out = [];
	for await (const row of db.eval(
		`select IS_.Cid, IS_.Name, IS_.Type, IT.Name as TypeName, IS_.Expiration, IR.IsAccepted, IC.CancelledAt
		 from InviteSlot IS_
		 join AdminSigning A on A.Nonce = IS_.SigningNonce
		 join InviteType IT on IT.Code = IS_.Type
		 left join InviteResult IR on IR.SlotCid = IS_.Cid
		 left join InviteCancellation IC on IC.SlotCid = IS_.Cid
		 where A.AuthorityId = :aid and A.Scope = 'iad'`,
		{ aid: authorityId },
	)) {
		out.push({
			Cid: /** @type {string} */ (row.Cid),
			Name: /** @type {string} */ (row.Name),
			Type: /** @type {string} */ (row.Type),
			TypeName: row.TypeName == null ? null : /** @type {string} */ (row.TypeName),
			Expiration: /** @type {string} */ (row.Expiration),
			IsAccepted: row.IsAccepted == null ? null : toBool(row.IsAccepted),
			CancelledAt: row.CancelledAt == null ? null : /** @type {string} */ (row.CancelledAt),
		});
	}
	return out;
}

// --- Live helpers for the administration panels ------------------------------
//
// Everything below is pure. A panel re-reads only when a completed sync pass
// changed one of the tables in its list, keeps its last data on screen while
// it re-reads, and hands the mapper rows to the shared change-mark hook so a
// changed field or row is marked briefly.

/** Tables `fetchNetworkSettings` reads. */
export const NETWORK_SETTINGS_TABLES = Object.freeze(['ElectionType', 'Network']);

/** Tables `fetchAuthorityProfile` reads (with `resolveAuthorityId`). */
export const AUTHORITY_PROFILE_TABLES = Object.freeze(['Authority', 'Network']);

/** Tables `fetchAuthorityPeers` reads (with `resolveAuthorityId`). */
export const AUTHORITY_PEERS_TABLES = Object.freeze(['Authority', 'AuthorityPeer', 'Network']);

/** Tables `fetchAdministrationOfficers` reads (with `resolveAuthorityId`; the `CurrentAdmin` view counts as `Admin` plus
 * `AdminCancellation`, so a cancelled change re-reads the panel). */
export const ADMINISTRATION_OFFICERS_TABLES = Object.freeze(['Admin', 'AdminCancellation', 'Authority', 'Network', 'Officer', 'User']);

/** Tables `fetchKeyholders` reads. */
export const KEYHOLDERS_TABLES = Object.freeze(['ElectionRevision', 'Keyholder', 'User']);

/** Tables `fetchAuthorityInvites` reads (with `resolveAuthorityId`). */
export const AUTHORITY_INVITES_TABLES = Object.freeze([
	'AdminSigning',
	'Authority',
	'InviteCancellation',
	'InviteResult',
	'InviteSlot',
	'InviteType',
	'Network',
]);

/**
 * One change-mark row: `key` names the field or row on screen, `sig` is the
 * displayed value(s) as JSON. A row is marked when its `sig` differs from the
 * previous pass's `sig` for the same `key`, or when the key is new.
 * @typedef {{ key: string, sig: string }} MarkRow
 */

/** @param {MarkRow} row @returns {string} */
export function markRowKey(row) {
	return row.key;
}

/** @param {MarkRow} row @returns {string} */
export function markRowSig(row) {
	return row.sig;
}

/** @param {unknown} value @returns {string} */
function sigOf(value) {
	return JSON.stringify(value ?? null);
}

/**
 * One row per displayed field, keys equal to the panel's field labels, in
 * display order. Built from an explicit field list, never by walking the
 * record, so a column added to the fetcher later never reaches a sig.
 * @param {NetworkSettings | null} settings
 * @returns {MarkRow[]}
 */
export function networkSettingsMarkRows(settings) {
	if (settings == null) return [];
	return [
		{ key: 'Name', sig: sigOf(settings.Name) },
		{ key: 'Hash', sig: sigOf(settings.Hash) },
		{ key: 'PrimaryAuthorityId', sig: sigOf(settings.PrimaryAuthorityId) },
		{ key: 'Relays', sig: sigOf(settings.Relays) },
		{ key: 'TimestampAuthorities', sig: sigOf(settings.TimestampAuthorities) },
		{ key: 'NumberRequiredTSAs', sig: sigOf(settings.NumberRequiredTSAs) },
		{ key: 'ElectionType', sig: sigOf([settings.ElectionType, settings.ElectionTypeName]) },
	];
}

/**
 * @param {AuthorityProfile | null} profile
 * @returns {MarkRow[]}
 */
export function authorityProfileMarkRows(profile) {
	if (profile == null) return [];
	return [
		{ key: 'Name', sig: sigOf(profile.Name) },
		{ key: 'DomainName', sig: sigOf(profile.DomainName) },
		{ key: 'Id', sig: sigOf(profile.Id) },
		{ key: 'ImageRef', sig: sigOf(profile.ImageRef) },
	];
}

/**
 * One row per peer, in input order; the peer id is both key and sig (a peer
 * row either exists or it does not).
 * @param {string[] | null} peerIds
 * @returns {MarkRow[]}
 */
export function authorityPeersMarkRows(peerIds) {
	if (!Array.isArray(peerIds)) return [];
	return peerIds.map((peerId) => ({ key: String(peerId), sig: String(peerId) }));
}

/** @param {string} userId @returns {string} */
export function officerMarkKey(userId) {
	return 'officer:' + userId;
}

/**
 * The two administration fields first (only when an administration is
 * current), then one row per officer.
 * @param {AdministrationOfficers | null} value
 * @returns {MarkRow[]}
 */
export function administrationOfficersMarkRows(value) {
	if (value == null) return [];
	/** @type {MarkRow[]} */
	const out = [];
	if (value.admin != null) {
		out.push({ key: 'admin:EffectiveAt', sig: sigOf(value.admin.EffectiveAt) });
		out.push({ key: 'admin:ThresholdPolicies', sig: sigOf(value.admin.ThresholdPolicies) });
	}
	const officers = Array.isArray(value.officers) ? value.officers : [];
	for (const officer of officers) {
		out.push({ key: officerMarkKey(officer.UserId), sig: sigOf([officer.Name, officer.Title, officer.Scopes]) });
	}
	return out;
}

/**
 * One row per invite, keyed by `Cid`. The sig is exactly the six displayed
 * values, so no other property of the row object can ever reach it.
 * @param {AuthorityInvite[] | null} invites
 * @returns {MarkRow[]}
 */
export function authorityInvitesMarkRows(invites) {
	if (!Array.isArray(invites)) return [];
	return invites.map((invite) => ({
		key: invite.Cid,
		sig: sigOf([invite.Name, invite.Type, invite.TypeName, invite.Expiration, invite.IsAccepted, invite.CancelledAt]),
	}));
}

const CANONICAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

/**
 * Whether an invite is still waiting for an answer at `nowMs`: not accepted,
 * not declined, not cancelled, and its expiration is still ahead. Both
 * instants are compared as 19-character canonical datetimes (text order is
 * time order in that form). An unreadable expiration or a non-finite
 * `nowMs` is never open.
 * @param {AuthorityInvite} invite
 * @param {number} nowMs epoch milliseconds
 * @returns {boolean}
 */
export function isOpenInvite(invite, nowMs) {
	if (invite == null || typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return false;
	if (invite.IsAccepted !== null || invite.CancelledAt !== null) return false;
	if (typeof invite.Expiration !== 'string') return false;
	const expiration = toCanonicalDatetime(invite.Expiration);
	const now = toCanonicalDatetime(nowMs);
	if (!CANONICAL_DATETIME_RE.test(expiration) || !CANONICAL_DATETIME_RE.test(now)) return false;
	return expiration > now;
}

/**
 * A panel's read state. These helpers encode two rules for live panels: keep
 * the old data on screen while a re-read runs, and hand the change-mark hook
 * `null` (never an empty list) while nothing has been read yet.
 * @template T
 * @typedef {{ status: 'loading' | 'ready' | 'error', data: T | null }} PanelReadState
 */

/** The state before the first read of a database handle. */
export const PANEL_READ_LOADING = /** @type {{ status: 'loading', data: null }} */ (Object.freeze({ status: 'loading', data: null }));

/**
 * Fold one read outcome into the previous state. A good read replaces the
 * data; a failed read after a good one keeps that good data (the same object)
 * instead of falling back to the empty sentence; a failed first read is an
 * error.
 * @template T
 * @param {PanelReadState<T>} prev
 * @param {{ ok: true, data: T | null } | { ok: false }} outcome
 * @returns {PanelReadState<T>}
 */
export function settlePanelRead(prev, outcome) {
	if (outcome.ok) return { status: 'ready', data: outcome.data };
	if (prev.status === 'ready') return prev;
	return { status: 'error', data: null };
}

/**
 * The mark rows for a read state: the mapper's rows once data is ready,
 * otherwise `null` so the change-mark hook skips the diff and keeps its last
 * index.
 * @template T
 * @param {PanelReadState<T>} state
 * @param {(data: T | null) => MarkRow[]} toRows
 * @returns {MarkRow[] | null}
 */
export function markRowsOrNull(state, toRows) {
	if (state.status !== 'ready') return null;
	return toRows(state.data);
}
