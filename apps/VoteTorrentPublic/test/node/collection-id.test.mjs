/**
 * collection-id.test.mjs — pins `src/peer/collection-id.js` against the Optimystic plugin's own exported
 * `defaultCollectionUri`, so an upstream change to the default collection URI fails here rather than leaving
 * the page watching collections no block carries.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultCollectionUri } from '@optimystic/quereus-plugin-optimystic';
import { PUBLIC_SUBSCRIBED_TABLES } from '@votetorrent/web-data/public';
import { collectionIdForTable, SAPP_SCHEMA_NAME } from '../../src/peer/collection-id.js';

test('collectionIdForTable is the plugin\'s default collection URI without its tree:// scheme, for every public table', () => {
	for (const table of PUBLIC_SUBSCRIBED_TABLES) {
		const uri = defaultCollectionUri(SAPP_SCHEMA_NAME, table);
		assert.ok(uri.startsWith('tree://'), `the plugin's default URI changed shape: ${uri}`);
		assert.equal(collectionIdForTable(table), uri.slice('tree://'.length));
	}
});

test('collectionIdForTable refuses an empty or non-string table name', () => {
	for (const bad of ['', undefined, null, 42]) {
		assert.throws(() => collectionIdForTable(/** @type {any} */ (bad)), TypeError);
	}
});
