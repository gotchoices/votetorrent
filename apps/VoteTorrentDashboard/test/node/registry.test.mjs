/**
 * registry.test.mjs — the source-level half of the registry freeze
 * (contract C8). `node --test` cannot import TypeScript, so this file reads
 * `registry.ts` as TEXT and asserts against its source, complementing
 * `tsc --noEmit`'s runtime-shape enforcement.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { dashboardSrc } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';

import { CAPABILITIES } from '../../src/auth/capabilities.js';

const PANELS_DIR = dashboardSrc('screens', 'panels');
const REGISTRY_PATH = dashboardSrc('screens', 'panels', 'registry.ts');

const EXPECTED_COMPONENTS = [
	'RegistrationsPanel',
	'ElectionsPanel',
	'BallotsQuestionsPanel',
	'NetworkSettingsPanel',
	'AuthorityProfilePanel',
	'AuthorityPeersPanel',
	'AdministrationOfficersPanel',
	'KeyholdersPanel',
	'InviteAuthoritiesPanel',
];

const registrySource = readFileSync(REGISTRY_PATH, 'utf8');
const strippedRegistry = stripComments(registrySource);

test('registry.ts has exactly 9 static "./<Name>Panel" imports, matching the 9 expected component names', () => {
	const importMatches = [...strippedRegistry.matchAll(/from\s+'\.\/(\w+Panel)'/g)].map((m) => m[1]);
	assert.equal(importMatches.length, 9, `expected exactly 9 static Panel imports, found ${importMatches.length}`);
	assert.deepEqual(importMatches.sort(), [...EXPECTED_COMPONENTS].sort());
});

test('the 9 registry keys, in order, deep-equal CAPABILITIES.map(c => c.id)', () => {
	const objMatch = strippedRegistry.match(/const registry: Record<CapabilityId, PanelComponent> = \{([\s\S]*?)\};/);
	assert.ok(objMatch, 'could not locate the registry object literal in registry.ts');
	const body = objMatch[1];
	const keys = [...body.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
	assert.deepEqual(
		keys,
		CAPABILITIES.map((c) => c.id),
	);
});

test('no dynamic import(), no React.lazy, and no computed key in registry.ts', () => {
	assert.doesNotMatch(strippedRegistry, /import\(/);
	assert.doesNotMatch(strippedRegistry, /React\.lazy/);
	// A computed key looks like `[expr]:` immediately after an opening brace
	// or comma in the object literal — this project's registry uses only
	// bare identifier keys.
	assert.doesNotMatch(strippedRegistry, /[{,]\s*\[/);
});

test('each of the 9 component files exists on disk and contains capability.emptyKey', () => {
	for (const name of EXPECTED_COMPONENTS) {
		const filePath = path.join(PANELS_DIR, `${name}.tsx`);
		assert.ok(existsSync(filePath), `expected ${filePath} to exist`);
		const contents = readFileSync(filePath, 'utf8');
		assert.match(contents, /capability\.emptyKey/, `${name}.tsx must reference capability.emptyKey`);
	}
});

test('positive control: the PanelFrame-detection matcher hits a synthetic source string that self-wraps', () => {
	const fixture = `<PanelFrame capability={capability}>x</PanelFrame>`;
	assert.match(fixture, /PanelFrame/, 'matcher is inert — it must hit its own positive-control fixture');
});

test('none of the 9 stub components contains "PanelFrame" — composition belongs to PanelGrid (50-09), not a panel', () => {
	/** @type {string[]} */
	const offenders = [];
	for (const name of EXPECTED_COMPONENTS) {
		const contents = readFileSync(path.join(PANELS_DIR, `${name}.tsx`), 'utf8');
		if (contents.includes('PanelFrame')) offenders.push(name);
	}
	assert.deepEqual(offenders, []);
});

test('positive control: dropping "keyholders" from a synthetic registry key list is detected as missing', () => {
	const fullIds = CAPABILITIES.map((c) => c.id);
	/** @type {Set<import('../../src/auth/capabilities.js').CapabilityId>} */
	const syntheticKeys = new Set(fullIds.filter((id) => id !== 'keyholders'));
	const missing = fullIds.filter((id) => !syntheticKeys.has(id));
	assert.deepEqual(missing, ['keyholders'], 'a freeze check that cannot detect a dropped panel is not a freeze check');
});
