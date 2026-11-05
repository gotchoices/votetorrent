import type { ReactNode } from 'react';
import { t } from '@votetorrent/ui-web';
import { AdvisoryDisclosure, DetailsToggle, LifecyclePill } from '@votetorrent/ui-web/components';
import { derivePhase, resolveComparisonInstant, formatInstant } from '@votetorrent/ui-web/lifecycle';
import { headline, toneCopyKey } from '@votetorrent/ui-web/facts';
import { AppChrome } from './AppChrome';
import { ElectionIndex } from './ElectionIndex';
import { FactSections } from './FactSections';
import { usePublicElection } from './use-public-election';
import { parseElectionAddress } from '../election-address.js';
import { formatReaderInstant } from '../reader-instant.js';

/**
 * ElectionShell.tsx — the public election view (53-07 built the empty shell,
 * D-12/D-14/D-16/D-18; 54-12 made it read for real, D-01/D-02/D-10/D-17/D-26).
 *
 * `timeline` is `unknown` on purpose: `ElectionRevision.Timeline`
 * (votetorrent.qsql:840,:891) carries a standing `-- TODO: constrain
 * Timeline` and zero CHECK constraints, so it is unvalidated JSON that only
 * `derivePhase` (packages/ui-web/src/lifecycle/election-phase.js)
 * is permitted to interpret. Nothing in this file inspects it directly.
 */
export interface PublicElectionFacts {
	title: string | null;
	timeline: unknown;
}

export interface ElectionShellProps {
	/** Defaults to `window.location.search`. Injectable so the harness's own
	 * `?phase=` never becomes this shell's address (T-53-07-04's consumer-side
	 * half: the harness proves the address input is injectable rather than
	 * this component reaching for `window` unconditionally). */
	search?: string;
	/** A canonical 19-character instant, or `null` to let
	 * `resolveComparisonInstant` fall back to the real clock. NEVER read from
	 * the URL — see election-address.js's header, point 4, and T-53-07-04:
	 * a URL-controlled instant would let a link author choose which
	 * lifecycle phase any visitor is shown. */
	at?: string | null;
	/** The D-17 seam. Production renders `<ElectionShell />` with no
	 * `election` prop at all, so no election fact exists anywhere in the
	 * production import graph — there is no default fixture and no fallback
	 * demo timeline here. Only `test/browser/election-shell-gate.tsx`
	 * supplies one, from `test/fixtures/election-fixture.js`. When it IS
	 * supplied, `usePublicElection` performs no read and opens no database —
	 * a seam that read anyway would make every existing browser gate a liar. */
	election?: PublicElectionFacts | null;
	/** The 56-12/D-17 harness seam over `usePublicElection`'s own read
	 * dependencies — typed from the hook's own args type rather than a fresh
	 * interface, so this file gains no new import for it. Defaults to
	 * `undefined`, which lets `usePublicElection` fall back to its own real
	 * default. Production renders `<ElectionShell />` with no `source` prop
	 * at all; only a harness supplies one, and it must hoist that object to a
	 * MODULE CONSTANT — `source` is one of the hook's effect dependencies, so
	 * a per-render object here would re-run the read on every commit. */
	source?: Parameters<typeof usePublicElection>[0]['source'];
	/** The 56-12/D-13 fault seam. Supplied by `PublicApp.tsx` in production
	 * and by nothing else — that default (`null`) is what keeps every
	 * harness page that mounts `ElectionShell` directly byte-identical, since
	 * none of them pass this prop. `null` means the deployment's bootstrap
	 * config resolved (or `PublicApp` has not composed this shell at all);
	 * `'missing'`/`'malformed'` are the two `CONFIG_FAULT` values `56-06`'s
	 * loader can report. See `PublicApp.tsx`'s `FAULT_COPY_KEYS` for the
	 * closed set of copy keys the two values resolve to. */
	configFault?: 'missing' | 'malformed' | null;
	/** The 56-14 peer-feed seam over `usePublicElection`'s own read
	 * dependencies -- typed from the hook's own args type, same idiom as
	 * `source` above, so this file gains no new import for it. Defaults to
	 * `undefined`, which lets `usePublicElection` fall back to its own
	 * `'unobserved'` default. Production supplies it from `PublicApp.tsx`;
	 * only a harness supplies one otherwise, and every harness that omits it
	 * sees a byte-identical page -- which is what keeps the existing browser
	 * gates green. */
	peerFeed?: Parameters<typeof usePublicElection>[0]['peerFeed'];
}

/**
 * The public election view: chrome words, genuine mounts of the three shared
 * components, and THREE STRUCTURALLY DISTINCT STATES rendered as different
 * children of one `<section className="election">` (D-02) —
 *
 *   reading  — 53-D18's inert, labelled skeleton slots, kept verbatim. D-02
 *              AMENDS 53-D18, it does not reverse it. NO status banner here:
 *              a banner saying "phase unknown" while the read is still in
 *              flight would make D-10's real state indistinguishable from a
 *              slow attach, which is the exact confusion D-02 removes.
 *   notHeld  — an explicit sentence saying this browser holds no usable copy
 *              of the election this link names, PLUS the same three labelled
 *              frames the election-less page shows (D-21): `.skeleton`'s
 *              established meaning was already "space left empty ON PURPOSE,
 *              nothing is loading" — "no record for this election" is a
 *              second cause of that same emptiness, not a repurposing of the
 *              class. Still NO banner: we did not fail to read a schedule,
 *              we hold no election, and claiming `bad` / "phase unknown"
 *              here would be a false sentence of the kind D-28 exists to
 *              catch. The banner distinction is unchanged; only the
 *              scaffolding parity is new.
 *   ready    — the real title and the real derived phase, led by the
 *              `.status-banner` headline and its tone chip. `unreadable`
 *              renders the same shape with a null election, so a fault
 *              surfaces as D-10's explicit unknown rather than as silence.
 *
 * WHAT 54-12 DELETED, and why the diff alone will not explain it. 54-05
 * installed a HOLDING MEASURE at the lifecycle skeleton's guard: it widened
 * that conditional from `phase === null` to also cover the indeterminate
 * phase, so the grey bar kept rendering across the four-phase vocabulary
 * change, and its own comment named this plan as the owner of the
 * replacement. That guard is now narrowed to the READ STATE and names no
 * phase at all. An unreadable schedule is answered in words by the banner
 * (tone `bad`, "this election's schedule can't be read, so its phase is
 * unknown") plus `LifecyclePill`'s own pill for that phase — D-10. The
 * divergence from `LifecyclePill`'s former render-nothing behaviour is
 * warranted by `ElectionRevision.Timeline` carrying zero CHECK constraints
 * (votetorrent.qsql:891, `-- TODO constrain Timeline`), so a broken schedule
 * is an EXPECTED input rather than an anomaly, and silence about an expected
 * input is indistinguishable from a deliberate withholding.
 *
 * The one distinction that is easy to lose when editing the branches below:
 * an address that names NO election is not a browser that fails to hold one.
 * That page keeps 54-11's index and all three of 53-D18's labelled slots
 * verbatim; only an ADDRESSED election can be `notHeld`.
 *
 * Exactly ONE `return` statement, deliberately — not style. `AdvisoryDisclosure`'s
 * own header states that the moment it can be conditioned on anything it can
 * be hidden, and `DetailsToggle`'s live hook is what makes the D-19 identity
 * gate and the D-20 dedupe control observable at all. A single return makes
 * both structurally unbranchable: neither can ever sit inside a conditional
 * branch this function takes. Every effect, every `await` and every cleanup
 * closure therefore lives in `use-public-election.ts`, whose own header
 * records the same constraint from the other side.
 */
export function ElectionShell({ search, at = null, election = null, source, configFault = null, peerFeed }: ElectionShellProps) {
	const address = parseElectionAddress(search ?? window.location.search);

	// Called UNCONDITIONALLY, above the address branch, for the same reason
	// the advisory is a sibling and not a child: a hook inside a branch is a
	// hook that can be skipped. 56-12/D-13: the ADDRESS ARGUMENT is gated on
	// the fault (null address when a fault is present -- a deployment that
	// cannot learn where to dial should not attempt a lookup), but the hook
	// call itself is never wrapped, moved or conditionalised.
	const read = usePublicElection({ address: configFault === null ? address : null, election, source, peerFeed });

	// 56-12/D-17. Computed ONCE, above the branch predicates: `null` whenever
	// `read.observedAt` is absent or unusable, in which case `showStaleness`
	// below must be false — `t()` throws on an unresolved `{{asOf}}`, and a
	// thrown formatter would blank the page.
	const formattedInstant = formatReaderInstant(read.observedAt);

	// `at` is the injected, TEST-ONLY seam (D-24). It is never parsed from the
	// URL and never defaulted from anything but the real clock.
	const atCanonical = resolveComparisonInstant(at ?? undefined);

	// `election ?? {}`, never `?? null` — 54-05's measured finding:
	// parseTimeline(timeline, election = {}) fires its default only for
	// `undefined` and then reads `election.ballotDeadline` unguarded, so a
	// `null` throws a TypeError and white-screens the shipped root URL. The
	// rule applies to the RESOLVED election too, not only to the prop.
	const shellElection = read.election;
	const crossCheck = (shellElection ?? {}) as unknown as Parameters<typeof derivePhase>[0];
	const phaseResult = derivePhase(crossCheck, shellElection?.timeline, atCanonical);

	// D-26's COMPARISON half, at this call site. `phaseResult.at.registrationEnds`
	// is epoch-ms; the null guard comes FIRST because `formatInstant` returns
	// the literal '(none)' for null, and feeding that to `headline` would
	// silently downgrade a real `pre` phase to the registrationUnknown
	// sentence. Both values below are UTC-canonical 19-character strings, so
	// `headline`'s boundary test is a lexicographic string compare that cannot
	// shift with the reader's timezone — the non-obvious half of D-26, and the
	// reason the DISPLAY formatter (`reader-instant.js`) is a different
	// function on purpose.
	const registrationEndsMs = phaseResult.at?.registrationEnds ?? null;
	const registrationEndsCanonical = registrationEndsMs === null ? null : formatInstant(registrationEndsMs).slice(0, 19);
	const { text: headlineText, tone } = headline(phaseResult.phase, { registrationEndsCanonical, atCanonical }, t);
	const toneKey = toneCopyKey(tone);

	// The three branch predicates, named once so each JSX guard below reads as
	// one fact rather than as a re-derived condition.
	//
	// `addressed` is the load-bearing distinction and it is easy to lose: a
	// link that names no election at all is NOT a browser that fails to hold
	// one. That page gets 54-11's index plus 53-D18's labelled slots, exactly
	// as it did before this plan — `assert-placeholders-labelled.mjs` requires
	// every slot declared in COPY to render on the election-less page, and it
	// is the only gate that can see a slot silently disappear.
	const addressed = address.status === 'ok';
	const holdsNothing = addressed && read.state === 'notHeld';
	const showBanner = addressed && (read.state === 'ready' || read.state === 'unreadable');
	const showLifecycleSlot = !addressed || read.state === 'reading' || holdsNothing;
	// 56-12/D-17: never on 'reading' (nothing to be stale yet), never on
	// 'notHeld' (no data exists to be stale), never on a genuinely
	// 'unreadable' election (that is a DATA fault, answered by the existing
	// bad-tone status banner, not a connectivity finding) — only a ready
	// page whose change channel is down, and only when the observed instant
	// actually formatted.
	const showStaleness = addressed && read.state === 'ready' && read.connection === 'down' && formattedInstant !== null;
	// 56-14/D-16/D-19: the live-update badge. Guarded on `!== 'down'` rather
	// than `=== 'live'` -- deliberately, and pinned by `liveness-feedback.test.mjs`
	// so a later "tidy" to `=== 'live'` is a red test with a reason attached.
	// The `!==` form preserves the mutual exclusion with the staleness banner
	// STRUCTURALLY (that banner renders on exactly `'down'`, so the two can
	// never coexist) without inventing a false negative on `'unknown'`, where
	// the evidence for the badge -- a remote notice that actually arrived --
	// is strictly stronger than a boot status that was never observed. No
	// fact, row or field is named here or anywhere downstream of it: the
	// notify channel this reacts to carries a table name plus a three-valued
	// op and nothing finer (56-09's own notify-granularity must-have), and no
	// table-to-fact reverse map exists to build a finer claim from. There is
	// also no persistent "connected" chip anywhere on this page -- this
	// module's own hook header gives the reason, and it has not changed.
	const showLiveUpdate = addressed && read.state === 'ready' && read.justUpdated && read.connection !== 'down';

	let body: ReactNode;
	if (configFault !== null) {
		// 56-12/D-13. FIRST arm, ahead of every address branch -- a
		// deployment that cannot learn where to dial cannot attempt a lookup
		// for ANY address, so showing the normal election/unreadable-address/
		// index branches would imply a capability that does not exist this
		// session. Reuses `.election-unreadable` VERBATIM (zero new CSS) --
		// the same two-element shape `unreadableAddress` below already uses,
		// distinguished from it and from each other by copy alone. The two
		// keys are resolved from the SAME closed set `PublicApp.tsx`'s
		// `FAULT_COPY_KEYS` declares; `configFault`'s own type admits only
		// the two `CONFIG_FAULT` values, so this template can only ever
		// produce one of the four keys that map declares.
		body = (
			<section className="election-unreadable">
				<h2>{t(`public.config.${configFault}.title`)}</h2>
				<p>{t(`public.config.${configFault}.body`)}</p>
			</section>
		);
	} else if (address.status === 'malformed') {
		// The offending value is never rendered — parseElectionAddress already
		// returns electionId: null for this status, so there is nothing here
		// to escape and nothing to leak (T-53-07-02).
		body = (
			<section className="election-unreadable">
				<h2>{t('public.election.unreadableAddress.title')}</h2>
				<p>{t('public.election.unreadableAddress.body')}</p>
			</section>
		);
	} else {
		body = (
			<section className="election">
				{/* D-17's staleness banner: FIRST child of `.election`, above
				    `.election-address` and above the (possibly stale) phase
				    headline itself. The ordering is load-bearing, not aesthetic:
				    a reader who meets the phase headline before this warning can
				    form a belief ("polls are open") that is minutes or hours
				    old before learning that belief might be stale. It shares
				    `--warn` with a `wait`-tone `.status-banner` without
				    collision — different position on the page, a different
				    word ("NOT CONNECTED" vs "PENDING"), a different question
				    (connection vs. phase). That is intentional reuse, not a
				    defect to fix by inventing a fourth colour. Neither child
				    may render alone — same redundant-cue rule `.status-banner`
				    states for itself in app.css. */}
				{showStaleness && formattedInstant ? (
					<div className="staleness-banner">
						<span className="staleness-banner__badge">{t('public.staleness.badge')}</span>
						<p className="staleness-banner__text">
							{t('public.staleness.body', { asOf: `${formattedInstant.text} (${formattedInstant.zone})` })}
						</p>
					</div>
				) : null}
				{address.status === 'ok' ? (
					<p className="election-address">
						{t('public.election.addressLabel')} <code>{address.electionId}</code>
					</p>
				) : null}
				{/* D-34: an address that does not resolve to ONE election gets the
				    index of what this browser holds, not an error. The two
				    statuses enumerated positively rather than negated, so the
				    condition stays live for 'ok'. */}
				{address.status === 'missing' || address.status === 'incomplete' ? (
					<ElectionIndex networkHash={address.networkHash} />
				) : null}
				{/* D-02's addressed-but-not-held sentence. Distinct from the
				    index's own empty label, which answers "this browser holds
				    no elections AT ALL"; this one answers "this browser holds
				    no copy of the election you asked for". Deliberately
				    UNCLASSED: 54-09 declared no selector for this block, and
				    css-class-coverage reports every rendered class with no
				    matching selector as missing, so an invented name would be
				    a red gate — an unclassed element inherits the section's
				    own type and colour instead. 54-13 may give it a class
				    TOGETHER WITH its selector. */}
				{holdsNothing ? <h2>{t('public.election.notHeld.title')}</h2> : null}
				{holdsNothing ? <p>{t('public.election.notHeld.body')}</p> : null}
				{/* The status banner: the tone chip and the headline sentence,
				    and NEITHER MAY RENDER ALONE (app.css's own markup
				    contract). Colour without a word fails colour-blindness and
				    greyscale; a word without colour discards the token layer.
				    Both together are D-17, which is why the tone key's own
				    resolution is part of the ONE guard rather than a second
				    conditional inside the block. */}
				{showBanner && toneKey !== null ? (
					<div className={`status-banner status-banner--${tone}`}>
						<span className="status-banner__tone">{t(toneKey)}</span>
						<p className="status-banner__headline">{headlineText}</p>
						{/* 56-14/D-16/D-19: the live-update badge, the status banner's
						    trailing chip, after the headline. Conditional -- absent
						    from the DOM entirely when not showing, never
						    `opacity: 0` -- so it is never announced to assistive
						    tech by default and never intercepts a click. */}
						{showLiveUpdate ? <span className="live-update-badge">{t('public.liveUpdate.badge')}</span> : null}
					</div>
				) : null}
				<LifecyclePill phase={phaseResult.phase} />
				{shellElection?.title ? (
					<p className="election-title">{shellElection.title}</p>
				) : (
					<div className="skeleton" data-slot="title">
						<span className="skeleton-label">{t('public.election.slot.title')}</span>
					</div>
				)}
				{/* D-10, and the removal of 54-05's holding measure -- see this
				    component's own header for what that measure was and why
				    the phase vocabulary is no longer named in this guard at
				    all. An unreadable schedule now says so IN WORDS through
				    the banner above, tone `bad`, instead of holding a grey bar
				    in its place. */}
				{showLifecycleSlot ? (
					<div className="skeleton" data-slot="lifecycle">
						<span className="skeleton-label">{t('public.election.slot.lifecycle')}</span>
					</div>
				) : null}
				{shellElection === null ? (
					<div className="skeleton" data-slot="timeline">
						<span className="skeleton-label">{t('public.election.slot.timeline')}</span>
					</div>
				) : null}
				{/* The body between the headline and the advisory: the four fact
				    groups, gaps rendered INLINE beside the facts they belong to
				    (D-11) rather than severed into a "not yet available"
				    section. It renders NOTHING when the phase carries no facts,
				    so the election-less page, the notHeld page and an
				    unreadable schedule each keep exactly the shape 54-11 and
				    54-12 gave them — no empty scaffolding under an explicit
				    unknown. `keyRelease` is D-14's three numbers, read beside
				    the election read by the ONE seam that owns the handle's
				    lifetime; `null` means the aggregate could not be read, and
				    the card says so instead of disappearing (D-23). `roll` is
				    the published voter roll (D-18), read by the same seam for
				    the same reason; `null` means it could not be read, and the
				    card renders its honest empty state rather than an error. */}
				<FactSections phase={phaseResult.phase} keyRelease={read.keyRelease} roll={read.roll} />
			</section>
		);
	}

	return (
		<AppChrome title={t('public.chrome.appName')}>
			{body}
			{/* THE STANDING VOICE (D-29, D-32). Note for a later editor: the
			    tier-1 scans strip only lines that OPEN with a line- or
			    block-comment marker, so a JSX comment like this one is part of
			    the scanned source. Nothing in this paragraph may spell a token
			    those rungs count — the ninth instance of that family in this
			    phase was manufactured right here and caught before it landed.

			    Three page-level statements, and their placement is load-bearing
			    rather than aesthetic: AFTER the fact body so a reader meets the
			    facts first, BEFORE the advisory so the four page-level
			    statements read as one voice, and OUTSIDE the toggle below so
			    none of them can ever be collapsed out of view. The block
			    carries NO CONDITION and introduces no second exit point from
			    this function — that is the point, and it is the same reasoning
			    `AdvisoryDisclosure`'s own header gives for itself: a standing
			    caveat that can be conditioned on anything can be hidden.

			    WHY THESE THREE AND NOT A FOURTH. Both caveats say only things
			    that stay true once this browser's copy starts syncing — that
			    the schedule is authority-published and not independently
			    checked here, and that the page changes nothing and asks nothing
			    about who is reading. The candidate that was dropped — that some
			    facts have no source anywhere in the system — is already carried
			    by every gap card and by the key-release card's own detail text,
			    so a page-level restatement would repeat content already on
			    screen and add a second place for it to go stale. The freshness
			    line (56-12/D-17) is now a PERMANENT architectural statement,
			    true in both the connected and the disconnected state; it is no
			    longer scheduled to expire, and the copy table's own comment
			    records why a later reader must not reinstate an expiry note.

			    The two class names are 54-09's own, declared for exactly this
			    block. No heading: no copy key exists for one, and inventing
			    English here would bypass the shared copy table. */}
			<section className="public-caveats">
				<p className="public-caveat">{t('public.freshness.body')}</p>
				<p className="public-caveat">{t('public.caveat.timelineUnvalidated')}</p>
				<p className="public-caveat">{t('public.caveat.readOnly')}</p>
			</section>
			{/* A sibling of the toggle below, never a child of it — D-16 forbids
			    the advisory ever becoming conditional on anything, including
			    being hideable inside a collapsible. */}
			<AdvisoryDisclosure variant="public" />
			<DetailsToggle summary={t('public.details.summary')}>{t('public.details.body')}</DetailsToggle>
		</AppChrome>
	);
}

export default ElectionShell;
