/**
 * election-shell-gate.tsx — the built harness entry 53-09's gates run
 * against (53-07 builds this page; 53-09 owns the runner invocation, the
 * identity and token rungs, and `test:browser`'s wiring — see this app's
 * package.json and 53-07-PLAN.md's Interface Contract for the split).
 *
 * WHAT A GREEN RUN HERE IS NOT EVIDENCE OF — read this before quoting it:
 * this page mounts `ElectionShell` with a FIXTURE election it was handed
 * directly as a prop. It says nothing about a real data path (there is
 * none in this phase), and it carries no pass/fail verdict of its own —
 * grading what it renders is 53-09's runner's job, not this page's. A
 * harness that graded itself would be a rung nobody else could invert.
 *
 * `?phase=pre|voting|settling|closed` selects which of
 * `FIXTURE_INSTANTS`' four canonical instants this page renders against,
 * defaulting to `voting`. This is THIS PAGE's own URL parameter, read by
 * this file only — it is never forwarded into `ElectionShell`'s own
 * address, which is why `search` is passed explicitly below rather than
 * left to default to `window.location.search` (T-53-07-04's harness-side
 * proof: the shell's address input is genuinely injectable, not just
 * theoretically so).
 *
 * Deliberately calls no engine preflight step and assigns no production
 * readout global of any kind — that global belongs to `main.tsx` (53-06),
 * and forging it here would make the D-17 token list ambiguous about what
 * counts as a harness artefact.
 *
 * 53-09 EXTENSION — the shared runner's second invocation. Adds:
 * (a) imperative `data-ui-gate="<ExportName>"` tagging of the elements
 *     `ElectionShell` already genuinely rendered (`AdvisoryDisclosure`,
 *     `LifecyclePill`, `DetailsToggle`) — `AdvisoryDisclosure`/`LifecyclePill`
 *     render only a text node with no child element, so each is WRAPPED in a
 *     harness-only container element (never restructuring `ElectionShell`'s
 *     own tree, which this file never imports for editing) so the runner's
 *     `shared-components-mounted` rung's `childElementCount > 0` check has a
 *     genuine child to see; `DetailsToggle`'s own `.dt-toggle-group` wrapper
 *     already contains its button as a child element and is tagged directly.
 * (b) a SEPARATE `[data-ui-gate="hook-root"]` region, mounted in its OWN
 *     React root (a container `appendChild`-ed to `document.body`, never
 *     nested under `#root`) so a hook-dispatcher render throw there cannot
 *     unmount or blank the `ElectionShell` region — the structural half of
 *     the measured 19/19 → 8/12 PARTIAL failure signature (the runner-side
 *     half is `run-ui-gates.mjs`'s per-rung `try`/`catch`). Mounts
 *     `DetailsToggle` a SECOND time, independent of the instance
 *     `ElectionShell` renders internally, exactly mirroring
 *     `apps/VoteTorrentDashboard/test/browser/ui-gate.tsx`'s own hook-root.
 * (c) `window.__UI_GATE__` — the ONE channel the shared runner reads
 *     (`mounted`, `error`, `identity`), nesting 53-07's own
 *     `window.__ELECTION_SHELL_GATE__` readout unchanged under `.election`.
 *     There is one readout the runner reads; the other is 53-07's own DOM
 *     read-back record, which grades nothing — both stay assigned, neither
 *     replaces the other.
 *
 * 54-16 EXTENSION — the `?fixture=public-surface` branch. ADDITIVE: with the
 * parameter ABSENT every behaviour above is byte-identical — the default path
 * still mounts with the prop-supplied fixture election, the hook root still
 * mounts in its own React root, `__UI_GATE__` still publishes the same fields,
 * and no existing rung sees a different page. With the parameter PRESENT this
 * page instead seeds a REAL browser-side database (delete → create → seed →
 * record the row counts → record the network) and mounts the shell with NO
 * `election` prop at all, so `shouldReadFor` returns true and the shell takes
 * its genuine read path. That is the whole point: every rung in
 * `render-fidelity-gate.mjs` measures rendered output produced from rows, not
 * from a prop.
 *
 * TWO THINGS THIS BRANCH MUST DO THAT ARE EASY TO MISS. The shell's read path
 * is `findNetwork` → `attachNetworkDb`, and `attachNetworkDb` reads a
 * persisted row-count record before it will hand back a handle. A branch that
 * recorded only the network would attach-fail with the missing-counts error,
 * the shell would render its addressed-but-not-held sentence, and every rung
 * below would report a defect that is really a missing precondition. And the
 * seeding handle is CLOSED before the shell mounts: the shell opens its own,
 * and this page must not hold a second connection against it.
 *
 * THIS PAGE STILL CARRIES NO VERDICT OF ITS OWN. `__UI_GATE__.fixture` is a
 * publication of the FIXTURE's own exported values — never a measurement of
 * the page — so the gate script compares the DOM against the fixture rather
 * than against numbers it restated. Grading remains the runner's job.
 *
 * 56-03 EXTENSION — the `?fixture=not-held` branch. Strictly ADDITIVE, same
 * rule as the 54-16 extension above: with the parameter ABSENT or set to
 * `public-surface`, every existing behaviour is byte-identical — no existing
 * rung sees a changed page or a changed `fixture` readout. With the
 * parameter set to `not-held` this page seeds the SAME public surface
 * `seedFixtureSurface()` already seeds (load-bearing: `attachNetworkDb`
 * refuses a handle with no persisted row-count record, so an unseeded branch
 * would render the not-held sentence for the WRONG reason — an attach FAULT
 * masquerading as the finding under test), then mounts the shell with an
 * election id this surface never seeded (`UNHELD_ELECTION_ID`, production
 * length) instead of the seeded one. Neither existing ready predicate works
 * here: `fixtureReady` waits on `.registrant-roll`, which never renders on
 * this branch, and a "three skeletons present" predicate would also resolve
 * during the `reading` state, which renders all three frames too — so this
 * branch waits on an element whose text equals
 * `COPY['public.election.notHeld.title']` instead. Publishes a THIRD,
 * separate readout channel, `__UI_GATE__.notHeld` — null on every other
 * branch — carrying only values this file already has from its own imports
 * (the requested id, the seeded id, and the slot suffixes derived from
 * COPY's `public.election.slot.*` keys), never anything measured from the
 * page. Grading remains the gate script's job, same as the `fixture`
 * channel.
 */
import { StrictMode } from 'react';
import * as AppReact from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/app.css';
import { ElectionShell } from '../../src/screens/ElectionShell';
import { COPY } from '@votetorrent/ui-web';
import { DetailsToggle, packageReactIdentity } from '@votetorrent/ui-web/components';
import { FIXTURE_ELECTION, FIXTURE_ELECTION_ID, FIXTURE_INSTANTS } from '../fixtures/election-fixture.js';
import {
	createNetworkDb,
	closeNetworkDb,
	deleteNetworkDb,
	writeRowCounts,
	upsertNetwork,
} from '@votetorrent/web-data/public';
import { ELECTION_ADDRESS_PARAM, NETWORK_ADDRESS_PARAM } from '../../src/election-address.js';
import {
	FIXTURE_ELECTION_DB_ID,
	FIXTURE_NETWORK_HASH,
	FIXTURE_SETTLING_INSTANT,
	PUBLIC_SURFACE_EXPECTED_COUNTS,
	SEED_NOW,
	UNHELD_ELECTION_ID,
	seedPublicSurface,
} from '../fixtures/seed-public-surface.js';
import { EXTRA_FIELDS_MARKER, ROLL_REGISTRANTS, ROLL_SUPERSEDED } from '../fixtures/registrant-roll-fixture.js';
import { EXPECTED_KEYHOLDERS, EXPECTED_RELEASED, EXPECTED_TOTAL } from '../fixtures/keyrelease-fixture.js';

// D-33 made the address TWO parameters, so a one-parameter `search` here now
// resolves to 'incomplete' and would make the shell render the index instead
// of the fixture election -- silently changing what every 53-09 rung measures.
// This harness opens NO database in this phase, so the value below is an
// address-SHAPED constant rather than a fixture network: nothing is ever
// attached with it. It lives here rather than in
// `test/fixtures/election-fixture.js` because that file is another plan's
// territory.
const GATE_NETWORK_HASH = 'vtx-fixture-network-0001' as const;

declare global {
	interface Window {
		__ELECTION_SHELL_GATE__?: Readonly<{
			harness: string;
			phase: string;
			lifecycleText: string | null;
			addressText: string | null;
			advisoryText: string | null;
			toggleExpanded: boolean | null;
			skeletonSlots: string[];
		}>;
	}
}

const win = window as unknown as Record<string, unknown>;

/**
 * React 19's client-internals holder property name — see
 * `packages/ui-web/src/react-identity.js`'s own header for why comparing
 * this (not the version string, not a namespace-object identity) is the
 * sound measure.
 */
const CLIENT_INTERNALS_KEY = '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE';

/**
 * `sameUseState`/`sameInternals` are the two SOUND measures; the version
 * string and the namespace-object equality are DECOYS, computed and
 * published only so the runner's run log can show them true even when
 * identity reads false — see `react-identity.js`'s own header for the
 * measured reasons neither may ever gate a verdict.
 */
function computeReactIdentity() {
	const pkg = packageReactIdentity();
	let appInternals: unknown = null;
	try {
		appInternals = (AppReact as unknown as Record<string, unknown>)[CLIENT_INTERNALS_KEY] ?? null;
	} catch {
		appInternals = null;
	}
	return {
		sameUseState: AppReact.useState === pkg.useState,
		sameInternals: appInternals != null && pkg.internals != null && appInternals === pkg.internals,
		versionsMatch: AppReact.version === pkg.version,
		sameNamespace: (AppReact as unknown) === pkg.reactNamespace,
	};
}

/**
 * The hook-root region (53-09, D-19) — mounted in ITS OWN root, separate
 * from `ElectionShell`'s (see this file's header). Renders `DetailsToggle`
 * a second time: its single `.dt-toggle` button is the "exactly one button"
 * the identity rung clicks, and its body — rendered only while open — is
 * what makes that click change `[data-ui-gate="hook-root"]`'s own
 * `textContent`.
 */
function HookRootHarness() {
	return (
		<div data-ui-gate="hook-root">
			<DetailsToggle summary={<span>hook-root toggle</span>}>
				<p>hook-root body content for the D-19 identity gate&apos;s click assertion.</p>
			</DetailsToggle>
		</div>
	);
}

/**
 * Wraps `el` in a new harness-only container element carrying
 * `data-ui-gate="{gateName}"`, WITHOUT restructuring `ElectionShell`'s own
 * tree (`el` itself is never removed or re-parented outside its original
 * parent, only newly enclosed) — for the two shared components whose own
 * rendered root is a childless text-only element
 * (`AdvisoryDisclosure`'s `<p>`, `LifecyclePill`'s `<span>`), so the
 * runner's `shared-components-mounted` rung's `childElementCount > 0` check
 * has a genuine child element to see.
 */
function wrapForGate(el: Element, gateName: string): void {
	const wrapper = document.createElement('span');
	wrapper.setAttribute('data-ui-gate', gateName);
	el.parentNode?.insertBefore(wrapper, el);
	wrapper.appendChild(el);
}

type FixturePhase = keyof typeof FIXTURE_INSTANTS;

function resolvePhase(): FixturePhase {
	const params = new URLSearchParams(window.location.search);
	const requested = params.get('phase');
	if (requested === 'pre' || requested === 'voting' || requested === 'settling' || requested === 'closed') {
		return requested;
	}
	return 'voting';
}

const phase = resolvePhase();

/**
 * This page's OWN second URL parameter (54-16), read by this file only and
 * never forwarded into `ElectionShell`'s address — the same rule `?phase=`
 * above already follows. Its one recognised value selects the seeded
 * public-surface branch; anything else, including absence, leaves this page
 * exactly as 53-07/53-09 built it.
 */
const FIXTURE_PARAM = 'fixture';
const PUBLIC_SURFACE_FIXTURE = 'public-surface';
/** 56-03's third recognised value for this same parameter. @type {string} */
const NOT_HELD_FIXTURE = 'not-held';

function resolveFixtureParam(): string | null {
	return new URLSearchParams(window.location.search).get(FIXTURE_PARAM);
}

const fixtureParamValue = resolveFixtureParam();
const fixtureMode = fixtureParamValue === PUBLIC_SURFACE_FIXTURE;
/** 56-03: the not-held branch, mutually exclusive with `fixtureMode`. */
const notHeldMode = fixtureParamValue === NOT_HELD_FIXTURE;

/**
 * The seeded expectations, published so the gate script COMPARES against the
 * fixture's own exported values rather than restating them. Every field here
 * is read straight off a fixture export; nothing is measured from the page,
 * and nothing is a literal this file invented.
 *
 * `districts` and `lastNames` are published as whole arrays rather than as a
 * pre-computed longest/shortest, so the gate derives the decisive
 * production-length value itself and a fixture edit cannot silently move the
 * value the gate compares against.
 */
const XSS_ROW = ROLL_REGISTRANTS.find((entry) => entry.lastName.includes('<script'));

const fixtureFacts = Object.freeze({
	released: EXPECTED_RELEASED,
	total: EXPECTED_TOTAL,
	keyholders: EXPECTED_KEYHOLDERS,
	supersededLastName: ROLL_SUPERSEDED.lastName,
	supersededDistrict: ROLL_SUPERSEDED.district,
	extraFieldsMarker: EXTRA_FIELDS_MARKER,
	districts: Object.freeze(ROLL_REGISTRANTS.map((entry) => entry.district)),
	lastNames: Object.freeze(ROLL_REGISTRANTS.map((entry) => entry.lastName)),
	xssLastName: XSS_ROW ? XSS_ROW.lastName : null,
	rollRowCount: ROLL_REGISTRANTS.length,
});

/**
 * The address this branch mounts the shell with, built from
 * `election-address.js`'s OWN exported parameter names rather than from a
 * query string this file hard-codes — a renamed parameter then breaks the
 * import instead of silently resolving to the index page.
 */
const FIXTURE_SEARCH = `?${NETWORK_ADDRESS_PARAM}=${FIXTURE_NETWORK_HASH}&${ELECTION_ADDRESS_PARAM}=${FIXTURE_ELECTION_DB_ID}`;

/**
 * Seed a real browser-side database and record the two preconditions the
 * shell's read path checks BEFORE it opens anything: the networks-registry
 * entry (the security gate that authorises a store name at all) and the
 * persisted row-count record (`attachNetworkDb`'s re-attach contract).
 *
 * Both are written through the data package's own exported helpers — never by
 * writing a storage key directly — so a change to either key or record shape
 * moves this branch with it instead of leaving it asserting against a stale
 * literal.
 *
 * The handle is closed at the end: the shell opens its own, and holding a
 * second connection here would serve no purpose and would block any later
 * delete.
 */
async function seedFixtureSurface(): Promise<void> {
	try {
		await deleteNetworkDb(FIXTURE_NETWORK_HASH);
	} catch {
		// A database that was never created is the normal first-run case.
	}
	const db = await createNetworkDb(FIXTURE_NETWORK_HASH);
	try {
		await seedPublicSurface(db);
		await writeRowCounts(FIXTURE_NETWORK_HASH, PUBLIC_SURFACE_EXPECTED_COUNTS);
		upsertNetwork({
			networkHash: FIXTURE_NETWORK_HASH,
			authorityName: 'vtx-fixture Authority',
			domain: 'vtx-fixture.invalid',
			officerUserId: 'u1',
			bootstrappedAt: SEED_NOW,
		});
	} finally {
		await closeNetworkDb(db);
	}
}

/**
 * The address the not-held branch mounts the shell with (56-03): the SAME
 * network hash `seedFixtureSurface()` seeds, paired with an election id that
 * surface never seeds. Built from `election-address.js`'s own exported
 * parameter names, on the same precedent `FIXTURE_SEARCH` above follows.
 */
const NOT_HELD_SEARCH = `?${NETWORK_ADDRESS_PARAM}=${FIXTURE_NETWORK_HASH}&${ELECTION_ADDRESS_PARAM}=${UNHELD_ELECTION_ID}`;

/** The copy-key prefix that declares a placeholder slot — the same prefix
 * `scripts/assert-placeholders-labelled.mjs` derives its own expected labels
 * from. @type {string} */
const SLOT_KEY_PREFIX = 'public.election.slot.';

/**
 * The not-held branch's own readout, published on `__UI_GATE__.notHeld`
 * (null on every other branch). Every field is read straight off an import
 * this file already has — the requested id, the seeded id, and the ordered
 * slot suffixes derived from COPY's `public.election.slot.*` keys — never a
 * literal this file invented and never anything measured from the page.
 */
const notHeldFacts = Object.freeze({
	requestedElectionId: UNHELD_ELECTION_ID,
	seededElectionId: FIXTURE_ELECTION_DB_ID,
	slotSuffixes: Object.freeze(
		Object.keys(COPY)
			.filter((key) => key.startsWith(SLOT_KEY_PREFIX))
			.map((key) => key.slice(SLOT_KEY_PREFIX.length)),
	),
});

const rootElement = document.getElementById('root');
if (!rootElement) {
	throw new Error('election-shell-gate.tsx: #root element not found in election-shell-gate.html');
}

/**
 * The same element, re-bound with a non-nullable declared type. The guard
 * above narrows `rootElement` for the top-level statements that follow it, but
 * not inside the async fixture mount below — a closure body is checked without
 * that narrowing. Re-binding once here is the narrowing, rather than a
 * non-null assertion at the use site.
 */
const shellContainer: HTMLElement = rootElement;

/**
 * Wrapped so a render throw here cannot prevent `window.__UI_GATE__` from
 * publishing below (53-09) — `identity:hook-mounted` and
 * `shared-components-mounted` then read the DOM directly and report the
 * affected region ABSENT rather than the process crashing before any rung
 * ran (this file's header, point (b), and `run-ui-gates.mjs`'s own header
 * "THE PARTIAL FAILURE SIGNATURE" note).
 */
let renderError: string | null = null;
// 54-16: the DEFAULT path, unchanged. It is now guarded because the fixture
// branch mounts a DIFFERENT shell into this same `#root` after an await, and
// two `createRoot` calls on one container is a React error. With the
// parameter absent this is the same synchronous mount 53-07/53-09 built.
// 56-03 widens the guard to also exclude `notHeldMode`, on the identical
// reasoning: that branch mounts its own DIFFERENT shell into `#root` after
// an await too.
if (!fixtureMode && !notHeldMode) {
	try {
		createRoot(rootElement).render(
			<StrictMode>
				<ElectionShell
					search={`?network=${GATE_NETWORK_HASH}&election=${FIXTURE_ELECTION_ID}`}
					at={FIXTURE_INSTANTS[phase]}
					election={FIXTURE_ELECTION}
				/>
			</StrictMode>,
		);
	} catch (err) {
		renderError = String((err as { message?: unknown })?.message ?? err);
	}
}

/**
 * The fixture branch's mount: NO `election` prop, so `shouldReadFor` returns
 * true and the shell reads for real; the settling instant, so the page is in
 * the one phase where a gap card and a filled card render in the SAME
 * section.
 *
 * A seed failure is recorded into `renderError` rather than thrown, so
 * `__UI_GATE__` still publishes and the gate script reports a named failure
 * instead of timing out on a page that never finished.
 */
async function mountFixtureSurface(): Promise<void> {
	try {
		await seedFixtureSurface();
	} catch (err) {
		renderError = renderError ?? `fixture seed failed: ${String((err as { message?: unknown })?.message ?? err)}`;
		return;
	}
	try {
		createRoot(shellContainer).render(
			<StrictMode>
				<ElectionShell search={FIXTURE_SEARCH} at={FIXTURE_SETTLING_INSTANT} />
			</StrictMode>,
		);
	} catch (err) {
		renderError = renderError ?? String((err as { message?: unknown })?.message ?? err);
	}
}

/**
 * The not-held branch's mount (56-03): seeds the SAME public surface the
 * fixture branch seeds — load-bearing, see this file's header — then mounts
 * `ElectionShell` with `NOT_HELD_SEARCH` and no `election` prop, so the read
 * path resolves the network, fails to find the requested election, and the
 * shell renders its addressed-but-not-held branch for real.
 *
 * A seed failure is recorded into `renderError` rather than thrown, on the
 * identical precedent `mountFixtureSurface` above follows.
 */
async function mountNotHeldSurface(): Promise<void> {
	try {
		await seedFixtureSurface();
	} catch (err) {
		renderError = renderError ?? `not-held seed failed: ${String((err as { message?: unknown })?.message ?? err)}`;
		return;
	}
	try {
		createRoot(shellContainer).render(
			<StrictMode>
				<ElectionShell search={NOT_HELD_SEARCH} at={FIXTURE_SETTLING_INSTANT} />
			</StrictMode>,
		);
	} catch (err) {
		renderError = renderError ?? String((err as { message?: unknown })?.message ?? err);
	}
}

// The hook-root region's own SEPARATE root and container — appended to
// document.body, never nested under #root, so a render throw here cannot
// unmount or blank the ElectionShell region above (this file's header,
// point (b)). A throw here is deliberately swallowed into `renderError`
// rather than re-thrown.
const hookRootContainer = document.createElement('div');
document.body.appendChild(hookRootContainer);
try {
	createRoot(hookRootContainer).render(
		<StrictMode>
			<HookRootHarness />
		</StrictMode>,
	);
} catch (err) {
	renderError = renderError ?? String((err as { message?: unknown })?.message ?? err);
}

/**
 * Bounded `requestAnimationFrame` poll — NEVER a fixed sleep — that resolves
 * once a `.dt-toggle` button exists **inside `#root`** (proof the shell has
 * committed its first render), or once `maxFrames` have elapsed. Scoped to
 * `#root` (53-09) rather than the bare `.dt-toggle` class 53-07 used, since
 * the hook-root region above (mounted outside `#root`) now also renders a
 * `.dt-toggle` button — an unscoped selector could resolve on the hook-root
 * instance before `ElectionShell` itself ever committed.
 */
function settleUntilMounted(maxFrames: number, ready: () => boolean = defaultReady): Promise<void> {
	return new Promise((resolve) => {
		let frames = 0;
		function tick() {
			frames += 1;
			if (ready() || frames >= maxFrames) {
				resolve();
				return;
			}
			requestAnimationFrame(tick);
		}
		requestAnimationFrame(tick);
	});
}

/** The default predicate — the exact condition 53-09's scoped selector expressed. */
function defaultReady(): boolean {
	return document.querySelector('#root .dt-toggle') !== null;
}

/**
 * The fixture branch's predicate (54-16). The shell commits its first render
 * long before the read resolves, so the default predicate alone would let the
 * poll finish against an empty page and every roll rung would report a defect
 * that is really a race. Waiting for the roll's own wrapper is what makes the
 * measured page the one the data produced. The frame budget is larger for the
 * same reason: this branch waits on a real IndexedDB attach and four reads.
 */
function fixtureReady(): boolean {
	return defaultReady() && document.querySelector('#root .registrant-roll') !== null;
}

/**
 * The not-held branch's own predicate (56-03). Neither existing predicate
 * works here: `fixtureReady` waits on `.registrant-roll`, which never
 * renders on this branch, and a "three skeletons present" predicate would
 * also resolve during the `reading` state, which renders all three frames
 * too — that race is the single most likely way this branch would report a
 * false green. Waits instead on an element inside `#root` whose text content
 * equals `COPY['public.election.notHeld.title']`, read from the shared copy
 * table rather than transcribed. The frame budget is the same enlarged one
 * `fixtureReady` uses: this branch also waits on a real IndexedDB attach.
 */
const NOT_HELD_TITLE_TEXT = COPY['public.election.notHeld.title'];

function notHeldReady(): boolean {
	if (!defaultReady()) return false;
	const candidates = document.querySelectorAll('#root h2, #root p');
	for (const el of candidates) {
		if (el.textContent === NOT_HELD_TITLE_TEXT) return true;
	}
	return false;
}

const mountReady = fixtureMode ? mountFixtureSurface() : notHeldMode ? mountNotHeldSurface() : Promise.resolve();

mountReady
	.then(() => {
		if (fixtureMode) return settleUntilMounted(900, fixtureReady);
		if (notHeldMode) return settleUntilMounted(900, notHeldReady);
		return settleUntilMounted(120);
	})
	.then(() => {
	// 53-09: imperative data-ui-gate tagging of ElectionShell's own rendered
	// output — see wrapForGate's own header for why AdvisoryDisclosure and
	// LifecyclePill need a wrapper while DetailsToggle's own wrapper is
	// tagged directly. Scoped to #root so the hook-root region's own,
	// independent DetailsToggle instance is never mistaken for this one.
	const advisoryTarget = document.querySelector('#root .pv-disclosure');
	if (advisoryTarget) wrapForGate(advisoryTarget, 'AdvisoryDisclosure');
	const lifecycleTarget = document.querySelector('#root .lifecycle-pill');
	if (lifecycleTarget) wrapForGate(lifecycleTarget, 'LifecyclePill');
	const detailsGroup = document.querySelector('#root .dt-toggle-group');
	detailsGroup?.setAttribute('data-ui-gate', 'DetailsToggle');

	const lifecycleEl = document.querySelector('.lifecycle-pill');
	const addressEl = document.querySelector('.election-address code');
	const advisoryEl = document.querySelector('.pv-disclosure');
	const skeletonSlots = [...document.querySelectorAll('.skeleton')].map(
		(el) => el.getAttribute('data-slot') ?? '',
	);

	// `toggleExpanded` is defined as a GETTER, not a snapshot value — 53-09's
	// identity rung clicks the real `.dt-toggle` button and needs this field
	// to re-read the DOM's live `aria-expanded` attribute on every access, not
	// the value at the moment this object was published. `Object.freeze`
	// below still applies (it prevents reconfiguring or replacing this
	// property, not the getter function itself from running fresh each time
	// it is read) — freezing an accessor property does not freeze what its
	// getter returns.
	const readout = Object.defineProperty(
		{
			harness: 'election-shell-gate',
			phase,
			lifecycleText: lifecycleEl ? lifecycleEl.textContent : null,
			addressText: addressEl ? addressEl.textContent : null,
			advisoryText: advisoryEl ? advisoryEl.textContent : null,
			skeletonSlots,
		},
		'toggleExpanded',
		{
			enumerable: true,
			get(): boolean | null {
				// Scoped to #root (53-09) — see settleUntilMounted's own comment
				// above: the hook-root region also renders a `.dt-toggle` button,
				// and this getter must read ElectionShell's own, not either one
				// document order happens to put first.
				const el = document.querySelector('#root .dt-toggle');
				return el ? el.getAttribute('aria-expanded') === 'true' : null;
			},
		},
	);

	window.__ELECTION_SHELL_GATE__ = Object.freeze(readout) as Window['__ELECTION_SHELL_GATE__'];

	// 53-09: the ONE channel the shared runner (run-ui-gates.mjs) reads.
	// `mounted` is built from the `[data-ui-gate]` attribute values ACTUALLY
	// FOUND IN THE DOCUMENT (never a static list), exactly mirroring
	// apps/VoteTorrentDashboard/test/browser/ui-gate.tsx's own convention —
	// a component that threw during render, or a wrapForGate call that never
	// ran because its target was absent, is reported ABSENT rather than
	// asserted present.
	const mounted = [...document.querySelectorAll('[data-ui-gate]')]
		.map((el) => el.getAttribute('data-ui-gate'))
		.filter((name): name is string => name != null);

	win.__UI_GATE__ = Object.freeze({
		mounted,
		error: renderError,
		identity: computeReactIdentity(),
		election: window.__ELECTION_SHELL_GATE__,
		// 54-16, ADDITIVE and null on the default path so no existing rung
		// sees a changed readout. On the fixture branch it carries the
		// FIXTURE's own exported values and nothing measured from the page.
		fixture: fixtureMode ? fixtureFacts : null,
		// 56-03, ADDITIVE on the identical precedent: null on every other
		// branch so no existing rung sees a changed readout. On the not-held
		// branch it carries this file's own exported facts, never anything
		// measured from the page.
		notHeld: notHeldMode ? notHeldFacts : null,
	});
	win.__UI_GATE_DONE__ = true;
	});
