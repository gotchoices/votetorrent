import { useCallback, useEffect, useState } from "react";
import type { INetworkEngine, Scope } from "@votetorrent/vote-core";
import { useApp } from "../providers/AppProvider";
import { getOrCreateDeviceUser } from "../engines/device-user";

/**
 * useCurrentOfficerScopes — D-10 forward officer walk (device → Officer).
 *
 * Inverts the reverse walk `EditOfficerScreen.tsx:51-71` already performs
 * (officerId → Officer). Given an authorityId, this hook answers "what
 * scopes does THIS device hold at THIS authority?" by joining the device's
 * own identity (`getOrCreateDeviceUser().id`) against the authority's
 * officer roster (`Officer.userId`) — the same join key EditOfficerScreen
 * walks in the other direction.
 *
 * NOT A SECURITY BOUNDARY (T-46-03): this gate is a convenience/legibility
 * affordance ONLY. The real control is the DB-side 'mel'-scoped
 * AdminSignature CHECK (MutationValid/DeleteValid on the
 * ElectionRegistrationField/ElectionDisclosurePolicy/ElectionAttestationPolicy
 * tables), which rejects an unsigned or wrong-scope mutation regardless of
 * what this hook returns. A caller that ignores this hook entirely cannot
 * thereby write anything — there is no code path here that gates a write
 * itself; this hook only returns raw data.
 *
 * WR-05 caveat: `OfficerInit` (vote-core/src/authority/models.ts:114-134)
 * carries no per-officer `userId`, so `NetworkEngine.createAuthority` binds
 * `ctx.user.id` to every seeded officer row. That makes the `userId` match
 * below trivially correct for the single-officer path that exists today,
 * but a genuinely second officer device will find NO matching row and be
 * gated read-only — which is honest given the current data model, and will
 * need revisiting when true multi-officer authorities land.
 *
 * `undefined` vs `[]` contract: `undefined` means no matching Officer row
 * (or the walk failed) — this is ALSO the pre-load value, so callers must
 * check `loading` before rendering a "you are not an officer" message. `[]`
 * means a real officer holding zero scopes. Callers must distinguish these
 * two states; do not default the missing case to an empty array.
 *
 * Scope-agnostic by design (D-10): the hook returns the officer's raw,
 * unfiltered `Scope[]` and never mentions `'mel'` in executable code, so
 * Phase 47 can reuse it verbatim for `'vrg'`/`'cap'` — each caller derives
 * its own `canWrite` as `!loading && scopes?.includes('mel') === true` (or
 * whichever scope it needs).
 */
export interface CurrentOfficerScopesResult {
	scopes: Scope[] | undefined;
	loading: boolean;
	/** Re-runs the officer lookup (additive; e.g. on screen focus so a decision gate never stays stale). */
	refresh: () => void;
}

export function useCurrentOfficerScopes(authorityId: string): CurrentOfficerScopesResult {
	const { getEngine } = useApp();
	const [scopes, setScopes] = useState<Scope[] | undefined>(undefined);
	const [loading, setLoading] = useState<boolean>(true);
	const [reloadNonce, setReloadNonce] = useState(0);
	const refresh = useCallback(() => setReloadNonce((n) => n + 1), []);

	useEffect(() => {
		let cancelled = false;

		(async () => {
			// Re-entering loading on every authorityId change so a re-run never
			// briefly reports the previous authority's answer.
			if (!cancelled) setLoading(true);
			try {
				const deviceUser = await getOrCreateDeviceUser("Device User");
				const networkEngine = await getEngine<INetworkEngine>("network");
				const authorityEngine = await networkEngine.openAuthority(authorityId);
				const admin = await authorityEngine.getAdminDetails();
				const officer = admin.admin.officers.find((o) => o.userId === deviceUser.id);
				// Optional chain is load-bearing: a missing officer yields `undefined`,
				// an officer row with an empty array yields `[]`. Do NOT normalise
				// `undefined` to `[]` here — the screen's scope-gate banner renders a
				// different message for "not an officer" than for "officer, no scopes".
				if (!cancelled) setScopes(officer?.scopes);
			} catch (error) {
				console.warn("useCurrentOfficerScopes: error resolving officer scopes:", error);
				if (!cancelled) setScopes(undefined);
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();

		return () => {
			cancelled = true;
		};
		// Plain effect by default (a caller opts into re-reads through `refresh`), NOT a focus-triggered re-fetch: officer scopes are
		// administration-level data that only change through a proposeAdmin ceremony on
		// another screen, so re-querying on every screen focus buys nothing beyond what
		// the next mount already re-resolves. (useTaskCount's badge needs a focus-driven
		// refetch because it must track mutations made elsewhere in the same session;
		// this gate does not.)
	}, [getEngine, authorityId, reloadNonce]);

	return { scopes, loading, refresh };
}
