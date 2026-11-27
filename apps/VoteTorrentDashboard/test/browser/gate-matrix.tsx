/**
 * gate-matrix.tsx — the tier-3 model↔DOM cross-check driver (D-20). Imports
 * the PRODUCTION modules by relative path, so this gate proves shipped
 * code, not a copy: `evaluate`/`CAPABILITIES`/`SCOPE_CODES` from
 * `../../src/auth/{gate,capabilities}.js`, the preview state model from
 * `../../src/auth/preview-scopes.js`, `PanelGrid` from
 * `../../src/screens/PanelGrid.tsx`, `PreviewAsProvider`/`PreviewAsControl`
 * from `../../src/screens/PreviewAsControl.tsx`, `AdvisoryDisclosure` and
 * the shared four-phase derivation (`derivePhase`/`PHASE_IDS`) from
 * `@votetorrent/ui-web` (the lifecycle module moved there in 53-05),
 * `t` from `@votetorrent/ui-web`.
 *
 * NO PHASE-ID STRING IS WRITTEN OUT IN THIS FILE. Every phase id comes from
 * the imported `PHASE_IDS`, and every lifecycle instant from the seed
 * fixture's `SEED_PHASE_INSTANTS` -- a re-typed literal here is exactly the
 * fourth hand-maintained vocabulary list 54-07 exists to remove.
 *
 * THE ORACLE IS `evaluate`, IMPORTED — NEVER RE-DERIVED. If this file ever
 * computed visibility any other way, the cross-check would be comparing the
 * DOM against a second implementation that can drift, and it would stop
 * being a cross-check.
 *
 * The harness drives the REAL, PRODUCTION "Preview as" control by clicking
 * its actual rendered checkboxes and Reset button — it never constructs a
 * preview state object by hand and hands it to the tree. In parallel, it
 * computes its own "model" prediction by calling the SAME
 * `createPreviewState`/`toggleScope` functions the control itself calls,
 * entirely independent of the DOM, so the comparison below is a genuine
 * cross-check between two independent paths through the one shared oracle.
 *
 * `?mode=` is `seed` | `matrix` | `fresh`. This page is test-only and never
 * reaches the production Vite build.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { evaluate } from '../../src/auth/gate.js';
import { CAPABILITIES, SCOPE_CODES } from '../../src/auth/capabilities.js';
import type { ScopeCode } from '../../src/auth/capabilities.js';
import { createPreviewState, toggleScope, effectiveScopes } from '../../src/auth/preview-scopes.js';
import { derivePhase, PHASE_IDS } from '@votetorrent/ui-web/lifecycle';
import { t } from '@votetorrent/ui-web';
import { PanelGrid } from '../../src/screens/PanelGrid.js';
import { PreviewAsProvider, PreviewAsControl } from '../../src/screens/PreviewAsControl.js';
import { AdvisoryDisclosure } from '@votetorrent/ui-web/components';
import {
	createNetworkDb,
	closeNetworkDb,
	deleteNetworkDb,
	attachNetworkDb,
	readRowCounts,
	writeRowCounts,
} from '@votetorrent/web-data/officer';
import { GATE_NETWORK_HASH, SEED_TABLES, seedFoundingAuthority } from '../../../../packages/web-data/test/fixtures/seed-founding-authority.js';
import {
	seedElectionSurface,
	SEED_TIMELINE,
	SEED_EXPECTED_COUNTS,
	SEED_ELECTION,
	SEED_PHASE_INSTANTS,
} from '../../../../packages/web-data/test/fixtures/seed-election-surface.js';

declare global {
	interface Window {
		__GATE_MATRIX__?: unknown;
		__GATE_MATRIX_DONE__?: boolean;
		__GATE_MATRIX_RUN__?: (
			scopeSetId: string,
			phaseId: string,
			reveal: boolean,
			driftAs?: string,
		) => Promise<unknown>;
	}
}

/**
 * The five `<measured_facts>` scope sets — harness fixture ids, NEVER
 * rendered. `real-all-nine` is the founding officer's real set: the
 * un-simulated default every other row is toggled away from.
 */
const SCOPE_SETS: Readonly<Record<string, ReadonlyArray<ScopeCode>>> = Object.freeze({
	'real-all-nine': SCOPE_CODES,
	'vrg-only': ['vrg'],
	'election-ops': ['vrg', 'mel', 'ceb'],
	'authority-admin': ['rn', 'uai', 'cap', 'rad', 'ik', 'iad'],
	'no-scopes': [],
});

const REAL_SCOPES = SCOPE_SETS['real-all-nine'] as ReadonlyArray<ScopeCode>;

const params = new URLSearchParams(location.search);
const MODE = params.get('mode') ?? 'seed';

/** @type {Array<{ ms: number, category: string, message: string }>} */
const LOG: Array<{ ms: number; category: string; message: string }> = [];
const t0 = performance.now();
function log(category: string, message: string) {
	LOG.push({ ms: +(performance.now() - t0).toFixed(1), category, message });
}

const stepsEl = document.getElementById('steps');
const steps: Array<{ name: string; el: HTMLElement; ok: boolean }> = [];

/** Renders every step with `textContent` only, never as raw markup — nothing
 * derived from the database or from rendered panel text reaches the DOM
 * unescaped (mirrors db-gate.js's / shell-gate.js's T-50-05-06 discipline). */
async function rung(name: string, fn: () => Promise<string>): Promise<{ ok: boolean; value?: string }> {
	const el = document.createElement('div');
	el.textContent = name;
	stepsEl?.appendChild(el);
	try {
		const value = await fn();
		el.className = 'step ok';
		el.textContent = `[ok] ${name} ${value}`;
		steps.push({ name, el, ok: true });
		log('pass', name);
		return { ok: true, value };
	} catch (err) {
		const message = String((err as { message?: unknown })?.message ?? err);
		el.className = 'step fail';
		el.textContent = `[fail] ${name} ${message}`;
		steps.push({ name, el, ok: false });
		log('fail', `${name}: ${message}`);
		return { ok: false };
	}
}

function finish(mode: string, extra: Record<string, unknown> = {}) {
	const passed = steps.filter((s) => s.ok).length;
	const total = steps.length;
	const verdictEl = document.getElementById('verdict');
	const text = `${mode}: ${passed}/${total} rungs passed`;
	if (verdictEl) verdictEl.textContent = text;
	window.__GATE_MATRIX__ = { mode, passed, total, log: LOG, ...extra };
	window.__GATE_MATRIX_DONE__ = true;
	// eslint-disable-next-line no-console
	console.log(`[gate-matrix] ${text}`);
}

async function runSeed() {
	await rung('1 · delete any prior database for a genuinely cold slate', async () => {
		await deleteNetworkDb(GATE_NETWORK_HASH);
		return 'clean slate';
	});

	let handle: Awaited<ReturnType<typeof createNetworkDb>> | undefined;
	const dbR = await rung('2 · create the network database', async () => {
		handle = await createNetworkDb(GATE_NETWORK_HASH);
		return 'created';
	});
	if (!dbR.ok || !handle) return finish('seed');
	const db = handle;

	await rung('3 · seed founding Authority + User + Admin + Officer', async () => {
		await seedFoundingAuthority(db);
		return 'seeded';
	});

	await rung('4 · seed the election surface (Election, ElectionRevision, Ballots, Questions, Options)', async () => {
		await seedElectionSurface(db);
		return 'seeded';
	});

	// attachNetworkDb (used by mode=matrix/mode=fresh) requires a contract-C5
	// row-count record -- db-gate.js's own seed phase does the same.
	await rung('5 · persist the contract-C5 row-count record', async () => {
		const tableNames = [...SEED_TABLES, ...Object.keys(SEED_EXPECTED_COUNTS)];
		const counts = await readRowCounts(db, tableNames);
		await writeRowCounts(GATE_NETWORK_HASH, counts);
		return JSON.stringify(counts);
	});

	await rung('6 · the four lifecycle instants each resolve to their own phase against the seeded Timeline', async () => {
		// The JSON STRING form on purpose: `ElectionRevision.Timeline` stores
		// `JSON.stringify(SEED_TIMELINE)` and `readElectionOverview` returns it
		// raw, so this is the shape production carries into `derivePhase`.
		const timelineJson = JSON.stringify(SEED_TIMELINE);
		const results: Record<string, string> = {};
		for (const [phaseId, instant] of Object.entries(SEED_PHASE_INSTANTS)) {
			const { phase, stage, firedRule, indeterminate, conflicts } = derivePhase(SEED_ELECTION, timelineJson, instant);
			results[phaseId] = `${phase} @ ${stage ?? '(no stage)'}`;
			// Never `reason`: it embeds raw timeline values. `firedRule` and the
			// conflict CODES are machine diagnostics safe to surface in a harness
			// message.
			const codes = conflicts.map((c) => c.code).join(', ');
			if (phase !== phaseId || indeterminate === true || conflicts.length > 0) {
				throw new Error(
					`instant for "${phaseId}" (${instant}) resolved to "${phase}" (fired: ${firedRule ?? 'none'}, indeterminate: ${indeterminate}, conflicts: ${codes || 'none'})`,
				);
			}
		}
		return JSON.stringify(results);
	});

	await rung('7 · close the handle before the page boundary', async () => {
		await closeNetworkDb(db);
		return 'closed';
	});

	finish('seed');
}

/**
 * The one mounted tree, shared by `mode=matrix` and `mode=fresh`.
 * `PreviewAsProvider` owns the real-vs-previewed state internally; this
 * component receives only what varies per re-render.
 */
function Tree({
	db,
	reveal,
	phaseId,
}: {
	db: Awaited<ReturnType<typeof attachNetworkDb>>;
	reveal: boolean;
	phaseId: string;
}) {
	return (
		// This tier-3 harness supplies its scope set synchronously (REAL_SCOPES
		// is a constant, never arriving asynchronously), so no attach window
		// exists here to close -- scopesResolved is always true.
		<PreviewAsProvider realScopes={REAL_SCOPES} scopesResolved={true}>
			<PreviewAsControl />
			<AdvisoryDisclosure variant="authority" />
			<PanelGrid
				db={db}
				revealDenied={reveal}
				onToggleReveal={() => {}}
			/>
		</PreviewAsProvider>
	);
}

function settle(): Promise<void> {
	return new Promise((resolve) => {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				Promise.resolve().then(() => resolve());
			});
		});
	});
}

function capabilityIdForScope(scope: ScopeCode): string {
	const capability = CAPABILITIES.find((c) => c.scope === scope);
	if (!capability) throw new Error(`gate-matrix: no capability for scope "${scope}"`);
	return capability.id;
}

/** Reads the badge text/class and the disclosure presence off the live DOM. */
function readChrome() {
	const badgeEl = document.querySelector('.pv-badge');
	const disclosureEl = document.querySelector('.pv-disclosure');
	return {
		badgeText: badgeEl?.textContent ?? null,
		badgeClass: badgeEl?.className ?? null,
		disclosurePresent: disclosureEl?.textContent === t('advisory.authority.body'),
	};
}

/** Reads, for every capability, whether its panel frame and body are present in the DOM. */
function readPanels() {
	const sections = [...document.querySelectorAll('.panel')];
	return CAPABILITIES.map((capability) => {
		const title = t(capability.titleKey);
		const section = sections.find((el) => el.querySelector('h3')?.textContent === title) ?? null;
		return {
			id: capability.id,
			framePresent: section !== null,
			bodyPresent: section !== null && section.querySelector('.panel-body') !== null,
		};
	});
}

async function runMatrix() {
	let handle: Awaited<ReturnType<typeof attachNetworkDb>> | undefined;
	const attachR = await rung('1 · attachNetworkDb — this page creates and seeds nothing', async () => {
		handle = await attachNetworkDb(GATE_NETWORK_HASH);
		return 'attached';
	});
	if (!attachR.ok || !handle) return finish('matrix');
	const db = handle;

	const container = document.getElementById('root');
	if (!container) throw new Error('gate-matrix: #root element not found');
	const root = createRoot(container);

	let currentReveal = false;
	// `PHASE_IDS[0]`, never a re-typed id: the mount-time phase is overwritten
	// by the first `__GATE_MATRIX_RUN__` call, and assertion D proves the panel
	// set does not depend on it -- but a literal here would still be a phase
	// vocabulary this file maintains by hand.
	let currentPhaseId: string = PHASE_IDS[0];

	await rung('2 · mount PanelGrid + PreviewAsControl + AdvisoryDisclosure once', async () => {
		root.render(
			<StrictMode>
				<Tree db={db} reveal={currentReveal} phaseId={currentPhaseId} />
			</StrictMode>,
		);
		await settle();
		if (!document.querySelector('.pv-control')) throw new Error('the Preview-as control never mounted');
		return 'mounted';
	});

	finish('matrix');

	/**
	 * Called once per rung by `run-headless.mjs`. Drives the REAL control
	 * (Reset, then the checkboxes that differ) to reach `scopeSetId`,
	 * re-renders with `reveal`/`phaseId`, and compares the resulting DOM
	 * against a model computed independently of it. `driftAs`, when set, is
	 * `--prove-drift`'s inertness control: the DOM is still driven to
	 * `scopeSetId`, but the model is computed as if the scope set were
	 * `driftAs` instead — a deliberate mismatch the comparison must catch.
	 */
	window.__GATE_MATRIX_RUN__ = async (scopeSetId, phaseId, reveal, driftAs) => {
		const target = SCOPE_SETS[scopeSetId];
		if (!target) throw new Error(`gate-matrix: unknown scope set "${scopeSetId}"`);

		// 1 · Reset the REAL control to the known REAL_SCOPES baseline.
		const resetButton = document.querySelector<HTMLButtonElement>('.pv-reset');
		resetButton?.click();
		await settle();

		// 2 · Toggle, via the REAL checkboxes, every code where the target
		// differs from REAL_SCOPES.
		const targetSet = new Set(target);
		const realSet = new Set(REAL_SCOPES);
		for (const capability of CAPABILITIES) {
			const inTarget = targetSet.has(capability.scope);
			const inReal = realSet.has(capability.scope);
			if (inTarget !== inReal) {
				const input = document.getElementById(`pv-scope-${capability.id}`) as HTMLInputElement | null;
				input?.click();
			}
		}
		await settle();

		// Re-render with this rung's reveal/phase.
		currentReveal = reveal;
		currentPhaseId = phaseId;
		root.render(
			<StrictMode>
				<Tree db={db} reveal={currentReveal} phaseId={currentPhaseId} />
			</StrictMode>,
		);
		await settle();

		// 3 · The oracle's input: computed independently, via the SAME
		// createPreviewState/toggleScope functions the control itself calls,
		// never by reading the DOM back.
		let modelState = createPreviewState(REAL_SCOPES);
		for (const capability of CAPABILITIES) {
			const inTarget = targetSet.has(capability.scope);
			const inReal = realSet.has(capability.scope);
			if (inTarget !== inReal) modelState = toggleScope(modelState, capability.scope);
		}
		const modelEffective = driftAs ? (SCOPE_SETS[driftAs] ?? []) : effectiveScopes(modelState);
		const model = CAPABILITIES.map((capability) => ({
			id: capability.id,
			visible: evaluate(capability, modelEffective).visible,
		}));

		const dom = readPanels();
		const chrome = readChrome();

		return {
			scopeSetId,
			phaseId,
			reveal,
			effective: modelEffective,
			model,
			dom,
			...chrome,
		};
	};
}

async function runFresh() {
	let handle: Awaited<ReturnType<typeof attachNetworkDb>> | undefined;
	const attachR = await rung('1 · attachNetworkDb on a genuinely fresh page load', async () => {
		handle = await attachNetworkDb(GATE_NETWORK_HASH);
		return 'attached';
	});
	if (!attachR.ok || !handle) return finish('fresh');
	const db = handle;

	const container = document.getElementById('root');
	if (!container) throw new Error('gate-matrix: #root element not found');
	const root = createRoot(container);

	await rung('2 · mount with NO toggles applied — a preview must never survive a reload', async () => {
		root.render(
			<StrictMode>
				{/* `PHASE_IDS[0]` for the same reason as `mode=matrix`'s mount-time default. */}
				<Tree db={db} reveal={false} phaseId={PHASE_IDS[0]} />
			</StrictMode>,
		);
		await settle();
		return 'mounted';
	});

	const chrome = readChrome();
	finish('fresh', chrome);
}

async function main() {
	log('start', `gate-matrix mode=${MODE}`);
	if (MODE === 'seed') {
		await runSeed();
	} else if (MODE === 'matrix') {
		await runMatrix();
	} else if (MODE === 'fresh') {
		await runFresh();
	}
}

main().catch((err) => {
	log('crash', String((err as { stack?: unknown })?.stack ?? err));
	window.__GATE_MATRIX__ = { mode: MODE, crashed: String((err as { stack?: unknown })?.stack ?? err), log: LOG };
	window.__GATE_MATRIX_DONE__ = true;
	// eslint-disable-next-line no-console
	console.error('[gate-matrix] crashed', err);
});
