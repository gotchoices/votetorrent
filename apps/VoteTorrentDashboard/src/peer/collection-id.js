/**
 * collection-id.js — the collection id a public table's blocks carry on the strand, which is what
 * `node.reactivityWatch` is asked to watch.
 *
 * `@optimystic/quereus-plugin-optimystic` gives a table with no `using(...)` clause the collection URI
 * `defaultCollectionUri(schemaName, tableName)` = `tree://default/<schema>/<table>`, and its collection id is
 * that URI without `tree://` (`OptimysticCollectionFactory.parseCollectionId`). `VOTETORRENT_SCHEMA_SQL` has no
 * `using` clause, and the app tables are declared under the sApp schema, which the module names `app`
 * (measured on a real strand node, 2026-11-03: `default/app/TidHighWater`).
 *
 * Computed, not read off the strand read handle: the module builds a table's instance lazily, and a table
 * hydrated from the strand's catalog has none until something reads it, so the earlier lookup of the live
 * collection object found nothing on a real strand (mesh-read gate, 2026-11-03: "no live collection object
 * found for this table", subject Election). The plugin is not a declared dependency of this app, so its
 * exported `defaultCollectionUri` is not imported here; `test/node/collection-id.test.mjs` pins this
 * formula against it, and the vote-engine harness `public-edge-watch` pins it against a live strand node.
 */

/** The schema the module declares the sApp's tables under. @type {string} */
export const SAPP_SCHEMA_NAME = 'app';

/**
 * @param {string} table - a table name as `PUBLIC_SUBSCRIBED_TABLES` spells it
 * @returns {string}
 */
export function collectionIdForTable(table) {
	if (typeof table !== 'string' || table.length === 0) {
		throw new TypeError('collectionIdForTable: a table name is required');
	}
	return `default/${SAPP_SCHEMA_NAME}/${table}`;
}
