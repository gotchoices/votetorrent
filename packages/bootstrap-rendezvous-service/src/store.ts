import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { FileKVStore } from '@optimystic/db-p2p-storage-fs'
import { assertCanonicalBootstrapDatetime } from '@votetorrent/vote-engine/bootstrap'
import { assertSafeLookupId } from './claim.js'

/**
 * store.ts — the payload-free record store, the separate ciphertext store, and
 * the runtime network-handle census that keeps the distributed layer out.
 *
 * ## The import decision — recorded as a decision, not an accident
 *
 * `FileKVStore` is imported from the package BARREL
 * (`@optimystic/db-p2p-storage-fs`). A deep import is not an available option:
 * that package's `exports` map declares only `"."` (no `./*`, no `./dist/*`),
 * so a specifier such as `@optimystic/db-p2p-storage-fs/dist/src/file-kv-store.js`
 * is rejected by Node with `ERR_PACKAGE_PATH_NOT_EXPORTED`. The barrel import is
 * therefore FORCED, not chosen — `test/source-guards.spec.ts` proves that by
 * asserting the rejection code rather than trusting this paragraph.
 *
 * The consequence, stated plainly so nobody re-discovers it as a surprise: the
 * barrel is `export * from './file-storage.js'; export * from './file-kv-store.js'`,
 * and `file-storage.js:3` is a real runtime `import { KvRawStorage } from
 * "@optimystic/db-p2p"`. Importing this module therefore evaluates the
 * `@optimystic/db-p2p` barrel and, transitively, libp2p/kad-dht/gossipsub module
 * BODIES.
 *
 * **That is definition evaluation only.** Nothing binds a socket, dials a peer,
 * resolves a name or starts a node merely by being imported. The distributed
 * layer stays out functionally; the cost is install size and cold-start time,
 * not runtime behaviour. Because that is a claim about runtime rather than about
 * an import list, it is MEASURED — `assertNoNetworkHandleGrowth` below runs at
 * store construction, and `test/source-guards.spec.ts` runs the same census
 * around the first `import()` of this file. Neither is decorative: delete them
 * and the guarantee reverts to prose.
 *
 * Only `FileKVStore` is named here. `FileRawStorage`, `FileStoreDriver` and
 * `KvRawStorage` — the other half of the same barrel — are never imported and
 * never referenced; a source assertion enforces that.
 *
 * ## What this module deliberately does not do
 *
 * It does not read the service configuration. `createRendezvousStores` takes the
 * data root as a parameter, so this file has no import edge to `config.ts` and
 * every test is one `mkdtemp` away. Wiring the operator-configured path is the
 * caller's job.
 *
 * It does not parse, inspect, re-serialize or re-digest the sealed blob. The
 * ciphertext is an opaque string in and an opaque string out. Couriers do not
 * reject.
 */

/** Handle-kind prefixes that would indicate the process opened something
 * network-ish. The names observed on this Node line are `TCPServerWrap`,
 * `TCPSocketWrap`, `ConnectWrap` and `UDPWrap`; `Pipe`, `DNS` and
 * `ChildProcess` are included because each is a way out of the process. */
const NETWORK_HANDLE_PREFIXES = ['tcp', 'udp', 'pipe', 'connect', 'dns', 'childprocess']

/**
 * A sorted snapshot of the process's currently-live network-ish handles.
 *
 * Returns handle KIND names only — never an address, never a peer, never a
 * payload — so it is safe to put in an error message.
 */
export function captureNetworkHandleCensus (): string[] {
	return process.getActiveResourcesInfo()
		.filter((name) => NETWORK_HANDLE_PREFIXES.some((p) => name.toLowerCase().startsWith(p)))
		.sort()
}

/**
 * Throws if the census has GROWN since `before`.
 *
 * Growth, not an absolute count, is the right comparison: a caller may already
 * own an HTTP listener, and the question this answers is whether the code
 * between the two samples opened anything of its own. Compared as a multiset so
 * two handles of the same kind are distinguishable from one.
 */
export function assertNoNetworkHandleGrowth (before: string[], label: string): void {
	const remaining = before.slice()
	const added: string[] = []
	for (const name of captureNetworkHandleCensus()) {
		const at = remaining.indexOf(name)
		if (at === -1) added.push(name)
		else remaining.splice(at, 1)
	}
	if (added.length > 0) {
		throw new Error(
			`bootstrap-rendezvous-service: ${label} added network handles, which the distributed-layer exclusion forbids (added: ${added.sort().join(', ')})`
		)
	}
}

/**
 * The complete set of things the service is allowed to know about a rendezvous.
 *
 * Three fields. The service sees the derived look-up id, the expiry, and the
 * used-flag it needs to keep `used` vs `expired` answers precise after the
 * ciphertext has been erased — and NOTHING else. It cannot answer which
 * network, which authority, or how large the roll is, because it was never told.
 *
 * Adding a fourth field is a design violation, not an optimisation.
 * `test/store.spec.ts` asserts the SERIALIZED key set, so a fourth field cannot
 * be added quietly even by a caller that passes one in.
 */
export interface RendezvousRecord {
	lookupId: string
	/** Canonical 19-character datetime, no trailing `Z`. Compare it as a raw
	 * string; never route either side through a date parser. */
	expiresAt: string
	used: boolean
}

export interface RendezvousStores {
	dataDir: string
	claimsDir: string
	putRecord(r: RendezvousRecord): Promise<void>
	getRecord(lookupId: string): Promise<RendezvousRecord | undefined>
	markRecordUsed(lookupId: string): Promise<void>
	deleteRecord(lookupId: string): Promise<void>
	listRecordIds(): Promise<string[]>
	putCiphertext(lookupId: string, sealedJson: string): Promise<void>
	getCiphertext(lookupId: string): Promise<string | undefined>
	deleteCiphertext(lookupId: string): Promise<void>
}

/** The three-key projection, built as an explicit literal. Never a spread of a
 * caller's object — a spread is exactly how a fourth field leaks in, on the way
 * out as much as on the way in. */
function projectRecord (record: RendezvousRecord): RendezvousRecord {
	return {
		lookupId: record.lookupId,
		expiresAt: record.expiresAt,
		used: record.used === true
	}
}

/**
 * Builds the two stores rooted at `dataDir`, plus the claims directory.
 *
 * Records and ciphertext get SEPARATE `FileKVStore` basePaths. That is what
 * `file-kv-store.ts`'s own note tells callers to do: a KV key's first path
 * segment shares the top-level namespace with the raw store's block-id
 * directories, so two logical stores must never share one base. It is also what
 * makes them independently erasable — the ciphertext is dropped on serve and at
 * expiry while the payload-free record survives its grace window.
 */
export async function createRendezvousStores (dataDir: string): Promise<RendezvousStores> {
	const census = captureNetworkHandleCensus()

	await mkdir(dataDir, { recursive: true })
	const records = new FileKVStore(join(dataDir, 'records'))
	const ciphertext = new FileKVStore(join(dataDir, 'ciphertext'))
	const claimsDir = join(dataDir, 'claims')
	await mkdir(claimsDir, { recursive: true })

	const stores: RendezvousStores = {
		dataDir,
		claimsDir,

		async putRecord (record: RendezvousRecord): Promise<void> {
			// `lookupId` arrives off the wire and becomes a path segment via
			// `FileKVStore.keyToPath`. This guard is the path-traversal control and
			// runs before any key or path is constructed, with no exceptions.
			assertSafeLookupId(record.lookupId, 'putRecord lookupId')
			// The seam's own strict 19-char no-`Z` validator. NOT the canonical
			// normaliser, which silently STRIPS a trailing `Z` and would accept a
			// value this store must refuse. One implementation, imported — not a
			// fourth local reimplementation.
			assertCanonicalBootstrapDatetime(record.expiresAt, 'bootstrap-rendezvous-service: putRecord expiresAt')
			const persisted = projectRecord(record)
			await records.set(persisted.lookupId, JSON.stringify(persisted))
		},

		async getRecord (lookupId: string): Promise<RendezvousRecord | undefined> {
			assertSafeLookupId(lookupId, 'getRecord lookupId')
			const raw = await records.get(lookupId)
			if (raw === undefined) return undefined
			// Re-project on the way out too, so a record written by an older or
			// hostile writer cannot smuggle a fourth field back out of the store.
			return projectRecord(JSON.parse(raw) as RendezvousRecord)
		},

		async markRecordUsed (lookupId: string): Promise<void> {
			assertSafeLookupId(lookupId, 'markRecordUsed lookupId')
			const existing = await stores.getRecord(lookupId)
			if (existing === undefined) {
				throw new Error('bootstrap-rendezvous-service: markRecordUsed found no record')
			}
			// This is the RECORD-level fact, and it is what survives ciphertext
			// deletion so a later redemption can still answer `used` precisely
			// rather than degrading to `unknown`. It is NOT the atomic exclusion —
			// that is `claimSingleUse` in `claim.js`, and only that.
			await stores.putRecord({ lookupId: existing.lookupId, expiresAt: existing.expiresAt, used: true })
		},

		async deleteRecord (lookupId: string): Promise<void> {
			assertSafeLookupId(lookupId, 'deleteRecord lookupId')
			// `FileKVStore.delete` already swallows ENOENT.
			await records.delete(lookupId)
		},

		async listRecordIds (): Promise<string[]> {
			// `list` splits its prefix on `/` and filters empties, so `''` scans the
			// records basePath itself and returns bare `lookupId`s with `.json`
			// stripped — exactly what the retention sweeper enumerates.
			return records.list('')
		},

		async putCiphertext (lookupId: string, sealedJson: string): Promise<void> {
			assertSafeLookupId(lookupId, 'putCiphertext lookupId')
			// Opaque string in. The service never parses, re-serializes, re-digests
			// or inspects it — couriers do not reject. The blob is sealed
			// ciphertext, and the shipped envelope parser would throw on it, which
			// is precisely why that transport class is not wrapped here.
			await ciphertext.set(lookupId, sealedJson)
		},

		async getCiphertext (lookupId: string): Promise<string | undefined> {
			assertSafeLookupId(lookupId, 'getCiphertext lookupId')
			// Opaque string out, byte-for-byte as it was handed in.
			return ciphertext.get(lookupId)
		},

		async deleteCiphertext (lookupId: string): Promise<void> {
			assertSafeLookupId(lookupId, 'deleteCiphertext lookupId')
			// Leaves the record intact on purpose: ciphertext early, record later.
			await ciphertext.delete(lookupId)
		}
	}

	assertNoNetworkHandleGrowth(census, 'createRendezvousStores')
	return stores
}
