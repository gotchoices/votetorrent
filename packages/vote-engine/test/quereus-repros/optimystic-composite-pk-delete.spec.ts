import { expect } from 'chai';

/**
 * Optimystic plugin — composite-PRIMARY-KEY DELETE/UPDATE key-derivation bug.
 *
 * Upstream target: https://github.com/gotchoices/optimystic
 *   (packages/quereus-plugin-optimystic) — @optimystic/quereus-plugin-optimystic@0.13.5
 * Writeup: .planning/quick/260617-ji0-create-github-issue-for-optimystic-plugi/issues/
 *          optimystic-composite-pk-delete-update.md
 *
 * NOT Quereus#23. Core Quereus 3.3.0 DELETE works (see stage-6 repro + user.spec.ts revoke,
 * both green in-memory). This bug lives in the on-device Optimystic storage plugin.
 *
 * Mechanism:
 *   - Quereus core builds `oldKeyValues` for a delete/update as a COMPACTED, PK-only array in PK
 *     order: `pkColumnIndicesInSchema.map(idx => existingRow[idx])`
 *     (@quereus/quereus dist/src/runtime/emit/dml-executor.js:142).
 *     For UserKey (cols UserId(0), Type(1), PubKey(2), Expiration(3); PK at absolute indices [0,2])
 *     that is [UserId, PubKey] — a length-2 array at indices 0 and 1.
 *   - The plugin's RowCodec.extractPrimaryKey(row) indexes by ABSOLUTE schema column index
 *     `row[pkCol.index]` (dist/chunk-HPFDTDHY.js:820): row[0]=UserId OK, row[2]=undefined →
 *     serialized as a NULL sentinel. So the delete-path key != the stored key, and
 *     `collection.replace([[wrongKey, undefined]])` (chunk:1715) tombstones a non-existent key:
 *     the row survives and the delete is a silent no-op ({status:"ok"}).
 *   - Fix: derive the storage key from the compacted PK-only array with `createPrimaryKey(values)`
 *     (maps the array positionally), NOT `extractPrimaryKey(row)` — mirroring the existing read-path
 *     patch (.yarn/patches/@optimystic-...-6fbe2eccab.patch → executePointLookup → createPrimaryKey).
 *
 * Convention (per ./README.md): these tests assert the CURRENT (buggy) behavior so they pass today
 * and serve as the upstream reproduction. The behavioral end-to-end path
 * (OptimysticVirtualTable.update) additionally requires the Optimystic storage backend, which this
 * minimal repro intentionally avoids — it pins the exact key-derivation mismatch and the fix.
 */

// The plugin is installed under the app workspace, not vote-engine. Import the REAL RowCodec from
// there so the repro exercises actual plugin code. Skip gracefully if it cannot be resolved.
const PLUGIN_INDEX =
	'../../../../apps/VoteTorrentAuthority/node_modules/@optimystic/quereus-plugin-optimystic/dist/index.js';

type RowCodecCtor = new (
	schema: unknown,
	encoding?: string
) => {
	extractPrimaryKey(row: unknown[]): string;
	createPrimaryKey(values: unknown[]): string;
};

// UserKey shape: composite PK on non-contiguous absolute column indices (UserId@0, PubKey@2).
const userKeySchema = {
	columns: [{ name: 'UserId' }, { name: 'Type' }, { name: 'PubKey' }, { name: 'Expiration' }],
	primaryKeyDefinition: [{ index: 0 }, { index: 2 }],
};

const FULL_ROW = ['user-1', 'M', 'pubkey-abc', '2036-01-01'];
// What Quereus core hands the plugin as oldKeyValues for a delete (compacted, PK-only, PK order):
const COMPACTED_OLD_KEY_VALUES = ['user-1', 'pubkey-abc'];

describe('Optimystic plugin — composite-PK DELETE derives the wrong storage key (no-op delete)', () => {
	let RowCodec: RowCodecCtor | undefined;

	before(async function () {
		try {
			({ RowCodec } = (await import(PLUGIN_INDEX)) as { RowCodec: RowCodecCtor });
		} catch {
			RowCodec = undefined;
		}
		if (!RowCodec) {
			// Plugin not installed in this workspace — skip rather than fail the suite.
			this.skip();
		}
	});

	it('INSERT stores the row under extractPrimaryKey(fullRow) — the real key', () => {
		const codec = new RowCodec!(userKeySchema);
		const storedKey = codec.extractPrimaryKey(FULL_ROW);
		expect(storedKey).to.contain('user-1');
		expect(storedKey).to.contain('pubkey-abc'); // both PK parts present → correct composite key
	});

	it('BUG: DELETE key (extractPrimaryKey on compacted PK-only oldKeyValues) does NOT match the stored key', () => {
		const codec = new RowCodec!(userKeySchema);
		const storedKey = codec.extractPrimaryKey(FULL_ROW);
		// extractPrimaryKey reads row[pkCol.index] → row[2] is undefined for the length-2 compacted
		// array → the PubKey part is silently dropped.
		const deleteKey = codec.extractPrimaryKey(COMPACTED_OLD_KEY_VALUES);

		expect(deleteKey).to.not.equal(storedKey); // ← the delete tombstones a non-existent key
		expect(deleteKey).to.not.contain('pubkey-abc'); // PubKey lost
	});

	it('FIX: createPrimaryKey on the same compacted oldKeyValues yields the correct stored key', () => {
		const codec = new RowCodec!(userKeySchema);
		const storedKey = codec.extractPrimaryKey(FULL_ROW);
		// createPrimaryKey maps the compacted array positionally → both PK parts preserved.
		const fixedKey = codec.createPrimaryKey(COMPACTED_OLD_KEY_VALUES);

		expect(fixedKey).to.equal(storedKey);
	});

	it('CONTROL: single-column PK at index 0 is unaffected (explains why only composite PKs break)', () => {
		const singlePkSchema = {
			columns: [{ name: 'Id' }, { name: 'Name' }],
			primaryKeyDefinition: [{ index: 0 }],
		};
		const codec = new RowCodec!(singlePkSchema);
		const storedKey = codec.extractPrimaryKey(['id-1', 'Alice']);
		const deleteKey = codec.extractPrimaryKey(['id-1']); // compacted PK-only, length 1
		expect(deleteKey).to.equal(storedKey); // single PK at index 0 → no mismatch
	});
});
