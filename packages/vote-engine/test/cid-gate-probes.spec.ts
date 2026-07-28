/**
 * cid-gate-probes.spec.ts — Phase 36 Plan 01, Task 1: Wave 0 evidence probes for
 * the D-01 crypto-plugin 0.14.x compatibility gate (CID-01, CID-02).
 *
 * PURPOSE: settle both RESEARCH open questions with executable evidence, and
 * prove the 0.14.1 `cid()`/`cid_decode` UDF family is registered on the exact
 * engine path InviteSlot inserts run under, BEFORE any schema CHECK in Plan 02
 * references those functions.
 *
 * Probe 1 (CID-01): cid()/cid_decode registration smoke on vote-engine's own
 *   `prepareDb`/`registerDbPlugins` path (the path `AuthorityEngine`'s InviteSlot
 *   mint sites run under — see authority-engine.ts:576-777).
 *
 * Probe 2 (Open Question 1 — strand-path reachability): does the vendored
 *   `@serfab/cadre-core` strand path's OWN crypto-plugin resolution (independent
 *   of vote-engine's own import) currently expose cid()? Verified via source
 *   inspection first (vendor/@serfab/cadre-core/dist/strand-database.js and
 *   control-database.js both do a plain `import cryptoPlugin from
 *   "@optimystic/quereus-plugin-crypto/plugin"` — a resolution-context-scoped
 *   bare specifier, NOT vote-engine's own import), then confirmed empirically
 *   here by resolving that exact specifier the same way Node would from
 *   cadre-core's own package directory (a manual node_modules walk — NOT
 *   `require.resolve`/`import.meta.resolve`, because the target package's
 *   `exports` map only declares an `"import"` condition with no `"require"`
 *   fallback, which would make a CJS-style `require.resolve` fail with
 *   ERR_PACKAGE_PATH_NOT_EXPORTED even though the ESM `import` in
 *   strand-database.js resolves fine — this probe mirrors the ACTUAL node_modules
 *   resolution algorithm directly instead). Constructing a full networked
 *   `StrandDatabase`/`ControlDatabase` (both require a real libp2p node +
 *   coordinated repo for `registerLibp2pNode`) is out of scope for this
 *   lightweight Wave-0 probe; resolving+registering the exact crypto-plugin
 *   copy the strand path would use is the load-bearing signal and is what is
 *   checked here.
 *
 * Probe 3 (Open Question 2 — malformed-Cid CHECK degradation): does a thrown
 *   `cid_decode` exception inside a schema CHECK degrade to a normal, catchable
 *   constraint-violation-style error, or crash the process? Verified with a
 *   minimal ad-hoc table mirroring Plan 02's SlotCidValid structural-fallback
 *   shape.
 *
 * Probe 3b (DISCOVERED PITFALL, load-bearing for Plan 02): while building Probe
 *   3's table, RESEARCH's proposed Pattern 3 CHECK shape —
 *   `json_extract(cid_decode(x), '$.codec') = 'raw'` — was found to evaluate to
 *   FALSE even for a genuinely VALID raw-codec CIDv1 string, in a plain SELECT
 *   with no CHECK/table involved at all (so this is not a CHECK-evaluation-context
 *   artifact — it reproduces at the scalar-expression level). `json_extract`'s
 *   return carries a JSON logical type distinct from TEXT, and Quereus's `=`
 *   operator does not coerce a JSON-typed operand against a bare TEXT literal —
 *   wrapping in `cast(... as text)` fixes it. Plan 02's SlotCidValid/CidValid
 *   structural-fallback CHECK constraints MUST use the `cast(...as text)` form,
 *   not the bare RESEARCH Pattern 3 example, or every insert against those
 *   columns would be unconditionally rejected (an over-rejection correctness bug,
 *   not a security hole, but a phase-breaking one).
 *
 * D-02a: only the canonical `cid()`/`cid_decode()` entry points are exercised in
 * this file — the sibling single-hash minting UDF the user directive excludes
 * is never referenced anywhere here (grep-locked by this plan's acceptance
 * criteria).
 *
 * BINDING CONVENTION: Quereus bind keys have NO colon prefix (see
 * digest-check-coverage.spec.ts header comment).
 */

import { Database, registerPlugin } from '@quereus/quereus'
import { expect } from 'chai'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { prepareDb } from '../src/database/initialize.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
// packages/vote-engine/test -> packages/vote-engine -> packages -> repo root
const REPO_ROOT = path.resolve(__dirname, '../../../')

/**
 * Mirror Node's own node_modules resolution walk for a bare specifier, starting
 * from a given package directory, so we resolve the EXACT physical copy of a
 * dependency that package would use at runtime — without relying on
 * `require.resolve`/`import.meta.resolve`, whose `exports`-map condition
 * matching does not reflect a plain ESM `import` the way a raw fs walk does
 * for this particular package's exports shape (see file header).
 */
function findResolvedPackageDir(startDir: string, pkgName: string): string | undefined {
	let dir = startDir
	for (;;) {
		const candidate = path.join(dir, 'node_modules', ...pkgName.split('/'))
		if (existsSync(path.join(candidate, 'package.json'))) return candidate
		const parent = path.dirname(dir)
		if (parent === dir) return undefined
		dir = parent
	}
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('D-01 compat gate: cid()/cid_decode registration + Wave 0 open-question probes', function () {
	this.timeout(30_000)

	let db: Database

	before(async () => {
		db = new Database()
		await prepareDb(db)
	})

	// -------------------------------------------------------------------------
	// Probe 1 (CID-01): cid() registration smoke on vote-engine's own engine path
	// -------------------------------------------------------------------------
	it('Probe 1: cid()/cid_decode resolve on the vote-engine registration path (prepareDb) and round-trip codec=raw', async () => {
		const cidRow = (await db.prepare(`select cid('test') as c`).get()) as { c: unknown } | undefined
		expect(cidRow?.c, "cid('test') must return a non-empty string").to.be.a('string').and.have.length.greaterThan(0)
		const c = cidRow!.c as string
		// Default encoding per D-02: multicodec raw (0x55) + sha2-256 + base32-lower —
		// the conventional CIDv1 raw+sha2-256 base32-lower prefix is "bafk".
		expect(c, 'a CIDv1 raw+sha2-256 base32-lower string starts with the conventional "bafk" prefix').to.match(/^bafk/)

		const decodeRow = (await db.prepare(`select cid_decode(cid('test')) as d`).get()) as { d: unknown } | undefined
		expect(decodeRow?.d, 'cid_decode(cid(...)) must return a non-empty JSON string').to.be.a('string')
		const decoded = JSON.parse(decodeRow!.d as string) as { version: number; codec: string; hashCode: string }
		expect(decoded.version, 'cid() mints CIDv1').to.equal(1)
		expect(decoded.codec, 'the default cid() multicodec is the IPLD "raw" codec (0x55)').to.equal('raw')
	})

	// -------------------------------------------------------------------------
	// Probe 2 (Open Question 1): strand-path reachability
	// -------------------------------------------------------------------------
	it('Probe 2: resolves the exact crypto-plugin copy the strand path (@serfab/cadre-core) would import, and records whether cid() is reachable there', async function () {
		const cadreCoreDir = path.join(REPO_ROOT, 'vendor', '@serfab', 'cadre-core')
		const resolvedDir = findResolvedPackageDir(cadreCoreDir, '@optimystic/quereus-plugin-crypto')

		if (!resolvedDir) {
			// The strand factory's crypto-plugin dependency could not be resolved at
			// all in this Node test env (e.g. hoisting layout changed) — document and
			// skip rather than silently drop. Falls back to the direct source-
			// inspection finding: vendor/@serfab/cadre-core/dist/strand-database.js
			// and control-database.js both `import cryptoPlugin from
			// "@optimystic/quereus-plugin-crypto/plugin"` as a bare specifier
			// independent of vote-engine's own import — that import will resolve
			// to whichever copy this environment's node_modules layout provides.
			this.skip()
			return
		}

		const resolvedVersion = (
			JSON.parse(readFileSync(path.join(resolvedDir, 'package.json'), 'utf8')) as { version: string }
		).version
		const resolvedPluginEntry = path.join(resolvedDir, 'dist', 'plugin.js')

		const cryptoPluginModule = (await import(pathToFileURL(resolvedPluginEntry).href)) as { default: unknown }
		const strandDb = new Database()
		// The resolved module's default export is the plugin's `register` factory
		// function (same shape vote-engine's own `initialize.ts` imports as
		// `cryptoPlugin` from `@optimystic/quereus-plugin-crypto/plugin`) — its
		// exact generic signature isn't statically known here since it's a dynamic
		// import of a resolved-at-runtime path.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await registerPlugin(strandDb, cryptoPluginModule.default as any)

		let cidThrew = false
		let cidError: unknown
		try {
			await strandDb.prepare(`select cid('test') as c`).get()
		} catch (err) {
			cidThrew = true
			cidError = err
		}

		// eslint-disable-next-line no-console
		console.log(
			`[cid-gate-probes] Probe 2: strand-path crypto-plugin resolves to ${resolvedDir} @ ${resolvedVersion}; cid() ${
				cidThrew ? 'THREW (function not registered)' : 'RESOLVED'
			}`,
		)

		// OPEN QUESTION 1 — SETTLED (either branch below is a PASSING assertion; the
		// point of this probe is to DOCUMENT which copy the strand path uses, not to
		// assert a fixed pre-bump expectation that would break once Task 3 lands).
		const isPreBump = /^0\.13\./.test(resolvedVersion)
		if (isPreBump) {
			// Pre-bump (current tree state at Task 1 time): the strand path's own
			// resolved crypto-plugin copy (0.13.5) genuinely lacks cid()/cid_decode —
			// confirmed by a REAL registration + call attempt, not just source
			// inspection. This is the concrete evidence justifying D-01's vendored
			// pin bump in Task 3.
			expect(cidThrew, `strand-path crypto-plugin@${resolvedVersion} (pre-0.14 bump) is expected to lack cid()`).to.equal(
				true,
			)
			expect(
				String((cidError as Error)?.message ?? ''),
				'expected a function-not-found style resolution error (QuereusError "Function not found: cid/…")',
			).to.match(/not found/i)
		} else {
			// Post-bump (this suite re-run after Task 3's vendored repin has landed):
			// the strand path's resolved copy is now 0.14.x and exposes cid().
			expect(
				cidThrew,
				`strand-path crypto-plugin@${resolvedVersion} (post-0.14 bump) is expected to expose cid()`,
			).to.equal(false)
		}
	})

	// -------------------------------------------------------------------------
	// Probe 3 (Open Question 2): malformed-Cid CHECK degradation
	// -------------------------------------------------------------------------
	it('Probe 3: a thrown cid_decode exception inside a schema CHECK degrades to a catchable constraint-violation error, not a process crash; valid CIDs are still accepted', async () => {
		// NOTE: uses cast(...as text) around json_extract per the Probe 3b finding
		// below — the bare RESEARCH Pattern 3 form (`json_extract(...) = 'raw'`,
		// no cast) would unconditionally reject even valid input.
		await db.exec(
			`create table CidGateProbe (
				V text primary key,
				constraint CidLike check (cast(json_extract(cid_decode(V), '$.codec') as text) = 'raw')
			);`,
		)

		// --- malformed-input degradation (the core Open Question 2 ask) ---
		let caught: unknown
		try {
			await db.exec(`insert into CidGateProbe (V) values ('not-a-real-cid-string')`)
		} catch (err) {
			caught = err
		}
		expect(caught, 'a malformed Cid insert must throw, not silently succeed').to.be.instanceOf(Error)
		// Record the concrete error class/shape observed — informs Plan 02's final
		// SlotCidValid CHECK shape and whether AuthorityEngine.rethrow() needs a new
		// branch. Observed: QuereusError ("Function cid_decode failed: Unable to
		// decode multibase string …") — already one of the two classes
		// AuthorityEngine.rethrow() explicitly branches on (QuereusError/MisuseError),
		// so no new rethrow() branch is needed.
		const errClass = (caught as Error).constructor.name
		// eslint-disable-next-line no-console
		console.log(`[cid-gate-probes] Probe 3: malformed cid_decode input threw ${errClass}: ${(caught as Error).message}`)
		expect(errClass, 'the thrown error must be a real Error subclass (catchable)')
			.to.be.a('string')
			.and.have.length.greaterThan(0)

		// --- valid input must be ACCEPTED (DoS-mitigation + shape-correctness check,
		// T-36-02): the throw above must not have wedged the handle, and — critically
		// — the CHECK shape used here (cast(...as text)) must actually accept a
		// genuinely valid CIDv1 raw-codec value. ---
		const validCid = (await db.prepare(`select cid('test') as c`).get()) as { c: string } | undefined
		let validInsertThrew = false
		try {
			await db.exec(`insert into CidGateProbe (V) values (:v)`, { v: validCid!.c })
		} catch {
			validInsertThrew = true
		}
		expect(
			validInsertThrew,
			'a valid cid() value must be ACCEPTED by the CidLike CHECK, and the handle must still be usable after the prior malformed-input throw (proves clean degradation, not a wedged/crashed handle)',
		).to.equal(false)
	})

	// -------------------------------------------------------------------------
	// Probe 3b (discovered pitfall, load-bearing for Plan 02's CHECK shape):
	// json_extract(...) is NOT directly `=`-comparable to a bare TEXT literal.
	// -------------------------------------------------------------------------
	it('Probe 3b: the bare RESEARCH Pattern 3 form json_extract(cid_decode(x),"$.codec")=\'raw\' under-accepts even VALID input — Plan 02 must use cast(...as text)', async () => {
		const validCid = (await db.prepare(`select cid('test') as c`).get()) as { c: string }

		// DOCUMENTED PITFALL: reproduces at the plain-scalar-expression level — no
		// CHECK, no table, no row context involved — so this is not a
		// CHECK-evaluation-context artifact. json_extract's return carries a JSON
		// logical type distinct from TEXT; Quereus's `=` operator does not coerce a
		// JSON-typed operand against a bare TEXT literal.
		const naiveRow = (await db
			.prepare(`select json_extract(cid_decode(:v), '$.codec') = 'raw' as eq`)
			.get({ v: validCid.c })) as { eq: unknown }
		expect(
			naiveRow.eq,
			'the bare json_extract(...) = \'raw\' comparison is FALSE even for a genuinely valid raw-codec CID (json_extract\'s JSON-typed return is not TEXT-literal-comparable without an explicit cast) — using this bare form for Plan 02\'s SlotCidValid CHECK would unconditionally reject every valid insert',
		).to.equal(false)

		// The corrected form Plan 02 must use instead:
		const castRow = (await db
			.prepare(`select cast(json_extract(cid_decode(:v), '$.codec') as text) = 'raw' as eq`)
			.get({ v: validCid.c })) as { eq: unknown }
		expect(
			castRow.eq,
			'cast(json_extract(...) as text) = \'raw\' correctly evaluates TRUE for the same valid input — this is the CHECK shape Plan 02\'s SlotCidValid/CidValid structural-fallback constraints must use',
		).to.equal(true)
	})
})
