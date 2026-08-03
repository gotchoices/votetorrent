import type { Authority, INetworkEngine } from "@votetorrent/vote-core";

/**
 * ballot-authority-empty fix (2026-07-30): every established network has at
 * least one authority (the primary/network-creator authority is minted as
 * part of network creation), so `getAuthoritiesByName(undefined)` returning
 * ZERO rows for an established network is never a legitimate steady state —
 * it is the signature of a strand/CRDT replication race where the
 * `SchemaInit` marker (a separate, independently-replicated vtab) has already
 * become readable while the `Authority` table's rows have not yet finished
 * replicating from the strand. This is the same class of device-only,
 * Node-invisible timing race documented elsewhere in this app (the cold-boot
 * "Network not opened in this session" re-attach race, which self-resolves
 * on a bare retry with no other change).
 *
 * Root-cause note: this was NOT confirmed via a captured on-device empty-read
 * (the exact race window could not be hit during investigation despite
 * targeted repro attempts), but every other explanation in the data path
 * (prop wiring, SQL/pagination logic, stale dist/ bundle, cross-network
 * context mismatch, and a dead `if (!engine) return` branch that can never
 * trigger because `getEngine("network")` always throws or returns a real
 * engine) was eliminated with direct evidence. Retrying on an empty result
 * is a safe, low-risk mitigation regardless: a genuinely-empty steady state
 * (which should not occur) still resolves to `[]` after retries exhaust,
 * identical to today's behavior — it only helps the race case.
 *
 * Short bounded backoff (not open-ended polling): 3 attempts, 300ms apart,
 * capped at <1s total added latency in the worst case.
 */
export async function loadAuthoritiesWithRetry(
	engine: INetworkEngine,
	maxAttempts: number = 3,
	delayMs: number = 300,
): Promise<Authority[]> {
	let buffer: Authority[] = [];
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const cursor = await engine.getAuthoritiesByName(undefined);
		buffer = cursor.buffer;
		if (buffer.length > 0 || attempt === maxAttempts) {
			return buffer;
		}
		await new Promise((resolve) => setTimeout(resolve, delayMs));
	}
	return buffer;
}
