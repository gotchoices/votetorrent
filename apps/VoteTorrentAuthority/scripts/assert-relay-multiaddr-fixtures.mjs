#!/usr/bin/env node
/**
 * assert-relay-multiaddr-fixtures.mjs — R4 (D-11) / D-15 gate.
 *
 * LOCATION IS LOAD-BEARING. This script lives inside `apps/VoteTorrentAuthority/scripts/`, not
 * at the repo root. A bare `import('@multiformats/multiaddr')` from this path resolves up to
 * `apps/VoteTorrentAuthority/node_modules` — the exact copy the app itself bundles. A copy of
 * this script at the repo root would resolve to root `node_modules`, which under
 * `nmHoistingLimits: workspaces` does NOT contain the package. Do not "tidy up" this script by
 * moving it to the repo root.
 *
 * WHY A PLAIN NODE GATE (not a jest test): `apps/VoteTorrentAuthority/jest.config.js` maps
 * `'^@multiformats/multiaddr$'` to `<rootDir>/__mocks__/@multiformats/multiaddr.js`, and that
 * stub is ALSO picked up automatically as a node_modules manual mock even under
 * `jest.node.config.js`'s real-dist mapping. Four routes to unmock it inside jest were probed
 * and refuted during planning (recorded in `58-06-PLAN.md`'s `<facts_established_during_planning>`
 * — do not re-attempt them):
 *   1. The manual mock wins even under `jest.node.config.js`.
 *   2. `jest.unmock(...)` disables the `moduleNameMapper` redirect too, and bare resolution of
 *      this ESM-only package then fails (no `require` export condition).
 *   3. Requiring the real dist by relative path under `jest.config.js` fails:
 *      `SyntaxError: Cannot use import statement outside a module` (RN's
 *      `transformIgnorePatterns` allowlist excludes `@multiformats`).
 *   4. The same relative-path require under `jest.node.config.js` fails on pre-existing rot:
 *      `^uint8-varint$` maps to a path under `@libp2p/crypto/node_modules/uint8-varint` that no
 *      longer exists. (Pre-existing, unrelated to R4 — reported, not fixed, here.)
 * Consequently the real-parser leg is this plain Node ESM script (measured ~0.3s).
 *
 * WHAT THIS GATE PROVES (D-15): that a validity claim about relay addresses can be certified by
 * the REAL 13.0.3 parser, resolved from the app's own installed copy, and that the jest stub
 * COULD NOT have produced the same verdict for at least one fixture in the corpus — i.e. the
 * mock-backed screen suite in `AddNetworkScreen.relayValidation.test.tsx` is not, by itself,
 * sufficient evidence for any multiaddr-grammar claim.
 *
 * SELF-TRIPPING HAZARD (recorded 3x elsewhere in this repo): a checker whose own comment quotes
 * the pattern it hunts for is permanently green. Check 5 below strips comments from the SCANNED
 * file before matching, and scans ONLY `relayAddressValidation.ts` — never this file's own
 * source, never any other file.
 *
 * Five checks, fail-closed (non-zero exit, named reason) on any failure:
 *   1. Provenance — resolved package path + version.
 *   2. Real-parser verdicts — every fixture matches its `expected` value under the real parser.
 *   3. Mock discrimination (D-15 control) — at least one fixture's stub verdict differs from the
 *      real verdict.
 *   4. Wiring-fixture availability — at least one fixture is `expected: "invalid"` AND
 *      stub-rejected (the only address class safe for a mock-backed screen test).
 *   5. Delegation — the (comment-stripped) helper source imports `@multiformats/multiaddr` and
 *      uses `multiaddr` as the default `parse`.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failed = false;
function fail(reason) {
	console.error(`FAIL: ${reason}`);
	failed = true;
}

function stripComments(source) {
	// Block comments first, then line comments — mirrors check-screen-scroll-containers.mjs's
	// ordering so a `//` sequence inside a block comment is never mistaken for a line opener
	// once the block comment is already gone.
	const noBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
	return noBlockComments.replace(/\/\/.*$/gm, "");
}

// ---------------------------------------------------------------------------
// Check 1: Provenance
// ---------------------------------------------------------------------------
const resolvedIndexPath = require.resolve("@multiformats/multiaddr");
const marker = path.join("node_modules", "@multiformats", "multiaddr");
const markerIdx = resolvedIndexPath.indexOf(marker);
if (markerIdx === -1) {
	fail(`could not locate "${marker}" in resolved path "${resolvedIndexPath}"`);
	console.error(JSON.stringify({ check: "provenance" }, null, 2));
	process.exit(1);
}
const packageRoot = resolvedIndexPath.slice(0, markerIdx + marker.length);
const packageJsonPath = path.join(packageRoot, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

console.log(`[provenance] resolved package path: ${packageRoot}`);
console.log(`[provenance] resolved version: ${packageJson.version}`);

const expectedRootFragment = path.join("apps", "VoteTorrentAuthority", "node_modules", "@multiformats", "multiaddr");
if (!packageRoot.includes(expectedRootFragment)) {
	fail(
		`resolved package path "${packageRoot}" does not contain "${expectedRootFragment}" — this gate ` +
			`would be certifying some OTHER copy of the package, not the one the app bundles`,
	);
}
if (!packageJson.version.startsWith("13.")) {
	fail(`resolved version "${packageJson.version}" does not start with "13." (expected the 13.x line)`);
}

// ---------------------------------------------------------------------------
// Load fixtures + the real parser + the jest stub
// ---------------------------------------------------------------------------
const fixturesPath = new URL("../__fixtures__/relay-address-fixtures.json", import.meta.url);
const fixturesRaw = readFileSync(fixturesPath, "utf8");
const { fixtures } = JSON.parse(fixturesRaw);

const { multiaddr } = await import("@multiformats/multiaddr");

const mockPath = path.join(__dirname, "..", "__mocks__", "@multiformats", "multiaddr.js");
const { multiaddr: mockMultiaddr } = require(mockPath);

function realVerdict(address) {
	try {
		multiaddr(address);
		return { verdict: "valid" };
	} catch (err) {
		return { verdict: "invalid", ctorName: err?.constructor?.name ?? "Error" };
	}
}

function stubVerdict(address) {
	try {
		mockMultiaddr(address);
		return "valid";
	} catch {
		return "invalid";
	}
}

// ---------------------------------------------------------------------------
// Check 2: Real-parser verdicts match `expected`
// ---------------------------------------------------------------------------
const realVerdicts = new Map();
for (const fixture of fixtures) {
	const result = realVerdict(fixture.address);
	realVerdicts.set(fixture.address, result.verdict);
	if (result.verdict !== fixture.expected) {
		fail(
			`fixture "${fixture.address}" expected "${fixture.expected}" but the real parser said ` +
				`"${result.verdict}"` +
				(result.ctorName ? ` (error constructor: ${result.ctorName})` : ""),
		);
	}
}
console.log(`[real-parser] checked ${fixtures.length} fixtures against @multiformats/multiaddr@${packageJson.version}`);

// ---------------------------------------------------------------------------
// Check 3: Mock discrimination (D-15 control)
// ---------------------------------------------------------------------------
const discriminating = [];
for (const fixture of fixtures) {
	const real = realVerdicts.get(fixture.address);
	const stub = stubVerdict(fixture.address);
	if (real !== stub) {
		discriminating.push({ address: fixture.address, real, stub });
	}
}
if (discriminating.length === 0) {
	fail(
		"no discriminating fixture — every fixture's stub verdict agrees with the real parser's " +
			"verdict, which makes this gate vacuous: the jest mock COULD have certified this corpus " +
			"(D-15 control failed closed)",
	);
} else {
	console.log(
		`[mock-discrimination] ${discriminating.length} discriminating fixture(s): ` +
			discriminating.map((d) => `"${d.address}" (real=${d.real}, stub=${d.stub})`).join(", "),
	);
}

// ---------------------------------------------------------------------------
// Check 4: Wiring-fixture availability
// ---------------------------------------------------------------------------
const wiringSafe = fixtures.filter((f) => f.expected === "invalid" && stubVerdict(f.address) === "invalid");
if (wiringSafe.length === 0) {
	fail(
		"no fixture is both expected:\"invalid\" AND stub-rejected — the mock-backed screen test " +
			"(AddNetworkScreen.relayValidation.test.tsx) would have no legitimate invalid fixture to use",
	);
} else {
	console.log(
		`[wiring-safe] fixture(s) safe for the mock-backed screen test: ` +
			wiringSafe.map((f) => `"${f.address}"`).join(", "),
	);
}

// ---------------------------------------------------------------------------
// Check 5: Delegation (scans ONLY relayAddressValidation.ts, never this file)
// ---------------------------------------------------------------------------
const helperPath = path.join(__dirname, "..", "src", "utils", "relayAddressValidation.ts");
const helperSourceRaw = readFileSync(helperPath, "utf8");
const helperSource = stripComments(helperSourceRaw);

const importsMultiaddr = /import\s*\{[^}]*\bmultiaddr\b[^}]*\}\s*from\s*["']@multiformats\/multiaddr["']/.test(
	helperSource,
);
const usesMultiaddrAsDefaultParse = /=\s*multiaddr\s*[,)]/.test(helperSource);

if (!importsMultiaddr) {
	fail(`${helperPath} (comment-stripped) does not import "multiaddr" from "@multiformats/multiaddr"`);
}
if (!usesMultiaddrAsDefaultParse) {
	fail(`${helperPath} (comment-stripped) does not use "multiaddr" as the default "parse" argument`);
}
if (importsMultiaddr && usesMultiaddrAsDefaultParse) {
	console.log("[delegation] relayAddressValidation.ts imports and delegates to the real multiaddr parser");
}

// ---------------------------------------------------------------------------
if (failed) {
	console.error("assert-relay-multiaddr-fixtures: FAILED (see reasons above)");
	process.exit(1);
}
console.log("assert-relay-multiaddr-fixtures: PASSED");
process.exit(0);
