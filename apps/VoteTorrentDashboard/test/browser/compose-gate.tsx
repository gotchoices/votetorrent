/**
 * compose-gate.tsx -- the composed-shell gate, on the LIVE boot.
 *
 * This page mounts the production `DashboardShell` (and, for the pairing
 * legs, the production `Pairing` screen through `GateApp`, the mirror of
 * `main.tsx`'s routing) and asserts what the DOM shows. The shell runs the
 * REAL `startDashboardBoot`; only the peer layer is fake, injected through
 * the shell's `bootDeps` and the pairing screen's `loadPairing` (both from
 * `./live-gate.js`). The local store, registry, replication bridge, strand
 * reader, scope read, preview control and panels are the shipped modules.
 *
 * TOKENS. This page now loads the design tokens and component sheets: the
 * `./live-gate.js` import carries `../../src/app.css`. Its driver does not
 * run here (this page's `<html>` has no `data-gate="live-gate"`).
 *
 * The phase names, query flags and readout fields are `run-headless.mjs`'s
 * and CI's contract (runner identifiers, not user copy):
 *   compose-seed          clear the registry, seed the compose network, run a
 *                         headless boot to its first completed pass; mount nothing.
 *   compose-verify        a fresh page; fail loudly without an entry. Mount the
 *                         shell with zero interaction: nine populated panels,
 *                         zero denied, the real badge, the advisory disclosure,
 *                         the reveal toggle not pressed, the chip reaching Live.
 *                         `&officer=none` rewrites the entry's officer to an id
 *                         the replicated rows grant nothing, so the nine-panel
 *                         rung must FAIL (`--prove-blank`).
 *   compose-swap          the real swap dialog in Pairing names both officers;
 *                         keep resolves `swap-declined` with the entry unchanged;
 *                         replace resolves with a handoff and the shell mounts
 *                         with `adopt`: nine panels, chip Live.
 *   compose-preview-race  the local copy starts empty and the first pass is
 *                         held, so the officer's scopes arrive late; the preview
 *                         control is touched during the hold; after release,
 *                         Reset recovers the full nine with the real badge.
 *   compose-guards        a boot failure on one network shows the generic
 *                         banner on that network only and the other opens
 *                         healthy; a double click on the swap confirm continues
 *                         pairing once; a double click on the forget confirm
 *                         forgets once and leaves exactly the other network.
 *   compose-refusal       three refusals through the real form; each alert's
 *                         heading and body equal `t()` of that reason's
 *                         `FAILURE_VIEWS` keys and the three are pairwise
 *                         distinct. `&conflate=1` drives `expired` three times,
 *                         so the distinctness rung must FAIL (`--prove-conflated`).
 *
 * Readout: `window.__COMPOSE_GATE__` (`phase`, `passed`, `total`, `log`,
 * `panels`, `badgeText`, `badgeClass`) and `window.__COMPOSE_GATE_DONE__`.
 * Every step renders with `textContent` only.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { t } from '@votetorrent/ui-web';
import { findNetwork, listNetworks, removeNetwork, upsertNetwork } from '@votetorrent/web-data/officer';
import { CAPABILITIES } from '../../src/auth/capabilities.js';
import { DashboardShell } from '../../src/screens/DashboardShell.js';
import { FAILURE_VIEWS } from '../../src/screens/Pairing.js';
import type { PairFailureReason } from '../../src/screens/Pairing.js';
import { lifecycleChannelName } from '../../src/lifecycle/forget-network.js';
import {
	GATE_NETWORKS,
	GATE_OFFICER_USER_ID,
	GateApp,
	clearGateRegistry,
	createFakePairing,
	createFakePeerLayer,
	createStrandImage,
	loadPeerModules,
	seedGateNetwork,
} from './live-gate.js';

const win = window as unknown as Record<string, unknown>;

const COMPOSE = GATE_NETWORKS.A;
const OTHER = GATE_NETWORKS.B;
/** An id that owns no Officer row in the replicated rows: `&officer=none`. */
const NO_SUCH_OFFICER = 'compose-gate-no-such-officer';
/** compose-swap's incoming officer (the image carries a User and an Officer row for it). */
const OFFICER_2 = { userId: 'compose-gate-officer-2', name: 'Officer Two' };
/** A synthetic pairing code for the form (never a real one). */
const FORM_CODE = 'vtpair1.' + 'Z'.repeat(80);

const LOG: Array<{ t: string; ms: number; category: string; message: string }> = [];
const t0 = performance.now();
function log(category: string, message: string) {
	LOG.push({ t: new Date().toISOString(), ms: +(performance.now() - t0).toFixed(1), category, message });
}

const params = new URLSearchParams(location.search);
const PHASE = params.get('phase') ?? 'compose-seed';
const OFFICER_NONE = params.get('officer') === 'none';
const CONFLATE = params.get('conflate') === '1';

const stepsEl = document.getElementById('steps');
const steps: Array<{ name: string; el: HTMLElement; ok: boolean }> = [];
const readout: Record<string, unknown> = { panels: 0, badgeText: '', badgeClass: '' };

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

function publish() {
	win.__COMPOSE_GATE__ = { ...readout, phase: PHASE, passed: steps.filter((s) => s.ok).length, total: steps.length, log: LOG };
	win.__COMPOSE_GATE_DONE__ = true;
}

/** A bounded rAF poll for at least one `.panel` section (never a fixed sleep). */
function settleUntilPanels(maxFrames: number): Promise<number> {
	return new Promise((resolve) => {
		let frames = 0;
		function tick() {
			frames += 1;
			const count = document.querySelectorAll('.panel').length;
			if (count > 0 || frames >= maxFrames) {
				resolve(count);
				return;
			}
			requestAnimationFrame(tick);
		}
		requestAnimationFrame(tick);
	});
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
}

function waitForElement<T extends Element>(selector: string, timeoutMs = 15_000): Promise<T> {
	return waitUntil(() => document.querySelector(selector) !== null, timeoutMs, selector).then(() => document.querySelector(selector) as T);
}

const chipKind = () => document.querySelector('.sh-status-chip')?.getAttribute('data-kind') ?? null;

/** React's controlled textarea: set the value through the native setter, then dispatch input. */
function typeInto(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
	const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
	el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The shared nine-panel rung set (A-F of the old gate), measured un-revealed. */
async function assertComposedPanels(prefix: string) {
	await rung(`${prefix}A · panel count equals the full capability set, measured un-revealed`, async () => {
		const count = document.querySelectorAll('.panel').length;
		readout.panels = count;
		if (count !== CAPABILITIES.length) throw new Error(`expected ${CAPABILITIES.length} panels, observed ${count}`);
		return `panels: ${count}`;
	});
	await rung(`${prefix}B · every capability has a titled, populated panel section`, async () => {
		for (const capability of CAPABILITIES) {
			const frame = document.getElementById(`panel-${capability.id}`);
			const titleMatches = frame?.querySelector('h3.panel-title')?.textContent?.startsWith(t(capability.titleKey)) === true;
			const bodyPresent = frame?.querySelector('.panel-body') != null;
			if (!frame || !titleMatches || !bodyPresent) throw new Error(`capability "${capability.id}": frame=${!!frame} title=${titleMatches} body=${bodyPresent}`);
		}
		return `${CAPABILITIES.length}/${CAPABILITIES.length} capabilities matched`;
	});
	await rung(`${prefix}C · zero access-denied panel sections in the un-revealed state`, async () => {
		const denied = document.querySelectorAll('.panel--denied').length;
		if (denied !== 0) throw new Error(`expected 0 denied panel sections, observed ${denied}`);
		return `denied: ${denied}`;
	});
	await rung(`${prefix}D · the scope-gate badge reads the real, database-given answer`, async () => {
		const badge = document.querySelector('.pv-badge');
		readout.badgeText = badge?.textContent ?? '';
		readout.badgeClass = badge?.className ?? '';
		if (readout.badgeText !== t('gate.badgeReal')) throw new Error(`badge text differs from t('gate.badgeReal')`);
		if (!String(readout.badgeClass).includes('pv-badge--real')) throw new Error('badge class lacks the real-answer modifier');
		return `${readout.badgeText} (${readout.badgeClass})`;
	});
	await rung(`${prefix}E · the advisory disclosure is present`, async () => {
		if (document.querySelector('.pv-disclosure')?.textContent !== t('advisory.authority.body')) throw new Error('disclosure missing');
		return 'present';
	});
	await rung(`${prefix}F · the reveal toggle is in its default, not-pressed state`, async () => {
		const pressed = document.querySelector('.sh-reveal-toggle')?.getAttribute('aria-pressed') ?? null;
		if (pressed !== 'false') throw new Error(`reveal toggle aria-pressed="${pressed}"`);
		return 'aria-pressed="false"';
	});
}

function mountShell(root: Root, networkHash: string, bootDeps: Record<string, unknown>) {
	root.render(
		<StrictMode>
			<DashboardShell initialNetworkHash={networkHash} onPairAnother={() => {}} onUnpaired={() => {}} onNoNetworks={() => {}} bootDeps={bootDeps} />
		</StrictMode>,
	);
}

function rootOrThrow(): Root {
	const container = document.getElementById('root');
	if (!container) throw new Error('compose-gate.html is missing #root');
	return createRoot(container);
}

// --- phases -------------------------------------------------------------------

async function runComposeSeed() {
	await rung('1 · clear EVERY registry entry and seed the compose network fresh (empty local store, paired entry)', async () => {
		clearGateRegistry();
		await seedGateNetwork(COMPOSE);
		return 'clean slate';
	});
	await rung('2 · a headless live boot over the fake peer layer replicates the strand image to its first completed pass', async () => {
		const image = await createStrandImage({ extraOfficers: [OFFICER_2] });
		const { bootDeps, control } = createFakePeerLayer({ image: { [COMPOSE.networkHash]: image }, mode: 'auto' });
		const boot = await (await loadPeerModules()).startDashboardBoot({ networkHash: COMPOSE.networkHash, deps: bootDeps });
		if (boot.failure !== null) throw new Error(`boot failure ${boot.failure}`);
		await waitUntil(() => (control.counts()[COMPOSE.networkHash]?.passesComplete ?? 0) >= 1, 30_000, 'the first completed pass');
		await boot.whenIdle();
		await boot.stop();
		return 'replicated';
	});
	await rung('3 · a paired registry entry exists, naming the fixture officer', async () => {
		const entry = findNetwork(COMPOSE.networkHash);
		if (!entry || entry.pairing === null) throw new Error('registry entry missing or unpaired');
		if (entry.officerUserId !== GATE_OFFICER_USER_ID) throw new Error('the entry names another officer');
		return 'present';
	});
}

async function runComposeVerify() {
	const seedCheck = await rung('1 · a prior compose-seed page left a registry entry (verify, never re-seed here)', async () => {
		if (!findNetwork(COMPOSE.networkHash)) throw new Error('no registry entry: compose-seed must run first, on its own page');
		return 'present';
	});
	if (!seedCheck.ok) return;
	if (OFFICER_NONE) {
		await rung('1b · &officer=none: rewrite the entry to an officer id the replicated rows grant nothing', async () => {
			const entry = findNetwork(COMPOSE.networkHash);
			if (!entry) throw new Error('no registry entry to rewrite');
			upsertNetwork({ ...entry, officerUserId: NO_SUCH_OFFICER });
			return `officerUserId -> ${NO_SUCH_OFFICER}`;
		});
	}
	const image = await createStrandImage({ extraOfficers: [OFFICER_2] });
	const { bootDeps } = createFakePeerLayer({ image: { [COMPOSE.networkHash]: image }, mode: 'auto' });
	const root = rootOrThrow();
	await rung('2 · mount the production DashboardShell on the live boot (fake peer layer only), zero interaction', async () => {
		mountShell(root, COMPOSE.networkHash, bootDeps);
		return 'mounted';
	});
	await rung('3 · settle: a bounded rAF poll until a panel section renders', async () => `panels observed: ${await settleUntilPanels(600)}`);
	await rung('3b · settle: the scope read and the preview control have resolved', async () => {
		await waitUntil(() => document.querySelector('.pv-badge') !== null && document.querySelectorAll('.panel').length >= CAPABILITIES.length, 20_000, 'the composed shell');
		return 'settled';
	});
	await assertComposedPanels('');
	await rung('G · the status chip reaches Live after the first completed pass', async () => {
		await waitUntil(() => chipKind() === 'live', 30_000, 'Live');
		return 'live';
	});
}

async function runComposeSwap() {
	await rung('1 · a registry entry exists for the compose network', async () => {
		if (!findNetwork(COMPOSE.networkHash)) throw new Error('compose-seed must run first');
		return 'present';
	});
	const image = await createStrandImage({ extraOfficers: [OFFICER_2] });
	const { bootDeps, control } = createFakePeerLayer({ image: { [COMPOSE.networkHash]: image }, mode: 'auto' });
	const held = { userId: GATE_OFFICER_USER_ID, name: 'Ada Officer' };
	const request = { networkHash: COMPOSE.networkHash, authorityName: COMPOSE.authorityName, held, incoming: { userId: OFFICER_2.userId, name: OFFICER_2.name }, incomingVerified: true };
	const pairing = createFakePairing([
		{ kind: 'swap', request, then: { kind: 'fail', reason: 'unreachable' } },
		{
			kind: 'swap',
			request,
			then: {
				kind: 'ok',
				networkHash: COMPOSE.networkHash,
				beforeHandoff: async () => {
					const entry = findNetwork(COMPOSE.networkHash);
					if (entry) upsertNetwork({ ...entry, officerUserId: OFFICER_2.userId, officerName: OFFICER_2.name });
				},
				handoff: () => control.createHandoff(COMPOSE.networkHash),
			},
		},
	]);
	const root = rootOrThrow();
	root.render(
		<StrictMode>
			<GateApp bootDeps={bootDeps} loadPairing={pairing.loadPairing} />
		</StrictMode>,
	);
	/** Open the pairing screen from the shell's switcher and submit the form code. */
	const submitFromShell = async () => {
		(await waitForElement<HTMLButtonElement>('.sh-switcher-button')).click();
		(await waitForElement<HTMLButtonElement>('.sh-switcher-pair')).click();
		const field = await waitForElement<HTMLTextAreaElement>('.pr-code');
		typeInto(field, FORM_CODE);
		await waitUntil(() => !(document.querySelector('.pr-cta') as HTMLButtonElement | null)?.disabled, 5_000, 'an enabled CTA');
		(document.querySelector('.pr-cta') as HTMLButtonElement).click();
		return waitForElement<HTMLElement>('.pr-dialog');
	};
	await rung('2 · the real swap dialog names both officers; keep resolves swap-declined and leaves the entry unchanged', async () => {
		const dialog = await submitFromShell();
		const text = dialog.textContent ?? '';
		if (!text.includes(held.name) || !text.includes(OFFICER_2.name)) throw new Error('the dialog does not name both officers');
		(dialog.querySelector('.pr-button') as HTMLButtonElement).click();
		await waitUntil(() => document.querySelector('.pr-dialog') === null, 5_000, 'the dialog to close');
		if (findNetwork(COMPOSE.networkHash)?.officerUserId !== GATE_OFFICER_USER_ID) throw new Error('the entry changed after keep');
		return 'kept';
	});
	await rung('3 · replace continues with a handoff; the shell mounts with adopt', async () => {
		const field = await waitForElement<HTMLTextAreaElement>('.pr-code');
		typeInto(field, FORM_CODE);
		await waitUntil(() => !(document.querySelector('.pr-cta') as HTMLButtonElement | null)?.disabled, 5_000, 'an enabled CTA');
		(document.querySelector('.pr-cta') as HTMLButtonElement).click();
		const dialog = await waitForElement<HTMLElement>('.pr-dialog');
		(dialog.querySelector('.pr-cta') as HTMLButtonElement).click();
		await waitForElement('.sh-topbar', 30_000);
		await settleUntilPanels(600);
		if (findNetwork(COMPOSE.networkHash)?.officerUserId !== OFFICER_2.userId) throw new Error('the entry does not name the incoming officer');
		return 'adopted';
	});
	await waitUntil(() => document.querySelectorAll('.panel').length >= CAPABILITIES.length && document.querySelector('.pv-badge') !== null, 20_000, 'panels').catch(() => undefined);
	await assertComposedPanels('swap ');
	await rung('swap G · the chip reaches Live on the adopted node', async () => {
		await waitUntil(() => chipKind() === 'live', 30_000, 'Live');
		return 'live';
	});
}

async function runComposePreviewRace() {
	await rung('1 · clear the registry and seed the compose network with an EMPTY local copy', async () => {
		clearGateRegistry();
		await seedGateNetwork(COMPOSE);
		return 'seeded';
	});
	const image = await createStrandImage({ extraOfficers: [OFFICER_2] });
	const { bootDeps, control } = createFakePeerLayer({ image: { [COMPOSE.networkHash]: image }, mode: 'auto' });
	control.holdFirstPass(COMPOSE.networkHash);
	const root = rootOrThrow();
	mountShell(root, COMPOSE.networkHash, bootDeps);
	await rung('2 · during the held first pass, touch the preview control', async () => {
		const box = await waitForElement<HTMLInputElement>('.pv-control input[type="checkbox"]', 20_000);
		await waitUntil(() => !box.disabled, 10_000, 'an enabled preview checkbox');
		box.click();
		if ((control.counts()[COMPOSE.networkHash]?.passesComplete ?? 0) !== 0) throw new Error('a pass completed before the touch');
		return 'touched while held';
	});
	await rung('3 · release the pass: the officer scopes arrive and the chip reaches Live', async () => {
		control.releasePass(COMPOSE.networkHash);
		await waitUntil(() => chipKind() === 'live', 30_000, 'Live');
		return 'live';
	});
	await rung('4 · Reset recovers the real scope set', async () => {
		const reset = await waitForElement<HTMLButtonElement>('.pv-reset');
		await waitUntil(() => !reset.disabled, 10_000, 'an enabled Reset');
		reset.click();
		await waitUntil(() => document.querySelectorAll('.panel--denied').length === 0 && document.querySelectorAll('.panel').length === CAPABILITIES.length, 10_000, 'nine panels');
		return 'reset';
	});
	await assertComposedPanels('race ');
}

async function runComposeGuards() {
	await rung('1 · clean slate: clear EVERY registry entry; seed one healthy network and one whose local copy is absent', async () => {
		clearGateRegistry();
		await seedGateNetwork(COMPOSE);
		await seedGateNetwork(OTHER, { withoutStore: true });
		return 'seeded';
	});
	const image = await createStrandImage({ extraOfficers: [OFFICER_2] });
	const { bootDeps } = createFakePeerLayer({ image: { [COMPOSE.networkHash]: image, [OTHER.networkHash]: image }, mode: 'auto' });
	const request = { networkHash: OTHER.networkHash, authorityName: OTHER.authorityName, held: { userId: GATE_OFFICER_USER_ID, name: 'Ada Officer' }, incoming: { userId: OFFICER_2.userId, name: OFFICER_2.name }, incomingVerified: true };
	const pairing = createFakePairing([{ kind: 'swap', request, then: { kind: 'fail', reason: 'unreachable' } }]);
	const closing: unknown[] = [];
	const channel = new BroadcastChannel(lifecycleChannelName(COMPOSE.networkHash));
	channel.onmessage = (event) => closing.push(event.data);
	const root = rootOrThrow();
	root.render(
		<StrictMode>
			<DashboardShell initialNetworkHash={OTHER.networkHash} onPairAnother={() => {}} onUnpaired={() => {}} onNoNetworks={() => {}} bootDeps={bootDeps} />
		</StrictMode>,
	);
	await rung('2 · the network whose local copy cannot open shows the generic failure banner', async () => {
		const banner = await waitForElement<HTMLElement>('.sh-error-banner', 20_000);
		if (!(banner.textContent ?? '').includes(t('shell.openFailed'))) throw new Error('banner text differs');
		return 'banner shown';
	});
	await rung('3 · switching to the healthy network shows no banner (a stale error never crosses networks)', async () => {
		(await waitForElement<HTMLButtonElement>('.sh-switcher-button')).click();
		const findRow = () =>
			[...document.querySelectorAll<HTMLElement>('.sh-switcher-row')].find((el) => (el.textContent ?? '').includes(COMPOSE.authorityName.slice(0, 20)));
		await waitUntil(() => findRow() !== undefined, 5_000, 'the switcher row for the healthy network');
		const row = findRow() as HTMLElement;
		row.click();
		await settleUntilPanels(600);
		await waitUntil(() => document.querySelectorAll('.panel').length > 0, 20_000, 'panels');
		if (document.querySelector('.sh-error-banner')) throw new Error('the banner crossed networks');
		return 'healthy';
	});
	root.unmount();
	const root2 = rootOrThrow();
	root2.render(
		<StrictMode>
			<GateApp bootDeps={bootDeps} loadPairing={pairing.loadPairing} />
		</StrictMode>,
	);
	await rung('4 · a double click on the swap confirm continues pairing exactly once', async () => {
		(await waitForElement<HTMLButtonElement>('.sh-switcher-button')).click();
		(await waitForElement<HTMLButtonElement>('.sh-switcher-pair')).click();
		typeInto(await waitForElement<HTMLTextAreaElement>('.pr-code'), FORM_CODE);
		await waitUntil(() => !(document.querySelector('.pr-cta') as HTMLButtonElement | null)?.disabled, 5_000, 'an enabled CTA');
		(document.querySelector('.pr-cta') as HTMLButtonElement).click();
		const confirm = (await waitForElement<HTMLElement>('.pr-dialog')).querySelector('.pr-cta') as HTMLButtonElement;
		confirm.click();
		confirm.click();
		await waitForElement('.pr-alert', 10_000);
		const { continuations } = pairing.stats();
		if (continuations !== 1) throw new Error(`continued ${continuations} times`);
		return 'continued once';
	});
	await rung('5 · a double click on the forget confirm forgets once and leaves exactly the other network', async () => {
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		(await waitForElement<HTMLButtonElement>('.sh-kebab-button', 20_000)).click();
		(await waitForElement<HTMLButtonElement>('.sh-kebab-item--destructive')).click();
		const input = await waitForElement<HTMLInputElement>('.sh-dialog-input');
		typeInto(input, COMPOSE.authorityName);
		const cta = await waitForElement<HTMLButtonElement>('.sh-dialog-cta--destructive');
		await waitUntil(() => !cta.disabled, 5_000, 'an enabled forget confirm');
		cta.click();
		cta.click();
		await waitUntil(() => !findNetwork(COMPOSE.networkHash), 15_000, 'the forget');
		await new Promise((r) => setTimeout(r, 500));
		const remaining = listNetworks().map((e) => e.networkHash);
		if (remaining.length !== 1 || remaining[0] !== OTHER.networkHash) throw new Error(`remaining ${remaining.length} network(s)`);
		if (closing.length !== 1) throw new Error(`${closing.length} closing message(s) (want 1)`);
		if (document.querySelector('.sh-dialog-error')) throw new Error('the forget dialog shows an error');
		return 'forgot once';
	});
	channel.close();
}

async function runComposeRefusal() {
	await rung("1 · clean slate: clear EVERY registry entry, so the app opens on pairing", async () => {
		clearGateRegistry();
		for (const entry of listNetworks()) removeNetwork(entry.networkHash);
		return 'clean slate';
	});
	const reasons: PairFailureReason[] = CONFLATE ? ['expired', 'expired', 'expired'] : ['expired', 'spent', 'digest-mismatch'];
	const pairing = createFakePairing(reasons.map((reason) => ({ kind: 'fail' as const, reason })));
	const image = await createStrandImage();
	const { bootDeps } = createFakePeerLayer({ image, mode: 'auto' });
	const root = rootOrThrow();
	root.render(
		<StrictMode>
			<GateApp bootDeps={bootDeps} loadPairing={pairing.loadPairing} />
		</StrictMode>,
	);
	const seen: Array<{ heading: string; body: string }> = [];
	for (const [i, reason] of reasons.entries()) {
		await rung(`${i + 2} · refusal "${reason}": the alert heading and body equal t() of its FAILURE_VIEWS keys`, async () => {
			if (i > 0) {
				const retry = document.querySelector('.pr-alert .pr-button') as HTMLButtonElement | null;
				retry?.click();
			}
			const field = await waitForElement<HTMLTextAreaElement>('.pr-code');
			typeInto(field, FORM_CODE);
			await waitUntil(() => !(document.querySelector('.pr-cta') as HTMLButtonElement | null)?.disabled, 5_000, 'an enabled CTA');
			(document.querySelector('.pr-cta') as HTMLButtonElement).click();
			const alert = await waitForElement<HTMLElement>('.pr-alert', 10_000);
			await waitUntil(() => pairing.stats().calls === i + 1, 5_000, 'the submission');
			const heading = alert.querySelector('h2')?.textContent ?? '';
			const body = alert.querySelector('.pr-body')?.textContent ?? '';
			seen.push({ heading, body });
			if (heading !== t(FAILURE_VIEWS[reason].headingKey)) throw new Error('heading differs');
			if (body !== t(FAILURE_VIEWS[reason].bodyKey)) throw new Error('body differs');
			return 'matched';
		});
	}
	await rung('5 · the three refusals render pairwise distinct headings and bodies', async () => {
		const headings = new Set(seen.map((s) => s.heading));
		const bodies = new Set(seen.map((s) => s.body));
		if (seen.length !== 3 || headings.size !== 3 || bodies.size !== 3) throw new Error(`distinct headings ${headings.size}, bodies ${bodies.size}`);
		return 'distinct';
	});
}

async function main() {
	await loadPeerModules();
	log('start', `compose-gate phase=${PHASE} officer=${OFFICER_NONE ? 'none' : 'real'}`);
	if (PHASE === 'compose-seed') await runComposeSeed();
	else if (PHASE === 'compose-verify') await runComposeVerify();
	else if (PHASE === 'compose-swap') await runComposeSwap();
	else if (PHASE === 'compose-preview-race') await runComposePreviewRace();
	else if (PHASE === 'compose-guards') await runComposeGuards();
	else if (PHASE === 'compose-refusal') await runComposeRefusal();
	else throw new Error(`compose-gate: unknown phase "${PHASE}"`);
	publish();
}

main().catch((err) => {
	win.__COMPOSE_GATE__ = { phase: PHASE, crashed: String((err as { name?: unknown })?.name ?? 'Error'), log: LOG };
	win.__COMPOSE_GATE_DONE__ = true;
});
