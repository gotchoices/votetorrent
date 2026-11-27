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

	// Re-anchored 2026-09-28 (with the @optimystic 1.7.0 bump, but NOT caused by it — the installed
	// 1.5.0 plugin already behaved this way, and this test and CONTROL below were two of develop's
	// standing failures). Upstream closed this bug in two ways. The update and delete
	// paths now derive the storage key with `createPrimaryKey(oldKeyTuple)` (installed dist, the
	// `oldKey`/`deleteKey` sites in OptimysticVirtualTable.update), AND `extractPrimaryKey` now THROWS on
	// a row shorter than the schema instead of silently reading `undefined` into the key. The old
	// assertion here ("the DELETE key does not match") pinned the silent mis-derivation, which can no
	// longer happen, so it is re-anchored to the loud failure that replaced it.
	it('FIXED upstream: extractPrimaryKey refuses a compacted PK-only tuple instead of silently dropping PubKey', () => {
		const codec = new RowCodec!(userKeySchema);
		expect(() => codec.extractPrimaryKey(COMPACTED_OLD_KEY_VALUES)).to.throw(/requires a full row of 4 columns, got 2/);
	});

	it('FIX: createPrimaryKey on the same compacted oldKeyValues yields the correct stored key', () => {
		const codec = new RowCodec!(userKeySchema);
		const storedKey = codec.extractPrimaryKey(FULL_ROW);
		// createPrimaryKey maps the compacted array positionally → both PK parts preserved.
		const fixedKey = codec.createPrimaryKey(COMPACTED_OLD_KEY_VALUES);

		expect(fixedKey).to.equal(storedKey);
	});

	it('CONTROL: a single-column PK at index 0 keys identically via createPrimaryKey on the compacted tuple', () => {
		const singlePkSchema = {
			columns: [{ name: 'Id' }, { name: 'Name' }],
			primaryKeyDefinition: [{ index: 0 }],
		};
		const codec = new RowCodec!(singlePkSchema);
		const storedKey = codec.extractPrimaryKey(['id-1', 'Alice']);
		// Before the upstream fix `extractPrimaryKey(['id-1'])` also matched here, which is why only composite PKs
		// broke. It now throws on the short row (see the test above); the positional path is the one the
		// plugin's delete uses.
		expect(codec.createPrimaryKey(['id-1'])).to.equal(storedKey);
	});
});
