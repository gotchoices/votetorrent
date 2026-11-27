import type { Authority, INetworkEngine } from "@votetorrent/vote-core";

/** Bounded paging: an authority list is small, and a display label must never loop forever. */
const MAX_PAGES = 10;

/**
 * Display name of the authority `authorityId` on the open network, or `undefined` when it can't
 * be found (callers fall back to the id). Checks the pinned list first (cheap and usually a hit),
 * then pages `getAuthoritiesByName(undefined)`, the same read the authority list uses.
 *
 * Exists because the election screens labelled "Authority:" with the NETWORK name (Create
 * Election) or the raw authority id (Election Details), while the election list row shows the
 * real authority name.
 */
export async function findAuthorityName(
	engine: Pick<INetworkEngine, "getPinnedAuthorities" | "getAuthoritiesByName" | "nextAuthoritiesByName">,
	authorityId: string,
): Promise<string | undefined> {
	if (!authorityId) return undefined;
	const nameIn = (list: Authority[] | undefined) => list?.find((a) => a.id === authorityId)?.name || undefined;

	try {
		const pinned = nameIn(await engine.getPinnedAuthorities());
		if (pinned) return pinned;
	} catch {
		// Fall through to the full list.
	}

	let cursor = await engine.getAuthoritiesByName(undefined);
	for (let page = 0; page < MAX_PAGES; page++) {
		const hit = nameIn(cursor.buffer);
		if (hit) return hit;
		if (cursor.lastEOF || cursor.buffer.length === 0) return undefined;
		cursor = await engine.nextAuthoritiesByName(cursor, true);
	}
	return undefined;
}
