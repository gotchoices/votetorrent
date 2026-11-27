/**
 * is-privileged.js — a thin wrapper around `UserEngine.isPrivileged`, the
 * SAME privilege primitive `apps/VoteTorrentAuthority` uses. This module
 * must never contain hand-rolled privilege SQL: all four prototype spikes
 * (075/076/077/078) hand-rolled the equivalent privilege-lookup query only
 * because the `./browser` subpath's barrel-import problem was unsolved (see
 * packages/vote-engine/src/browser-entry.ts). That problem is solved now;
 * this file exists to retire the shortcut, not repeat it.
 *
 * WR-02 — deny-by-default ambiguity (documented at
 * packages/vote-engine/src/user/user-engine.ts around `isPrivileged`): a
 * missing effective `Admin` row, or a future-dated one relative to the
 * Officer's `AdminEffectiveAt`, makes `isPrivileged` resolve `false` for
 * EVERY scope. That renders as an all-hidden dashboard and is
 * indistinguishable from "this officer genuinely holds no scopes." This
 * wrapper does not attempt to disambiguate it — doing so would require new
 * privilege SQL, which is exactly what this file exists to forbid. Both
 * branches are pinned by test/node/is-privileged.test.mjs so the empty
 * dashboard this can produce is a known, tested behaviour rather than a
 * mystery bug report.
 */

import { UserEngine } from '@votetorrent/vote-engine/browser';
import { CAPABILITIES } from './capabilities.js';

/**
 * Answer whether `userId` currently holds `scope`, by constructing a
 * `UserEngine` bound to the given database and calling `isPrivileged`
 * verbatim — its SQL is never re-derived here.
 *
 * @param {import('@quereus/quereus').Database | null | undefined} db
 * @param {string} userId
 * @param {import('./capabilities.js').ScopeCode} scope
 * @returns {Promise<boolean>}
 */
export async function isPrivileged(db, userId, scope) {
	// `ctx` is only constructed when `db` is truthy so that a null/undefined
	// `db` surfaces UserEngine's own `requireCtx` error ("no EngineContext
	// bound") rather than a bare "Cannot read properties of null" a couple
	// of frames deeper — the caller gets a message that actually names the
	// missing thing.
	const engine = new UserEngine({ id: userId, name: '', activeKeys: [] }, db ? { db } : undefined);
	return engine.isPrivileged(scope, userId);
}

/**
 * Read every scope `userId` currently holds, in `CAPABILITIES` order.
 * Constructs the engine ONCE, then awaits one `isPrivileged` call per
 * capability, sequentially — not `Promise.all`. These all run against one
 * shared Quereus handle, and this project's tier-1 discipline for a shared
 * handle is deliberately sequential and stateful (see
 * test/node/gate-contract.test.mjs's sequencing-contract note).
 *
 * An unknown `userId` resolves to `[]` without throwing — the underlying
 * query simply matches no `Officer` row.
 *
 * @param {import('@quereus/quereus').Database | null | undefined} db
 * @param {string} userId
 * @returns {Promise<import('./capabilities.js').ScopeCode[]>}
 */
export async function readGrantedScopes(db, userId) {
	const engine = new UserEngine({ id: userId, name: '', activeKeys: [] }, db ? { db } : undefined);
	/** @type {import('./capabilities.js').ScopeCode[]} */
	const granted = [];
	for (const capability of CAPABILITIES) {
		// eslint-disable-next-line no-await-in-loop -- deliberately sequential, see file header
		const has = await engine.isPrivileged(capability.scope, userId);
		if (has) granted.push(capability.scope);
	}
	return granted;
}
