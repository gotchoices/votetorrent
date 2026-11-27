/**
 * panel-view-state.test.mjs — the automated D-18/D-19 view-state proof, plus
 * the E2 banned-literal scan restated here because this plan is what
 * introduces a reason for a panel to reach toward the shared chrome.
 *
 * Imports `panel-view-storage.js` directly (plain JS, so `node --test`
 * resolves it with no bundler) and reads `ChartViewContext.tsx`,
 * `PanelFrame.tsx` and all nine `*Panel.tsx` files as text, in this
 * directory's established source-text-test shape.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { dashboardSrc } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';
import { CAPABILITIES } from '../../src/auth/capabilities.js';
import {
	PANEL_VIEWS,
	DEFAULT_PANEL_VIEW,
	PANEL_VIEW_STORAGE_PREFIX,
	panelViewStorageKey,
	readStoredPanelView,
	writeStoredPanelView,
} from '../../src/screens/panels/panel-view-storage.js';

const PANELS_DIR = dashboardSrc('screens', 'panels');

/** A `Map`-backed localStorage-shaped fake, exposing its raw key set for
 * test-only inspection (Node 22 has no real `localStorage`). Precedent:
 * `refresh-swap.test.mjs:58`, `freshness-forget.test.mjs:54`.
 * @returns {{ getItem: (key: string) => string | null; setItem: (key: string, value: string) => void; removeItem: (key: string) => void; _keys: () => string[]; _values: () => string[] }} */
function makeFakeStorage() {
	/** @type {Map<string, string>} */
	const map = new Map();
	return {
		getItem: (key) => (map.has(key) ? /** @type {string} */ (map.get(key)) : null),
		setItem: (key, value) => {
			map.set(key, value);
		},
		removeItem: (key) => {
			map.delete(key);
		},
		_keys: () => [...map.keys()],
		_values: () => [...map.values()],
	};
}

/** A storage double whose getItem/setItem both throw -- a hostile browser
 * refusing every access (private-browsing quota refusal, etc). */
function makeThrowingStorage() {
	return {
		getItem: () => {
			throw new Error('storage refused');
		},
		setItem: () => {
			throw new Error('storage refused');
		},
	};
}

// --- Behaviour rungs --------------------------------------------------------

test('D-18 default: readStoredPanelView returns "chart" for an unseen id, across several ids', () => {
	const fake = makeFakeStorage();
	assert.equal(readStoredPanelView('keyholders', fake), 'chart');
	assert.equal(readStoredPanelView('registrations', fake), 'chart');
	assert.equal(readStoredPanelView('elections', fake), 'chart');
});

test('D-18 fallback on a poisoned value: an unvalidated stored string never survives the read', () => {
	for (const poison of ['table', '', 'CHART']) {
		const fake = makeFakeStorage();
		fake.setItem(panelViewStorageKey('keyholders'), poison);
		assert.equal(readStoredPanelView('keyholders', fake), 'chart', `poisoned value "${poison}" leaked through`);
	}
});

test('D-19 round trip: a written view reads back, under exactly the expected key', () => {
	const fake = makeFakeStorage();
	writeStoredPanelView('registrations', 'grid', fake);
	assert.equal(readStoredPanelView('registrations', fake), 'grid');
	assert.deepEqual(fake._keys(), ['vt-dashboard-panel-view:registrations']);
});

test('D-19 per-panel independence: writing one panel leaves a sibling panel at the default', () => {
	const fake = makeFakeStorage();
	writeStoredPanelView('registrations', 'grid', fake);
	assert.equal(readStoredPanelView('keyholders', fake), 'chart');
	writeStoredPanelView('keyholders', 'grid', fake);
	assert.equal(fake._keys().length, 2);
});

test('D-19 payload confinement (T-60-04-01): every stored key/value stays inside the frozen shapes', () => {
	const fake = makeFakeStorage();
	for (const capability of CAPABILITIES) {
		writeStoredPanelView(capability.id, 'chart', fake);
		writeStoredPanelView(capability.id, 'grid', fake);
	}
	for (const key of fake._keys()) {
		assert.ok(key.startsWith(PANEL_VIEW_STORAGE_PREFIX), `key "${key}" does not start with the panel-view prefix`);
		const id = key.slice(PANEL_VIEW_STORAGE_PREFIX.length);
		assert.ok(
			CAPABILITIES.some((c) => c.id === id),
			`key "${key}" names an id not in CAPABILITIES`,
		);
	}
	for (const value of fake._values()) {
		assert.ok(/** @type {ReadonlyArray<string>} */ (PANEL_VIEWS).includes(value), `value "${value}" is not a member of PANEL_VIEWS`);
	}
});

test('rejection: an invalid view value is never written', () => {
	const fake = makeFakeStorage();
	writeStoredPanelView('keyholders', 'chart-and-grid', fake);
	writeStoredPanelView('keyholders', '{"rows":1}', fake);
	assert.deepEqual(fake._keys(), []);
});

test('hostile storage is swallowed: a throwing getItem/setItem yields the default and never throws', () => {
	const hostile = makeThrowingStorage();
	assert.equal(readStoredPanelView('keyholders', hostile), 'chart');
	assert.doesNotThrow(() => writeStoredPanelView('keyholders', 'grid', hostile));
});

test('control: a fake pre-seeded with "grid" under the correct key returns "grid"', () => {
	const fake = makeFakeStorage();
	fake.setItem(panelViewStorageKey('keyholders'), 'grid');
	assert.equal(readStoredPanelView('keyholders', fake), 'grid');
});

// --- Source-text rungs -------------------------------------------------------

const FRAME_OR_CONTEXT_RE = /PanelFrame|SnapshotInstantContext/;

const CHART_VIEW_CONTEXT_RAW = readFileSync(path.join(PANELS_DIR, 'ChartViewContext.tsx'), 'utf8');
const PANEL_FRAME_STRIPPED = stripComments(readFileSync(path.join(PANELS_DIR, 'PanelFrame.tsx'), 'utf8'));
const KEYHOLDERS_STRIPPED = stripComments(readFileSync(path.join(PANELS_DIR, 'KeyholdersPanel.tsx'), 'utf8'));

const ALL_PANEL_FILES = [
	'RegistrationsPanel.tsx',
	'ElectionsPanel.tsx',
	'BallotsQuestionsPanel.tsx',
	'NetworkSettingsPanel.tsx',
	'AuthorityProfilePanel.tsx',
	'AuthorityPeersPanel.tsx',
	'AdministrationOfficersPanel.tsx',
	'KeyholdersPanel.tsx',
	'InviteAuthoritiesPanel.tsx',
];

test('positive control: the E2 banned-literal matcher hits a synthetic self-wrapping import', () => {
	const fixture = `import PanelFrame from './PanelFrame.tsx';`;
	assert.match(fixture, FRAME_OR_CONTEXT_RE, 'matcher is inert -- it must hit its own positive-control fixture');
});

test('E2: ChartViewContext.tsx RAW source contains neither PanelFrame nor SnapshotInstantContext', () => {
	assert.doesNotMatch(CHART_VIEW_CONTEXT_RAW, FRAME_OR_CONTEXT_RE);
});

test('none of the nine *Panel.tsx files contains PanelFrame in its RAW source', () => {
	for (const file of ALL_PANEL_FILES) {
		const raw = readFileSync(path.join(PANELS_DIR, file), 'utf8');
		assert.ok(!raw.includes('PanelFrame'), `${file} references PanelFrame in its RAW source`);
	}
});

test('PanelFrame.tsx stripped source wires ChartViewProvider and the two switch copy keys', () => {
	assert.match(PANEL_FRAME_STRIPPED, /ChartViewProvider/);
	assert.match(PANEL_FRAME_STRIPPED, /panelFrame\.viewChart/);
	assert.match(PANEL_FRAME_STRIPPED, /panelFrame\.viewGrid/);
});

test('reality guard: the aa-row roster marker is genuinely present in KeyholdersPanel.tsx before asserting it is not absent', () => {
	assert.match(KEYHOLDERS_STRIPPED, /aa-row/, 'the aa-row probe is not real -- the D-20 assertion below would pass vacuously');
});

test('D-20: KeyholdersPanel.tsx stripped source contains both usePanelView and the existing roster marker aa-row', () => {
	assert.match(KEYHOLDERS_STRIPPED, /usePanelView/);
	assert.match(KEYHOLDERS_STRIPPED, /aa-row/);
});
