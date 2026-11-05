/**
 * package-shape.test.mjs — the tier-1 proof that `@votetorrent/ui-web`'s four
 * load-bearing shape properties (D-16) are falsifiable, not merely asserted.
 *
 * What each rung catches:
 *   1. Positive control  — proves a bundler-only `.tsx` re-export barrel
 *      genuinely throws `ERR_MODULE_NOT_FOUND` under plain Node. Uses the
 *      `bundler-only-barrel` FIXTURE, not the real `./components` barrel
 *      (WR-10, Phase 53 review: this barrel is no longer empty — it
 *      re-exports three `.tsx` components plus `react-identity.js` — so
 *      rung 3b below exercises the REAL barrel; this rung stays fixture-based
 *      because it is what proves the matcher/mechanism generically, isolated
 *      from whatever the real barrel happens to contain today).
 *   2. Benign control    — proves rung 1's matcher discriminates: the
 *      fixture's plain-JS barrel must resolve fine, or rung 1 would pass on
 *      any mistyped fixture path.
 *   3. The real `.` subpath  — Node-importable with no bundler, and exposes
 *      real, non-trivial values (`t` a function, `COPY` frozen) — not merely
 *      "some object" (WR-10: the prior assertion would have passed on a
 *      barrel exporting nothing at all).
 *   3b. The real `./components` subpath (WR-10) — genuinely throws
 *      `ERR_MODULE_NOT_FOUND` under plain Node. Where rung 1 proves the
 *      mechanism against a fixture, this rung proves the CURRENT, non-empty
 *      real barrel still exhibits it — the load-bearing claim this file's own
 *      workflow header calls "the ERR_MODULE_NOT_FOUND proof" no longer rests
 *      on the fixture and rung 8's static lockstep alone.
 *   4. The real `./tokens.css` subpath — resolves to a file that exists.
 *   4b. The real `./components.css` subpath (53-CR01) — resolves to a file
 *      that exists.
 *   5. Exports map shape — exactly seven keys, in the expected order/targets.
 *   6. Peer+dev React pairing — TS2875 guard.
 *   7. Never-hoist-React — root manifest purity, with a positive control that
 *      the right file (and not a mis-resolved one) was read.
 *   8. Barrel / `.tsx` lockstep — a future `.tsx` component added without a
 *      re-export, or a re-export added without its `.tsx` backing, goes red.
 *
 * Two forbidden vacuous shapes, named explicitly so neither creeps back in:
 *   - Do not interpolate a value under test into a test's NAME (turns the
 *     assertion into documentation instead of a check).
 *   - Do not use an always-true disjunct in an assertion's condition (passes
 *     on a completely broken page/module — 090's `docSection.md` names this
 *     exact trap).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(HERE, '..');
const FIXTURE_ROOT = path.join(HERE, 'fixtures', 'bundler-only-barrel');
const ROOT_PACKAGE_JSON = path.join(PACKAGE_ROOT, '..', '..', 'package.json');

test('rung 1 (positive control): the fixture bundler-only barrel throws ERR_MODULE_NOT_FOUND under plain Node', async () => {
	const specifier = pathToFileURL(path.join(FIXTURE_ROOT, 'src', 'components.js')).href;
	await assert.rejects(() => import(specifier), /** @param {NodeJS.ErrnoException} err */ (err) => {
		assert.equal(err.code, 'ERR_MODULE_NOT_FOUND');
		return true;
	});
});

test('rung 2 (benign control): the fixture plain-JS barrel resolves fine and exposes its sentinel', async () => {
	const specifier = pathToFileURL(path.join(FIXTURE_ROOT, 'src', 'index.js')).href;
	const mod = await import(specifier);
	assert.equal(mod.FIXTURE_PLAIN_JS_SENTINEL, 'fixture-plain-js-sentinel');
});

test('rung 3: the real `.` subpath of @votetorrent/ui-web is Node-importable with no bundler', async () => {
	const mod = await import('@votetorrent/ui-web');
	assert.equal(typeof mod, 'object');
	assert.notEqual(mod, null);
	// WR-10 (Phase 53 review): `typeof mod === 'object' && mod !== null` would
	// pass on a barrel exporting nothing at all. Assert real, non-trivial
	// values instead.
	assert.equal(typeof mod.t, 'function');
	assert.ok(Object.isFrozen(mod.COPY));
});

test('rung 3b: the real `./components` subpath throws ERR_MODULE_NOT_FOUND under plain Node', async () => {
	// WR-10 (Phase 53 review): nothing in this suite previously attempted
	// `import('@votetorrent/ui-web/components')` under plain Node — the
	// load-bearing "ERR_MODULE_NOT_FOUND proof" this file's own workflow
	// header claims rested entirely on the fixture (rung 1) and rung 8's
	// static filename lockstep. The real barrel is no longer empty (it
	// re-exports AdvisoryDisclosure/LifecyclePill/DetailsToggle plus
	// react-identity.js, all `.tsx`-or-`.tsx`-dependent), so this exercises
	// the actual shipped subpath, not just a stand-in fixture.
	await assert.rejects(
		() => import('@votetorrent/ui-web/components'),
		/** @param {NodeJS.ErrnoException} err */ (err) => {
			assert.equal(err.code, 'ERR_MODULE_NOT_FOUND');
			return true;
		},
	);
});

test('rung 4: the real `./tokens.css` subpath resolves to an existing file', () => {
	const resolved = import.meta.resolve('@votetorrent/ui-web/tokens.css');
	const resolvedPath = fileURLToPath(resolved);
	assert.ok(existsSync(resolvedPath), `expected ${resolvedPath} to exist`);
});

test('rung 5: the exports map is exactly eight keys, in order, mapping to their expected targets', () => {
	// 53-05 (D-01/D-02) added `./lifecycle` for election-phase.js, on the
	// plain-JS side of the split (see src/index.js's header for why it is a
	// separate entry rather than a `.` re-export). 53-11 (D-20) adds
	// `./mutations` for the shared build-time mutation machinery the two
	// negative controls need -- also plain-JS, also alongside `.`, never
	// behind `./components` (it imports no React and is loaded by a Vite
	// config in a Node process, not by a bundler). 53-CR01 (the D-15 revision:
	// the package owns its own shared components' default CSS, not each
	// consumer) adds `./components.css`, grouped next to `./tokens.css` since
	// both are CSS entries a consumer's own app.css `@import`s. 54-04 adds
	// `./facts` for the fact/gap model (`facts.js`) -- a SEPARATE entry
	// rather than a re-export through `./lifecycle`, because
	// `election-phase.js` imports `@votetorrent/vote-engine/browser`.
	// Routing the fact model through `./lifecycle` would make every consumer
	// of a dependency-free pure-data module load a database engine, which is
	// the exact coupling the `./lifecycle`-out-of-`.` split exists to
	// prevent. 59-02 (D-19) adds `./lifecycle-core` -- the ZERO-IMPORT half
	// of `./lifecycle`, positioned immediately after it since both are
	// `./lifecycle` siblings -- so a React Native consumer (the voter app)
	// can reach `ELECTION_EVENT_ORDER`/`parseTimeline`/`normalizeInstant`/
	// `finestStage` without transitively loading
	// `@votetorrent/vote-engine/browser`, a database engine, or a
	// `react-dom` peer. None of these additions merge with `.` or
	// `./components`, so this rung's other assertions (import via `.`,
	// ERR_MODULE_NOT_FOUND via `./components`, tokens.css resolving) all stay
	// true unchanged -- only the key count and order grow.
	const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
	assert.deepEqual(Object.keys(pkg.exports), [
		'.',
		'./components',
		'./lifecycle',
		'./lifecycle-core',
		'./facts',
		'./tokens.css',
		'./components.css',
		'./mutations',
	]);
	assert.equal(pkg.exports['.'], './src/index.js');
	assert.equal(pkg.exports['./components'], './src/components.js');
	assert.equal(pkg.exports['./lifecycle'], './src/lifecycle/election-phase.js');
	assert.equal(pkg.exports['./lifecycle-core'], './src/lifecycle/timeline-core.js');
	assert.equal(pkg.exports['./facts'], './src/lifecycle/facts.js');
	assert.equal(pkg.exports['./tokens.css'], './src/tokens.css');
	assert.equal(pkg.exports['./components.css'], './src/components.css');
	assert.equal(pkg.exports['./mutations'], './scripts/mutations.mjs');
});

test('rung 4b: the real `./components.css` subpath resolves to an existing file', () => {
	const resolved = import.meta.resolve('@votetorrent/ui-web/components.css');
	const resolvedPath = fileURLToPath(resolved);
	assert.ok(existsSync(resolvedPath), `expected ${resolvedPath} to exist`);
});

test('rung 9: the real `./mutations` subpath is Node-importable with no bundler and exposes the frozen mutation set', async () => {
	const mod = await import('@votetorrent/ui-web/mutations');
	// 56-03 Task 3 added the fourth mutation name, `pill-retone-reverted`;
	// 56-13 Task 1 appends the fifth and sixth — this assertion exists to make
	// a silent addition impossible; it is UPDATED here, not relaxed.
	assert.deepEqual(mod.MUTATIONS, [
		'no-dedupe',
		'token-missing',
		'gap-cues-flattened',
		'pill-retone-reverted',
		'cadre-patch-reverted',
		'notify-disabled',
	]);
	assert.equal(typeof mod.resolveMutation, 'function');
	assert.equal(typeof mod.applyNoDedupe, 'function');
	assert.equal(typeof mod.stripTokensPlugin, 'function');
	assert.equal(typeof mod.flattenGapCuesPlugin, 'function');
	assert.equal(typeof mod.revertPillRetonePlugin, 'function');
	assert.equal(typeof mod.redirectCadreCorePlugin, 'function');
	assert.equal(typeof mod.stripPeerNotifyPlugin, 'function');
	assert.equal(typeof mod.writeMutationReportPlugin, 'function');
	assert.equal(typeof mod.readMutationReport, 'function');
});

/**
 * The apps whose mutant config must handle every name in `MUTATIONS`, and —
 * for each — the names that config deliberately does NOT handle, with the
 * reason it is a decision rather than a gap.
 *
 * `apps/VoteTorrentDashboard/vite.mutant.config.ts` is deliberately absent
 * from this table: it has the same fail-closed trailing `throw` and correctly
 * refuses any name it does not handle (56-13 pre-verified fact 3), and it is
 * not edited by the plan that added the last two names.
 */
const MUTANT_CONFIGS = [
	{
		label: 'apps/VoteTorrentPublic/vite.mutant.config.ts',
		file: path.join(PACKAGE_ROOT, '..', '..', 'apps', 'VoteTorrentPublic', 'vite.mutant.config.ts'),
		unhandled: /** @type {string[]} */ ([]),
	},
];

test('rung 9b: every name in `MUTATIONS` is wired into the public app\'s mutant config, or explicitly listed as unhandled (56-13)', async () => {
	const mod = await import('@votetorrent/ui-web/mutations');
	for (const { label, file, unhandled } of MUTANT_CONFIGS) {
		assert.ok(existsSync(file), `expected ${label} to exist at ${file}`);
		// Comments are STRIPPED before matching: a config whose own comment
		// merely NAMES a mutation would otherwise satisfy this check forever
		// while handling nothing — the self-tripping-checker failure this repo
		// has paid for three times.
		const stripped = readFileSync(file, 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.split('\n')
			.filter((line) => !/^\s*\/\//.test(line))
			.join('\n');
		for (const name of mod.MUTATIONS) {
			if (unhandled.includes(name)) continue;
			assert.ok(
				stripped.includes(`'${name}'`) || stripped.includes(`"${name}"`),
				`${label} never handles mutation "${name}". A name added to MUTATIONS but never wired fails closed at ` +
					`BUILD time with an obscure message instead of here, with a clear one. Wire it, or list it in ` +
					`MUTANT_CONFIGS[].unhandled with the reason.`,
			);
		}
		for (const name of unhandled) {
			assert.ok(
				/** @type {readonly string[]} */ (mod.MUTATIONS).includes(name),
				`${label} lists "${name}" as deliberately unhandled, but it is not a member of MUTATIONS — a stale entry ` +
					`here would silently excuse a real gap later.`,
			);
		}
	}
});

test('rung 10: the real `./facts` subpath is Node-importable with no bundler and exposes real, non-trivial values (54-04)', async () => {
	const mod = await import('@votetorrent/ui-web/facts');
	// WR-10's own note: assert real values, not `typeof mod === 'object'`.
	assert.ok(Object.isFrozen(mod.FACTS));
	assert.equal(mod.FACTS.length, 18);
	assert.equal(typeof mod.factsFor, 'function');
	assert.equal(typeof mod.headline, 'function');
	assert.deepEqual([...mod.FACT_GROUPS], ['electionAndRules', 'ballot', 'electorate', 'outcome']);
});

test('rung 6: react and react-dom are pinned at exactly 19.0.0 in both peerDependencies and devDependencies (TS2875 guard)', () => {
	const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
	for (const field of ['peerDependencies', 'devDependencies']) {
		for (const dep of ['react', 'react-dom']) {
			assert.equal(
				pkg[field][dep],
				'19.0.0',
				`${field}.${dep} must be exactly 19.0.0 — peer-only fails tsc with TS2875 ` +
					`(the package needs a local React to resolve and typecheck itself)`,
			);
		}
	}
});

test('rung 7: react/react-dom never appear in the root manifest, and @types/react IS present (proves the right file was read)', () => {
	const rootPkg = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, 'utf8'));
	const fieldsToCheck = [
		'dependencies',
		'devDependencies',
		'peerDependencies',
		'optionalDependencies',
		'resolutions',
	];
	for (const field of fieldsToCheck) {
		const section = rootPkg[field] ?? {};
		for (const dep of ['react', 'react-dom']) {
			assert.equal(
				dep in section,
				false,
				`root package.json ${field} must never declare "${dep}" — hoisting React to the ` +
					`root builds green and dies at the first hook`,
			);
		}
	}
	// Positive control: prove this rung read the correct file, not a mis-resolved path.
	assert.equal(rootPkg.resolutions?.['@types/react'], '19.2.17');
});

test('rung 11: recharts and react-is are pinned at exactly 3.10.1 / 19.2.6 in dependencies, with no range prefix (D-10)', () => {
	const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
	const EXPECTED = { recharts: '3.10.1', 'react-is': '19.2.6' };
	for (const [dep, expected] of Object.entries(EXPECTED)) {
		assert.equal(
			pkg.dependencies[dep],
			expected,
			`dependencies.${dep} must be exactly "${expected}" — an unpinned range would let a transitive ` +
				`Recharts/react-is bump land unreviewed`,
		);
	}
});

test('rung 11 (control): a range-prefixed version string is reported as a mismatch, not silently accepted', () => {
	const rangePrefixed = '^3.10.1';
	assert.notEqual(rangePrefixed, '3.10.1', 'a caret-prefixed string must not equal the exact-pinned string');
	// Sanity: the same discriminator this rung's own assert.equal relies on
	// correctly distinguishes an exact pin from every common range prefix.
	for (const prefixed of ['^3.10.1', '~3.10.1', '>=3.10.1', '*']) {
		assert.notEqual(prefixed, '3.10.1');
	}
});

test('rung 8: every ./components/ barrel re-export specifier has a sibling .tsx (never a sibling .js), and the two counts agree', () => {
	// Scoped to `./components/*.js` specifiers only (53-09): components.js
	// also re-exports `packageReactIdentity` from `./react-identity.js`, a
	// genuinely plain-JS module with no .tsx backing and deliberately outside
	// the `./components/` subfolder this rung governs — an unscoped regex
	// would wrongly demand a .tsx sibling for it and wrongly flag the real
	// react-identity.js file as a "literal .js file defeating the
	// ERR_MODULE_NOT_FOUND proof", which it does not participate in (it is
	// plain JS on both the source and the resolved-specifier side by design).
	const componentsSrc = readFileSync(path.join(PACKAGE_ROOT, 'src', 'components.js'), 'utf8');
	const specifierRe = /from\s+['"](\.\/components\/[^'"]+\.js)['"]/g;
	const specifiers = [...componentsSrc.matchAll(specifierRe)].map((m) => m[1]);

	const componentsDir = path.join(PACKAGE_ROOT, 'src', 'components');
	const tsxCount = existsSync(componentsDir)
		? readdirSync(componentsDir).filter((f) => f.endsWith('.tsx')).length
		: 0;

	assert.equal(
		specifiers.length,
		tsxCount,
		'the number of .js re-export specifiers in components.js must equal the number of .tsx ' +
			'files directly under src/components/ — a mismatch means either an unexported component ' +
			'or a re-export missing its .tsx backing',
	);

	for (const specifier of specifiers) {
		const jsPath = path.join(PACKAGE_ROOT, 'src', specifier);
		const tsxPath = jsPath.replace(/\.js$/, '.tsx');
		assert.ok(existsSync(tsxPath), `expected a sibling .tsx for specifier "${specifier}" at ${tsxPath}`);
		assert.ok(
			!existsSync(jsPath),
			`specifier "${specifier}" must resolve ONLY via a bundler's .tsx extension probe — a ` +
				`literal .js file at ${jsPath} would defeat the ERR_MODULE_NOT_FOUND proof`,
		);
	}
});
