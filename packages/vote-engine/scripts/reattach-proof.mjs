// reattach-proof.mjs — scripted re-attach proof harness (Phase 51 Plan 05, Task 3, D-10/D-11).
//
// Proves that an EXISTING on-disk database, created under the PRE-change
// `AttestationChallenge` schema (Expiration column + both CHECKs + the 7-arg
// InsertValid digest), re-attaches cleanly against the POST-change schema
// (no Expiration, 6-arg digest) — WITHOUT emitting `ALTER COLUMN`, and with
// its pre-existing rows still readable. A jest run against an in-memory
// Database() cannot exercise this: Quereus 4.x re-attach reconcile has
// emitted unsupported `ALTER COLUMN` for far smaller changes, invisibly to
// the Node suite (51-CONTEXT.md D-10). This script forces a REAL on-disk
// store and a REAL process-boundary-shaped re-open.
//
// Two real modes, driven by run-reattach-proof.sh:
//   node reattach-proof.mjs --seed <dbPath> --schema <file> [--negative-control]
//   node reattach-proof.mjs --reopen <dbPath> [--expected-counts <file>] [--baseline-schema <file>]
//                           [--seed-manifest <file>] [--negative-control]
//
// --seed applies the schema read from <file> (a `schema-sql.ts`-shaped module
// exporting `VOTETORRENT_SCHEMA_SQL`) to a FRESH on-disk store at <dbPath>,
// then runs the real ceremony (Network -> Authority -> officer -> Registrant
// -> AttestationChallenge, all through the real vote-engine classes so the
// schema's own CHECKs are honestly satisfied, never bypassed) and prints row
// COUNTS only.
//
// --reopen applies the CURRENT bundled schema (schema-sql.ts as shipped) to
// the SAME on-disk path in a FRESH process-equivalent Database handle, and
// asserts: (1) re-attach did not throw, (2) no error text contains
// `ALTER COLUMN`, (3) the pre-existing rows are still readable with the
// EXACT row count the seed step reported. Exits non-zero on any FAIL.
//
// --negative-control swaps the real votetorrent schema/ceremony for a TINY
// one-table schema and, on --reopen, feeds it a SYNTACTICALLY INVALID DDL
// string in place of a real schema. This exists so the harness itself is
// proven able to FAIL — a script that has only ever printed PASS proves
// nothing (project standing rule: "the harness must be able to fail").
//
// This shape was chosen ONLY after probing several genuinely-structural
// incompatible changes against this repo's pinned/patched Quereus version
// (4.14.0 + local patch) and finding all of them reconcile WITHOUT throwing:
// a primary-key column type change (integer -> text), adding a NOT NULL
// column with no default to a table with existing rows, and a boolean ->
// text column type change all completed silently. That is itself a real,
// disclosed finding (recorded in 51-05-SUMMARY.md) — this version's DDL
// differ is markedly permissive rather than a hard structural validator. A
// malformed DDL string is the one incompatibility class that reliably still
// throws (a parse-time failure, not a reconcile-time one), so it is what
// proves the harness's FAIL path fires for real rather than always printing
// PASS.
//
// WR-11 (51-REVIEW) — WHAT THIS HARNESS DOES NOT ESTABLISH. Because the control
// is reduced to a PARSE failure, this harness cannot detect a RECONCILE
// incompatibility — which is the only class D-10's column removal could
// plausibly hit. Its result is therefore a NO-REGRESSION observation ("re-attach
// did not throw, the rows are still readable, the column is gone"), NOT a proof
// that the D-10 schema change is safe on a real on-disk store, and
// `run-reattach-proof.sh`'s final line says so in those words. Anyone wanting a
// real reconcile assertion must dump the POST-REATTACH table schema and diff it
// against the expected DDL rather than relying on an exception being raised.
//
// STORAGE. Neither `@quereus/plugin-leveldb` nor any other new package is
// installed for this. A minimal Node `fs`-backed `KVStoreProvider` is
// implemented below (`FsKVStoreProvider`), wrapping `@quereus/store`'s own
// `InMemoryKVStore` with eager whole-file JSON persistence on every mutation
// — correct, simple, and sufficient for a low-volume proof harness. It is
// NOT a production storage backend and must never be imported from `src/`.
//
// OUTPUT DISCIPLINE. Row COUNTS and column/table NAMES only. Never a private
// key, a signature, or registrant PII — enforced by an acceptance criterion
// that greps this script's captured output for a 40+ character hex/base64
// run and requires zero matches.

import 'reflect-metadata'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { Database } from '@quereus/quereus'
import {
	createIsolatedStoreModule,
	InMemoryKVStore,
	buildDataStoreName,
	buildIndexStoreName,
	CATALOG_STORE_NAME,
	STATS_STORE_NAME,
} from '@quereus/store'

import {
	registerDbPlugins,
	initDB,
	isSchemaInitialized,
	setSchemaSql,
} from '../src/database/initialize.js'
import { allocateTid } from '../src/database/tid-allocator.js'
import { seedSignedMutation } from '../src/signing/signed-mutation.js'
import { toIsoZDatetime, toDeferredCheckDatetime } from '../src/signing/ceremony-helpers.js'
import { nowCanonicalDatetime, digestToBytes } from '../src/utils.js'
import { NetworksEngine } from '../src/networks/networks-engine.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { AsyncStorage } from '../test/shims/react-native.js'
import { randomTestKeyPair } from '../test/fixtures/keys.js'

// ---------------------------------------------------------------------------
// Minimal Node fs-backed KVStoreProvider — see the file header.
// ---------------------------------------------------------------------------

/**
 * Wraps `@quereus/store`'s `InMemoryKVStore` with eager, whole-store JSON
 * persistence on every mutating call. Correct (delegates all KVStore
 * semantics — iteration ordering, batch atomicity-within-the-batch, etc. —
 * to the upstream in-memory implementation) and intentionally simple: this
 * is a proof-harness backend, not a production one.
 */
class FsPersistedKVStore {
	#inner = new InMemoryKVStore()
	#filePath
	#loaded = false

	constructor (filePath) {
		this.#filePath = filePath
	}

	async #ensureLoaded () {
		if (this.#loaded) return
		this.#loaded = true
		if (existsSync(this.#filePath)) {
			const raw = JSON.parse(readFileSync(this.#filePath, 'utf8'))
			for (const [keyB64, valueB64] of raw) {
				await this.#inner.put(
					new Uint8Array(Buffer.from(keyB64, 'base64')),
					new Uint8Array(Buffer.from(valueB64, 'base64'))
				)
			}
		}
	}

	async #persist () {
		const entries = []
		for await (const e of this.#inner.iterate()) {
			entries.push([
				Buffer.from(e.key).toString('base64'),
				Buffer.from(e.value).toString('base64'),
			])
		}
		writeFileSync(this.#filePath, JSON.stringify(entries))
	}

	async get (key) {
		await this.#ensureLoaded()
		return this.#inner.get(key)
	}

	async getMany (keys) {
		await this.#ensureLoaded()
		return this.#inner.getMany(keys)
	}

	async put (key, value, options) {
		await this.#ensureLoaded()
		await this.#inner.put(key, value, options)
		await this.#persist()
	}

	async delete (key, options) {
		await this.#ensureLoaded()
		await this.#inner.delete(key, options)
		await this.#persist()
	}

	async has (key) {
		await this.#ensureLoaded()
		return this.#inner.has(key)
	}

	iterate (options) {
		const self = this
		return (async function * () {
			await self.#ensureLoaded()
			yield * self.#inner.iterate(options)
		})()
	}

	batch () {
		const innerBatch = this.#inner.batch()
		return {
			put: (k, v) => innerBatch.put(k, v),
			delete: (k) => innerBatch.delete(k),
			write: async () => {
				await this.#ensureLoaded()
				await innerBatch.write()
				await this.#persist()
			},
			clear: () => innerBatch.clear(),
		}
	}

	async close () {
		// Already durable after every mutation — nothing to flush.
	}

	async approximateCount (options) {
		await this.#ensureLoaded()
		return this.#inner.approximateCount(options)
	}
}

/**
 * Minimal `KVStoreProvider` — a real on-disk directory, one JSON file per
 * logical store (data / index / stats / catalog), named via `@quereus/store`'s
 * own `buildDataStoreName`/`buildIndexStoreName` so this provider follows the
 * documented naming convention rather than inventing its own. `deleteIndexStore`
 * / `deleteTableStores` / `renameTable` are intentionally NOT implemented
 * (optional on the interface) — this harness never drops or renames a table.
 */
class FsKVStoreProvider {
	#dir
	#stores = new Map()

	constructor (dir) {
		this.#dir = dir
		mkdirSync(dir, { recursive: true })
	}

	#open (logicalName) {
		let store = this.#stores.get(logicalName)
		if (!store) {
			const safeName = encodeURIComponent(logicalName)
			store = new FsPersistedKVStore(join(this.#dir, `${safeName}.json`))
			this.#stores.set(logicalName, store)
		}
		return store
	}

	async getStore (schemaName, tableName) {
		return this.#open(buildDataStoreName(schemaName, tableName))
	}

	async getIndexStore (schemaName, tableName, indexName) {
		return this.#open(buildIndexStoreName(schemaName, tableName, indexName))
	}

	async getStatsStore () {
		return this.#open(STATS_STORE_NAME)
	}

	async getCatalogStore () {
		return this.#open(CATALOG_STORE_NAME)
	}

	async closeStore (schemaName, tableName) {
		await this.#open(buildDataStoreName(schemaName, tableName)).close()
	}

	async closeIndexStore (schemaName, tableName, indexName) {
		await this.#open(buildIndexStoreName(schemaName, tableName, indexName)).close()
	}

	async closeAll () {
		for (const s of this.#stores.values()) await s.close()
	}
}

/** Builds a `DbFactory`-shaped function (matches `packages/vote-engine/src/types.ts`) over one on-disk directory. */
function makeDbFactory (dir) {
	const provider = new FsKVStoreProvider(dir)
	return async function fsDbFactory (_networkHash) {
		const db = new Database()
		const storeModule = createIsolatedStoreModule({ provider })
		db.registerModule('store', storeModule)
		db.setDefaultVtabName('store')
		return db
	}
}

// ---------------------------------------------------------------------------
// Negative-control fixture — a KNOWN Quereus re-attach defect class, not the
// real votetorrent schema. See the file header.
// ---------------------------------------------------------------------------

const NEG_OLD_SCHEMA = `declare schema main {
	table NegControl (
		Id integer primary key,
		Flag boolean default true
	);
} apply schema main;`

// Deliberately malformed — see the NEGATIVE CONTROL comment in the file header for why a
// syntax-level incompatibility (not a structural one) is what this harness uses.
const NEG_NEW_SCHEMA = `declare schema main {
	table NegControl (
		Id integer primary key,
		Flag !!!not-a-valid-type!!!
	);
} apply schema main;`

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
function flagValue (name) {
	const i = argv.indexOf(name)
	return i >= 0 ? argv[i + 1] : undefined
}
const negativeControl = argv.includes('--negative-control')
const seedPath = flagValue('--seed')
const reopenPath = flagValue('--reopen')
const schemaFile = flagValue('--schema')
// 62-03 (D-22): generalizes this harness to run against ANY baseline, not just the
// hardcoded pre-Phase-51 AttestationChallenge shape — a phase-62 baseline has neither
// the Expiration column nor the 7-arg digest.
const baselineSchemaFile = flagValue('--baseline-schema')

if (!seedPath && !reopenPath) {
	console.error('usage: node reattach-proof.mjs --seed <dbPath> --schema <file> [--negative-control]')
	console.error('       node reattach-proof.mjs --reopen <dbPath> [--expected-counts <file>] [--baseline-schema <file>] [--seed-manifest <file>] [--negative-control]')
	process.exit(2)
}

async function loadSchemaSqlFrom (file) {
	const mod = await import(pathToFileURL(file).href)
	const sql = mod.VOTETORRENT_SCHEMA_SQL
	if (typeof sql !== 'string' || sql.length < 100) {
		throw new Error(`${file} did not export a VOTETORRENT_SCHEMA_SQL string`)
	}
	return sql
}

// ---------------------------------------------------------------------------
// --seed
// ---------------------------------------------------------------------------

async function runSeed (dbPath) {
	if (negativeControl) {
		setSchemaSql(NEG_OLD_SCHEMA)
		const dbFactory = makeDbFactory(dbPath)
		const db = await dbFactory('reattach-proof-negative')
		await registerDbPlugins(db)
		await initDB(db)
		await db.exec('insert into NegControl (Id, Flag) values (1, true)')
		const row = await db.prepare('select count(*) as n from NegControl').get()
		await db.close()
		console.log(JSON.stringify({ mode: 'seed', negativeControl: true, dbPath, counts: { NegControl: Number(row?.n ?? 0) } }, null, 2))
		return
	}

	if (!schemaFile) {
		console.error('--seed requires --schema <file> (unless --negative-control is set)')
		process.exit(2)
	}
	const oldSchemaSql = await loadSchemaSqlFrom(schemaFile)
	setSchemaSql(oldSchemaSql)

	const dbFactory = makeDbFactory(dbPath)
	const networksEngine = new NetworksEngine(AsyncStorage, dbFactory)

	// A real secp256k1 key pair for the founding officer — never printed.
	const { privateHex, publicHex } = randomTestKeyPair()
	const userId = 'reattach-proof-officer'
	const user = {
		id: userId,
		name: 'Reattach Proof Officer',
		imageRef: { url: 'https://img.local/reattach-proof.png' },
		activeKeys: [{ key: publicHex, type: 'mobile', expiration: Date.now() + 86_400_000 }],
	}
	const sign = async (digest) => ({
		signerUserId: userId,
		signerKey: publicHex,
		signature: bytesToHex(secp256k1.sign(digest, hexToBytes(privateHex))),
	})

	const networkInit = {
		name: 'Reattach Proof Network',
		imageUrl: 'https://cdn.example.com/logo.png',
		relays: ['/dns4/relay.example.com/tcp/443/wss'],
		primaryAuthority: { name: 'Reattach Proof Authority', domainName: 'reattach-proof.example.com' },
		admin: {
			officers: [
				{ init: { name: 'Reattach Proof Officer', title: 'Chair', scopes: ['rn', 'rad', 'vrg', 'iad', 'uai', 'mel', 'ceb'] } },
			],
			effectiveAt: Date.now(),
			thresholdPolicies: [{ policy: 'rad', threshold: 1 }],
		},
		policies: {
			timestampAuthorities: [{ url: 'https://tsa.example.com' }],
			numberRequiredTSAs: 1,
			electionType: 'a',
		},
	}

	// 1. Network + primary Authority + founding officer, via the REAL create() ceremony
	//    (same code path the app uses) — never a raw INSERT bypassing the schema's CHECKs.
	const networkEngine = await networksEngine.create(networkInit, user)
	const recents = (await AsyncStorage.getItem('recentNetworks')) ?? []
	const ref = recents[0]
	if (!ref) throw new Error('runSeed: no network reference after create()')
	const ctx = networksEngine.contexts.get(ref.hash)
	if (!ctx) throw new Error('runSeed: no cached context after create()')

	const details = await networkEngine.getDetails()
	const authorityEngine = await networkEngine.openAuthority(details.network.primaryAuthorityId)
	const authorityDetails = await authorityEngine.getDetails()
	const authorityId = authorityDetails.authority.id

	// 2. Registrant, via the REAL RegistrationEngine (Registrant's DDL is untouched by 51-05 —
	//    identical under the old and current schema — so the current engine method is faithful here).
	const registrationEngine = new RegistrationEngine(ctx)
	const registrantId = 'reattach-proof-registrant'
	await registrationEngine.createRegistrant(
		{
			id: registrantId,
			authorityId,
			privateCid: 'reattach-proof-private-cid-placeholder',
			expiration: '2099-01-01T00:00:00.000Z',
		},
		sign
	)

	// 3. AttestationChallenge — 62-03 (D-22): the challenge SHAPE is now detected from the
	//    OLD schema text itself, rather than hardcoded, so this harness works against any
	//    baseline. Extract the `table AttestationChallenge (` block (from that text up to
	//    the first line that is exactly a tab then `)`); `legacyChallenge` is true iff the
	//    block declares an `Expiration` column.
	const challengeBlockMatch = oldSchemaSql.match(/\ttable AttestationChallenge \([\s\S]*?\n\t\)/)
	if (!challengeBlockMatch) {
		throw new Error('runSeed: could not locate `table AttestationChallenge (` in the baseline schema')
	}
	const challengeBlock = challengeBlockMatch[0]
	const legacyChallenge = /^\s*Expiration\s/m.test(challengeBlock)

	const deviceKey = randomTestKeyPair().publicHex
	const tid = await allocateTid(ctx.db, 'association')
	const nonce = crypto.randomUUID()
	const electionIdValue = null

	if (legacyChallenge) {
		// Pre-Phase-51 shape: `Digest(Tid, Nonce, AuthorityId, RegistrantId, DeviceKey,
		// ElectionId, Expiration)`, with `Expiration` deferred-check-normalized.
		const expirationZ = toIsoZDatetime(Date.now() + 600_000)
		const expirationDeferred = toDeferredCheckDatetime(expirationZ)
		const digestExpr = 'select Digest(:tid, :challengeNonce, :challengeAuthorityId, :registrantId, :deviceKey, :electionId, :expirationDeferred) as d'
		const digestParams = {
			tid, challengeNonce: nonce, challengeAuthorityId: authorityId, registrantId,
			deviceKey, electionId: electionIdValue, expirationDeferred,
		}
		const signingNonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, sign)
		await ctx.db.exec(
			`insert into AttestationChallenge (Nonce, AuthorityId, RegistrantId, DeviceKey, ElectionId, Expiration)
			 with context SigningNonce = :signingNonce, Tid = ${tid}, now = :now
			 values (:nonce, :authorityId, :registrantId, :deviceKey, :electionId, :expiration)`,
			{
				nonce, authorityId, registrantId, deviceKey, electionId: electionIdValue,
				expiration: expirationZ, signingNonce, now: nowCanonicalDatetime(),
			}
		)
	} else {
		// Current (post-51-05) shape: 6-arg digest, no Expiration column, context
		// (SigningNonce, Tid) only.
		const digestExpr = 'select Digest(:tid, :challengeNonce, :challengeAuthorityId, :registrantId, :deviceKey, :electionId) as d'
		const digestParams = {
			tid, challengeNonce: nonce, challengeAuthorityId: authorityId, registrantId,
			deviceKey, electionId: electionIdValue,
		}
		const signingNonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, sign)
		await ctx.db.exec(
			`insert into AttestationChallenge (Nonce, AuthorityId, RegistrantId, DeviceKey, ElectionId)
			 with context SigningNonce = :signingNonce, Tid = ${tid}
			 values (:nonce, :authorityId, :registrantId, :deviceKey, :electionId)`,
			{ nonce, authorityId, registrantId, deviceKey, electionId: electionIdValue, signingNonce }
		)
	}

	// 4. 62-46 / 62-49 (D-22, CR-01, D-07): the decision-row SHAPE is chosen from the BASELINE's own
	//    decision-table CHECK text, never assumed:
	//      absent                - the baseline declares neither decision table: nothing is seeded.
	//      legacy-non-conforming - both tables declare only the length-only CursorWidth check: seed
	//                              one astral-cursor row each (16 UTF-16 units: 14 zeros + one astral
	//                              code point), legal there but violating the current
	//                              CursorWellFormed. This exercises the real drift trap (amending a
	//                              CHECK on a live table already holding violating rows).
	//      conforming            - both tables already declare CursorWellFormed: that baseline cannot
	//                              hold a non-conforming row, so seed 16-digit rows. The drift-trap leg
	//                              is therefore only exercised against a pre-0655ea77 baseline such
	//                              as 1c7e3593.
	//    Signed over the same Digest arguments the transports use, by the founding officer (who
	//    holds vrg). The seeded cursors are printed so --reopen compares against what was SEEDED.
	const decisionCheckKind = (table) => {
		const m = oldSchemaSql.match(new RegExp('\\ttable ' + table + ' \\([\\s\\S]*?\\n\\t\\)'))
		if (!m) return 'none'
		const lines = m[0].split('\n').filter((l) => !/^\s*--/.test(l))
		const wellFormed = lines.some((l) => l.includes('constraint CursorWellFormed check'))
		const width = lines.some((l) => l.includes('constraint CursorWidth check (length(new.Cursor) = 16)'))
		if (wellFormed) return 'cursor-well-formed'
		if (width) return 'cursor-width'
		return 'unknown'
	}
	const regKind = decisionCheckKind('RegistrationDecision')
	const assocKind = decisionCheckKind('AssociationDecision')
	let decisionShape
	if (regKind === 'none' && assocKind === 'none') decisionShape = 'absent'
	else if (regKind === 'cursor-width' && assocKind === 'cursor-width') decisionShape = 'legacy-non-conforming'
	else if (regKind === 'cursor-well-formed' && assocKind === 'cursor-well-formed') decisionShape = 'conforming'
	else throw new Error(`runSeed: unsupported decision-table baseline (RegistrationDecision=${regKind}, AssociationDecision=${assocKind})`)
	const seededDecisionCursors = {}
	if (decisionShape !== 'absent') {
		const decidedAt = toIsoZDatetime(Date.now())
		const strandId = 'reattach-proof-strand'
		const regCursor = decisionShape === 'legacy-non-conforming' ? '00000000000000' + String.fromCodePoint(0x1F600) : '0000000000000001'
		const assocCursor = decisionShape === 'legacy-non-conforming' ? '00000000000000' + String.fromCodePoint(0x1F601) : '0000000000000002'
		const regRequestId = 'reattach-proof-legacy-reg'
		const regDigest = (await ctx.db.prepare("select Digest('RegistrationDecision', :strandId, :requestId, :authorityId, :status, :reason, :closesRequestId, :decidedAt) as d")
			.get({ strandId, requestId: regRequestId, authorityId, status: 'a', reason: null, closesRequestId: null, decidedAt }))?.d
		const regSig = await sign(digestToBytes(regDigest))
		await ctx.db.exec(
			`insert into RegistrationDecision (StrandId, Cursor, RequestId, AuthorityId, Status, Reason, ClosesRequestId, DecidedAt, DeciderKey, DeciderSignature)
			 with context now = :now
			 values (:strandId, :cursor, :requestId, :authorityId, :status, :reason, :closesRequestId, :decidedAt, :deciderKey, :deciderSignature)`,
			{ strandId, cursor: regCursor, requestId: regRequestId, authorityId, status: 'a', reason: null, closesRequestId: null, decidedAt, deciderKey: regSig.signerKey, deciderSignature: regSig.signature, now: nowCanonicalDatetime() }
		)
		const assocRequestId = 'reattach-proof-legacy-assoc'
		const assocDigest = (await ctx.db.prepare("select Digest('AssociationDecision', :strandId, :requestId, :authorityId, :status, :challengeNonce, :reason, :revokesDeviceKey, :matchMethod, :decidedAt) as d")
			.get({ strandId, requestId: assocRequestId, authorityId, status: 'a', challengeNonce: null, reason: null, revokesDeviceKey: null, matchMethod: 'code', decidedAt }))?.d
		const assocSig = await sign(digestToBytes(assocDigest))
		await ctx.db.exec(
			`insert into AssociationDecision (StrandId, Cursor, RequestId, AuthorityId, Status, ChallengeNonce, Reason, RevokesDeviceKey, MatchMethod, DecidedAt, DeciderKey, DeciderSignature)
			 with context now = :now
			 values (:strandId, :cursor, :requestId, :authorityId, :status, :challengeNonce, :reason, :revokesDeviceKey, :matchMethod, :decidedAt, :deciderKey, :deciderSignature)`,
			{ strandId, cursor: assocCursor, requestId: assocRequestId, authorityId, status: 'a', challengeNonce: null, reason: null, revokesDeviceKey: null, matchMethod: 'code', decidedAt, deciderKey: assocSig.signerKey, deciderSignature: assocSig.signature, now: nowCanonicalDatetime() }
		)
		seededDecisionCursors.RegistrationDecision = regCursor
		seededDecisionCursors.AssociationDecision = assocCursor
	}

	const counts = {}
	const countedTables = ['Authority', 'Registrant', 'AttestationChallenge', 'Admin', 'Officer', 'UserKey']
	if (decisionShape !== 'absent') countedTables.push('RegistrationDecision', 'AssociationDecision')
	for (const table of countedTables) {
		const row = await ctx.db.prepare(`select count(*) as n from ${table}`).get()
		counts[table] = Number(row?.n ?? 0)
	}

	await ctx.db.close()
	console.log(JSON.stringify({
		mode: 'seed', negativeControl: false, dbPath,
		challengeShape: legacyChallenge ? 'legacy-7-arg' : 'current-6-arg',
		decisionShape,
		seededDecisionCursors,
		counts,
	}, null, 2))
}

// ---------------------------------------------------------------------------
// --reopen
// ---------------------------------------------------------------------------

async function runReopen (dbPath) {
	if (negativeControl) {
		setSchemaSql(NEG_NEW_SCHEMA)
	} else {
		setSchemaSql(undefined) // use the CURRENT bundled schema (schema-sql.ts as shipped)
	}

	const dbFactory = makeDbFactory(dbPath)
	const db = await dbFactory(negativeControl ? 'reattach-proof-negative' : 'reattach-proof')
	await registerDbPlugins(db)

	const assertions = { noThrow: false, noAlterColumn: false, rowsReadable: false }
	let thrownMessage = ''

	try {
		if (!db.declaredSchemaManager.hasDeclaredSchema('main')) {
			await initDB(db)
		}
		assertions.noThrow = true
	} catch (error) {
		thrownMessage = error?.message ?? String(error)
	}
	// WR-11 (51-REVIEW): on the happy path `thrownMessage` is empty, so this assertion passes
	// WITHOUT INSPECTING ANYTHING the reconcile actually did. It is a NEGATIVE assertion about
	// the error text — "if re-attach threw, it was not an ALTER COLUMN rejection" — and nothing
	// more. Do not read a `true` here as "the reconcile emitted no ALTER COLUMN"; only a `false`
	// carries information. Reported as-is rather than removed, because it is exactly the
	// D-05b/D-15 regression signal when re-attach DOES throw.
	assertions.noAlterColumn = !thrownMessage.includes('ALTER COLUMN')

	if (negativeControl) {
		// EXPECTED to fail: NEG_NEW_SCHEMA is deliberately malformed DDL. A harness that
		// reports PASS here would be a harness that can never fail — see the file header.
		const detectedIncompatibility = !assertions.noThrow
		console.log(JSON.stringify({
			mode: 'reopen', negativeControl: true, dbPath,
			assertions, thrownMessage,
			verdict: detectedIncompatibility ? 'FAIL (expected — incompatible schema correctly rejected)' : 'PASS (UNEXPECTED — harness malfunction, see below)',
		}, null, 2))
		if (!detectedIncompatibility) {
			// Distinct exit code (3), NOT 1: this is the harness failing to detect a real
			// incompatibility — a malfunction, not the expected "re-attach correctly rejected
			// this schema" outcome. run-reattach-proof.sh must be able to tell the two apart.
			console.error('NEGATIVE CONTROL FAILED: the harness did NOT detect a genuinely incompatible schema.')
			process.exit(3)
		}
		// The re-attach genuinely failed, as expected. Exit 1: "the script FAILS" — the
		// negative control's job is to prove the harness CAN fail, not to itself pass.
		process.exit(1)
	}

	if (!assertions.noThrow) {
		console.log(JSON.stringify({ mode: 'reopen', negativeControl: false, dbPath, assertions, thrownMessage, verdict: 'FAIL' }, null, 2))
		process.exit(1)
	}

	let initialized = false
	try {
		initialized = await isSchemaInitialized(db)
	} catch (error) {
		thrownMessage = error?.message ?? String(error)
	}
	if (!initialized) {
		console.log(JSON.stringify({ mode: 'reopen', negativeControl: false, dbPath, assertions, thrownMessage, verdict: 'FAIL (SchemaInit marker not found after re-attach)' }, null, 2))
		process.exit(1)
	}

	const expectedCountsPath = flagValue('--expected-counts')
	let expectedCounts
	if (expectedCountsPath && existsSync(expectedCountsPath)) {
		expectedCounts = JSON.parse(readFileSync(expectedCountsPath, 'utf8'))
	}

	// 62-03 (D-22): counted tables extended with Admin/Officer/UserKey (seeded by
	// NetworksEngine.create() in runSeed) on top of the three original tables.
	const counts = {}
	// 62-46: the decision tables are counted whenever the seed counted them (and the current schema
	// always declares them), so --expected-counts equality covers them too.
	const reopenTables = ['Authority', 'Registrant', 'AttestationChallenge', 'Admin', 'Officer', 'UserKey']
	for (const t of ['RegistrationDecision', 'AssociationDecision']) {
		if (expectedCounts && t in expectedCounts) reopenTables.push(t)
	}
	for (const table of reopenTables) {
		const row = await db.prepare(`select count(*) as n from ${table}`).get()
		counts[table] = Number(row?.n ?? 0)
	}
	// rowsReadable stays exactly the original three-table non-zero check (unaffected by the
	// wider count set) — then require EQUALITY for every key present in --expected-counts,
	// not just the original three.
	assertions.rowsReadable = counts.Authority > 0 && counts.Registrant > 0 && counts.AttestationChallenge > 0
	if (expectedCounts) {
		for (const key of Object.keys(expectedCounts)) {
			if (counts[key] !== expectedCounts[key]) {
				assertions.rowsReadable = false
			}
		}
	}

	// 62-49 (D-22, CR-01, WR-01): the decision leg compares the observed cursors to the SEEDED
	// cursors recorded in the seed manifest, never to hardcoded literals. null means "not
	// exercised"; only an explicit false fails the verdict, and an unusable manifest fails closed.
	assertions.decisionCursorsIntact = null
	assertions.legacyDecisionCursorsIntact = null
	let manifestConsistent = true
	let decisionLeg = null
	let decisionLegProblem = null
	let manifest = null
	const manifestPath = flagValue('--seed-manifest')
	if (manifestPath && existsSync(manifestPath)) {
		manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
	}
	const decisionTables = ['RegistrationDecision', 'AssociationDecision']
	const countsHaveDecision = decisionTables.map((t) => !!expectedCounts && t in expectedCounts)
	const shape = manifest?.decisionShape ?? null
	const seededCursors = manifest?.seededDecisionCursors ?? {}
	if (!manifest) {
		if (countsHaveDecision.some(Boolean)) {
			manifestConsistent = false
			decisionLegProblem = 'expected counts include the decision tables but no --seed-manifest was given'
		}
	} else if (!['absent', 'legacy-non-conforming', 'conforming'].includes(shape)) {
		manifestConsistent = false
		decisionLegProblem = `unrecognized decisionShape in the seed manifest: ${String(shape)}`
	} else if (shape === 'absent' && countsHaveDecision.some(Boolean)) {
		manifestConsistent = false
		decisionLegProblem = 'manifest says decisionShape=absent but expected counts include a decision table'
	} else if (shape !== 'absent' && !countsHaveDecision.every(Boolean)) {
		manifestConsistent = false
		decisionLegProblem = `manifest says decisionShape=${shape} but expected counts lack a decision table`
	} else if (shape !== 'absent' && !decisionTables.every((t) => typeof seededCursors[t] === 'string' && seededCursors[t].length > 0)) {
		manifestConsistent = false
		decisionLegProblem = 'manifest is missing a seeded cursor for a decision table'
	}
	const observedCursors = {}
	if (manifestConsistent && shape === 'absent') {
		decisionLeg = 'skipped-absent'
	} else if (manifestConsistent && manifest) {
		let intact = true
		for (const table of decisionTables) {
			const rows = []
			for await (const r of db.eval(`select Cursor from ${table}`)) rows.push(r)
			observedCursors[table] = rows.map((r) => r.Cursor)
			if (rows.length !== 1 || rows[0].Cursor !== seededCursors[table]) intact = false
		}
		const allConforming = decisionTables.every((t) => /^[0-9]{16}$/.test(seededCursors[t]))
		const noneConforming = decisionTables.every((t) => !/^[0-9]{16}$/.test(seededCursors[t]))
		if (shape === 'legacy-non-conforming') {
			assertions.decisionCursorsIntact = intact
			assertions.legacyDecisionCursorsIntact = intact && noneConforming
			decisionLeg = 'legacy-checked'
		} else {
			assertions.decisionCursorsIntact = intact && allConforming
			decisionLeg = 'conforming-checked'
		}
	}

	// Column-shape proof: the reopened row must NOT carry an Expiration column any more
	// (the post-change schema dropped it) — select * and check the column set directly.
	const challengeRow = await db.prepare('select * from AttestationChallenge limit 1').get()
	const columnNames = challengeRow ? Object.keys(challengeRow) : []
	const expirationGone = !columnNames.includes('Expiration')

	// 62-03 (D-22): new-table queryability. When --baseline-schema is given, every table
	// the CURRENT bundled schema declares that the baseline did NOT must be queryable
	// (select count(*) does not throw) and empty (the re-attach replayed no rows for it —
	// it is new since the baseline).
	let newTables = null
	let newTablesQueryable = null
	if (baselineSchemaFile) {
		// Load via the SAME module-import path --seed uses (loadSchemaSqlFrom), not a raw
		// readFileSync: the baseline file is a `schema-sql.ts`-shaped module exporting a
		// JSON.stringify'd string — reading it as raw text would see literal `\t`/`\n`
		// escape sequences, not real tab/newline characters, and the table-name regex
		// below would never match.
		const baselineSchemaSql = await loadSchemaSqlFrom(baselineSchemaFile)
		const currentSchemaSql = (await import('../src/database/schema-sql.js')).VOTETORRENT_SCHEMA_SQL
		const declaredTables = (sql) => {
			const names = new Set()
			for (const m of sql.matchAll(/^\ttable\s+(\w+)\s*\(/gm)) names.add(m[1])
			return names
		}
		const baselineTables = declaredTables(baselineSchemaSql)
		const currentTables = declaredTables(currentSchemaSql)
		newTables = [...currentTables].filter((t) => !baselineTables.has(t)).sort()
		newTablesQueryable = true
		for (const table of newTables) {
			try {
				const row = await db.prepare(`select count(*) as n from ${table}`).get()
				if (Number(row?.n ?? -1) !== 0) newTablesQueryable = false
			} catch {
				newTablesQueryable = false
			}
		}
	}

	await db.close()

	const verdict = (
		assertions.noThrow && assertions.noAlterColumn && assertions.rowsReadable && expirationGone
		&& manifestConsistent && assertions.decisionCursorsIntact !== false && assertions.legacyDecisionCursorsIntact !== false
		&& (baselineSchemaFile ? newTablesQueryable === true : true)
	) ? 'PASS' : 'FAIL'

	console.log(JSON.stringify({
		mode: 'reopen',
		negativeControl: false,
		dbPath,
		assertions: { ...assertions, expirationColumnGone: expirationGone },
		counts,
		observedDecisionCursors: observedCursors,
		decisionLeg,
		seededDecisionShape: shape,
		decisionLegProblem,
		expectedCounts: expectedCounts ?? null,
		attestationChallengeColumns: columnNames,
		newTables,
		newTablesQueryable,
		verdict,
	}, null, 2))

	if (verdict !== 'PASS') process.exit(1)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

try {
	if (seedPath) {
		await runSeed(seedPath)
	} else {
		await runReopen(reopenPath)
	}
} catch (error) {
	console.error(`FAIL: unhandled error in reattach-proof.mjs: ${error?.message ?? error}`)
	process.exit(1)
}
