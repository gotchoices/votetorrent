/**
 * app-schema-refusal.ts — tells 'this build's schema cannot be applied to the network's data'
 * apart from any other failure to open a network.
 *
 * cadre-core (quereus-plugin-sereus `app-schema.js`) throws `AppSchemaRefusedError` from
 * `addStrand` when this build's declared schema cannot be applied to the network's existing data,
 * and closes the strand. Spike 109 (2026-11-12) measured when that happens on our networks: a
 * `not null` column without a default, or a CHECK one build's rows already break (a member does not
 * check a peer's writes against its own CHECKs). New tables, indexes and nullable columns apply.
 *
 * The data that conflicts lives on the network, not only on this phone, so clearing the app's data
 * would lose this phone's keys and still fail on rejoin. The remedy is a build whose schema fits
 * the network's data: update the app. Nothing is changed on this phone by the refusal (the apply
 * is rolled back; reopening on the previous schema still works).
 *
 * Matching is structural, as in the Authority's `engines/app-schema-refusal.ts` (this file is its copy): the error `name` (set explicitly by
 * cadre-core, so it survives minification), walking `cause` at most five levels
 * (vote-engine's `NetworksEngine.open/create` wrap the factory error with `cause`). The message is
 * never read or shown.
 */

const MAX_CAUSE_DEPTH = 5;

/**
 * Both refusals have the same remedy, update the app:
 *  - `AppSchemaRefusedError`: this build's schema cannot be applied to the network's data.
 *  - `AppSchemaOutdatedError`: the network records a higher App schema version than this build
 *    declares (`VOTETORRENT_SCHEMA_VERSION`), because another member already runs a newer build.
 */
const REFUSAL_NAMES: ReadonlySet<unknown> = new Set(['AppSchemaRefusedError', 'AppSchemaOutdatedError']);

/** True when `err`, or one of its first five causes, is cadre-core's `AppSchemaRefusedError` or `AppSchemaOutdatedError`. Never throws. */
export function isAppSchemaRefusal(err: unknown): boolean {
	const visited = new Set<unknown>();
	let current: unknown = err;
	for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
		if (current === null || typeof current !== 'object' || visited.has(current)) return false;
		visited.add(current);
		try {
			if (REFUSAL_NAMES.has((current as { name?: unknown }).name)) return true;
			current = (current as { cause?: unknown }).cause;
		} catch {
			return false;
		}
	}
	return false;
}
