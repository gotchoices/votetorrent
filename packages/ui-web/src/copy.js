/**
 * The shared copy table for VoteTorrent's web apps.
 *
 * Two web consumers read this table: `apps/VoteTorrentDashboard` (the authority
 * officer's dashboard) and `apps/VoteTorrentPublic` (the no-login public election
 * view). The two React Native apps -- `apps/VoteTorrentAuthority` and
 * `apps/VoteTorrentVoter` -- are NOT consumers of this table and keep their own
 * `src/i18n/` tables.
 *
 * Contract C2 (binding, frozen by 50-04-PLAN.md): one flat frozen record `COPY` with
 * dotted string keys, plus `t(key, params)`. This is still the ONLY place any
 * user-facing string in either web app may live -- `scripts/lint-copy.mjs` fails the
 * build if a binding sentinel string appears anywhere else under `src/`.
 *
 * Transcribed verbatim from 50-UI-SPEC.md's Copywriting Contract.
 *
 * The "no later plan adds a key" rule above is a rule about PLANS, and it held:
 * the table was complete for every screen this phase built. It is not a rule
 * that a defect may not be fixed. Code review found user-facing text rendered
 * OUTSIDE this table in two places -- the raw machine phase codes in
 * `screens/Bootstrap.tsx` and the `tier`/`site(s)` pills in
 * `screens/panels/PanelFrame.tsx` -- and the fix for each is a key here, which
 * is exactly what contract C2 demands. Every such addition is recorded in a
 * comment beside the keys it adds.
 *
 * D-08: this table is no longer complete-and-frozen for all time. `public.*`
 * keys arrive under that prefix as `apps/VoteTorrentPublic` actually mounts each
 * screen that needs one -- never speculatively -- and each addition is recorded,
 * per the existing convention above, in a comment beside the keys it adds.
 *
 * D-08, AMENDED for the public election view's fact/gap table (54-09). The
 * `public.*` block at the bottom of this file now arrives one to five waves
 * BEFORE the screens that mount it. The "never speculatively" rule is not
 * waived; it is satisfied by a different warrant, because a speculative key
 * is one nobody has committed to mounting, and none of these is:
 *   - 50 of them are named by `FACT_COPY_KEYS`, a frozen, derived, tested
 *     export of `src/lifecycle/facts.js`. That export is computed from the
 *     fact model itself, its completeness is asserted in `test/facts.test.mjs`,
 *     and `test/copy.test.mjs` iterates it -- so the set is a landed contract,
 *     not a guess about a future screen.
 *   - the remaining 11 are each named by a locked phase decision or by an
 *     already-planned call site that binds them BY NAME (see the per-group
 *     comments beside them).
 * `t()` throws on an unknown key, so authoring them late would turn every
 * render plan into a render failure; authoring them here is what makes the
 * render plans mountable at all. The residual this leaves -- a key that
 * ships and then is never actually mounted -- is closed by the render plans
 * themselves, which gate their own output against this same contract, and by
 * `apps/VoteTorrentPublic/test/node/election-shell.test.mjs`'s bidirectional
 * declared-vs-mounted case, whose interim allow-list must shrink to empty as
 * each of the eleven is mounted.
 *
 * D-07 (variant-prop contract): a component SHARED between the two web apps must
 * not hard-code one consumer's copy key. It takes an explicit `variant` prop and
 * resolves its own key at render time, so `t()`'s throw-on-unknown-key turns a
 * missing public voice into a loud render failure instead of a silent wrong
 * answer. This closes a real defect: a shared `AdvisoryDisclosure` component
 * rendered "What's shown here follows the officer's permissions…" on a no-login
 * public page with no officer and no permission model to speak of -- with clean
 * imports, a green typecheck and every other gate green, caught only by looking
 * at a screenshot. A `public.*` value must be authored FRESH for a no-login
 * audience and must never be derived by find-and-replace from a `gate.*` or
 * `bootstrap.*` string. The residual control is a manual per-consumer copy
 * review, because every automated gate in this repo is provably blind to a
 * false-but-well-formed word.
 *
 * D-10: `50-UI-SPEC.md` remains the design authority for the dashboard's half of
 * this table, but it is no longer the sole authority -- the table now also
 * serves an app that spec never described.
 *
 * Contract C3 (D-17): there is deliberately NO `read-only` / `◐` panel-state string in
 * this table. Nothing in this phase is writable -- every panel in this phase is either
 * fully visible (granted scope) or fully hidden (withheld scope) -- so a read-only
 * badge would describe a state that cannot occur. `scripts/lint-copy.mjs` fails if a
 * `/read-only/i` match ever appears in any value.
 *
 * Contract C4: the four `50-UI-SPEC.md` "Producer screen (RN app)" copy rows are NOT
 * transcribed here. They belong to `apps/VoteTorrentAuthority`'s own
 * `src/i18n/index.ts` and are owned by plan 50-07. A web bundle must not ship a React
 * Native screen's strings.
 *
 * 53-05's key-naming resolution (D-07 vs D-09, this plan's own open question,
 * resolved in favor of D-07 for this one shared component): (1) the D-07
 * `variant` prop resolves `advisory.<variant>.body` by TEMPLATE LITERAL, not
 * a lookup map; (2) `gate.advisoryDisclosure` was RENAMED to
 * `advisory.authority.body`, its value carried across byte-identical; (3)
 * this is the ONLY key renamed by this plan -- the other 72 keep D-09's
 * byte-identical guarantee untouched; (4) the template form is chosen over a
 * lookup map because a map admits a one-token `?? 'advisory.authority.body'`
 * fallback that would silently restore the authority voice on the public
 * app, and no test in this repo could see it -- a template literal has
 * nowhere to put that token; (5) `advisory.*` is a variant-paired namespace
 * owned by ONE shared component, whose two members are the two voices of
 * one sentence and neither exists without the other -- `public.*` remains
 * the public app's own namespace for keys with NO authority sibling; (6) the
 * deferred `authority.*`/`public.*`/`shared.*` re-prefixing declined at D-09
 * remains declined -- this is a scoped exception for one paired variant, not
 * the first stone of that rewrite. `50-UI-SPEC.md` is NOT the authority for
 * the `advisory.*` pair; this file's own header is.
 */
/** @type {Record<string, string>} */
export const COPY = Object.freeze({
	'chrome.moreOptionsAriaLabel': 'More options',

	// Authorization gate and preview control
	//
	// `advisory.authority.body` was `gate.advisoryDisclosure` before 53-05 --
	// renamed, value byte-identical, under D-07 (see the header note below).
	// Its sibling `advisory.public.body` arrives fresh, authored for a
	// no-login audience, when 53-07 mounts the public shell (D-08) -- it is
	// deliberately absent until then.
	'advisory.authority.body':
		"What's shown here follows the officer's permissions, but this dashboard makes no changes and enforces nothing on its own — anyone with this browser's data has the whole database regardless of what's visible.",
	'gate.badgeReal': 'answered by the database',
	'gate.badgeSimulated': 'simulated scope set',
	'gate.resetScopesCta': 'Reset to my scopes',
	'gate.revealDeniedCta': 'Reveal denied panels',
	'preview.title': 'Preview as',
	// Panel-frame pills. `tier`, `site` and the English pluralisation rule were
	// authored user-facing prose living outside this table -- and lint-copy.mjs
	// could not see them, because it scans for a fixed sentinel list rather
	// than for arbitrary literals. The singular and plural are SEPARATE keys,
	// not a suffix computed in the component, so a locale whose plural is not
	// formed by adding a letter has somewhere to put its own answer.
	'panelFrame.tierPill': 'tier {{tier}}',
	'panelFrame.sitePill': '{{count}} site',
	'panelFrame.sitesPill': '{{count}} sites',
	// Phase 60 (D-13/D-17): the per-panel chart/grid view switch, shared by
	// every panel that offers a chart view -- currently Registrations and
	// Keyholders. Lives in PanelFrame's own header, beside the pills above.
	'panelFrame.viewChart': 'Chart',
	'panelFrame.viewGrid': 'Grid',

	// Navigation groups and lifecycle pill
	'nav.groupElectionOperations': 'Election Operations',
	'nav.groupAuthorityAdministration': 'Authority Administration',
	// Phase 54 (D-06/D-10): renamed from the three-phase organizing/running/
	// released vocabulary to spike 086's four-phase pre/voting/settling/closed
	// model -- a RENAME of all three prior ids, not an insertion of a fourth
	// (adjudicated I-12). lifecycle.closed replaces the now-false "Results
	// released": in the four-phase model the terminal phase opens at the
	// `closed` event, not at `tallyingStarts`, and this page guarantees (D-13)
	// no Tally/Certification/Validation table exists, so "released" would name
	// a result that isn't there. lifecycle.indeterminate is D-10's explicit
	// unknown-phase state, rendered as a visible pill rather than nothing.
	'lifecycle.pre': 'Being organized',
	'lifecycle.voting': 'Voting',
	'lifecycle.settling': 'Settling',
	'lifecycle.closed': 'Closed',
	'lifecycle.indeterminate': 'Phase unknown',

	// Panel titles and empty states, in the UI-SPEC's fixed order (registrations
	// first, always -- 'vrg' is 39% of the authorization surface)
	'panels.registrations.title': 'Registrations',
	'panels.registrations.empty': 'No registrants yet.',
	// Phase 60 (D-22): the three panel states distinct from the pre-existing,
	// genuinely-empty `.empty` above -- loading, no election data loaded at
	// all, and a failed read. Today all four states rendered one shared
	// paragraph, so a failed read was indistinguishable from an empty
	// election; this closes that.
	'panels.registrations.loading': 'Loading registrations…',
	'panels.registrations.unavailable': 'No election data is loaded in this browser yet.',
	'panels.registrations.readFailed': "Couldn't load registrations. This panel tries again when new data arrives.",
	// Phase 60 (D-06): section headings for all four Registrations sections,
	// authored prose rather than literal JSX text (rule R1, contract C2).
	'panels.registrations.statusHeading': 'Registrants by status',
	'panels.registrations.requestsHeading': 'Registration requests',
	'panels.registrations.rosterHeading': 'Roster',
	'panels.registrations.surfaceCountsHeading': 'Tables read',
	// Phase 60 (D-21): chart-level empty frames, distinct from the panel
	// states above -- a chart can be empty while its panel loaded fine.
	'panels.registrations.intakeChart.empty': 'No requests received in this window.',
	'panels.registrations.requestChart.empty': 'No requests recorded yet.',
	// Phase 60: hover-tooltip templates for the three Registrations charts
	// (C1/C2/C3 of 60-UI-SPEC.md's chart inventory). Placeholder names match
	// what each render site supplies; `t()` throws on any left unresolved.
	'panels.registrations.statusChart.tooltip': '{{status}}: {{count}} registrant(s)',
	'panels.registrations.requestChart.tooltip': '{{status}} · {{issuer}}: {{count}} request(s)',
	'panels.registrations.intakeChart.tooltip': '{{bucket}}: {{count}} received',
	'panels.elections.title': 'Elections',
	'panels.elections.empty': 'No elections yet.',
	'panels.ballotsQuestions.title': 'Ballots & Questions',
	'panels.ballotsQuestions.empty': 'No ballots yet.',
	'panels.networkSettings.title': 'Network Settings',
	'panels.networkSettings.empty': 'No network settings recorded yet.',
	'panels.authorityProfile.title': 'Authority Profile',
	'panels.authorityProfile.empty': 'No authority profile yet.',
	'panels.authorityPeers.title': 'Authority Peers',
	'panels.authorityPeers.empty': 'No peer authorities yet.',
	'panels.administrationOfficers.title': 'Administration & Officers',
	'panels.administrationOfficers.empty': 'No officers yet.',
	'panels.keyholders.title': 'Keyholders',
	'panels.keyholders.empty': 'No keyholders yet.',
	// Phase 60 (D-22): the three panel states distinct from the pre-existing,
	// genuinely-empty `.empty` above -- same rationale as the Registrations
	// group above.
	'panels.keyholders.loading': 'Loading keyholders…',
	'panels.keyholders.unavailable': 'No election data is loaded in this browser yet.',
	'panels.keyholders.readFailed': "Couldn't load keyholders. This panel tries again when new data arrives.",
	// Phase 60 (D-07/D-21): the threshold meter's chart-level empty frame,
	// and its numeral template ("N of M" per 60-UI-SPEC.md).
	'panels.keyholders.meter.empty': 'No keyholder threshold set for this election yet.',
	'panels.keyholders.meter.value': '{{count}} of {{total}}',
	'panels.inviteAuthorities.title': 'Invite Authorities',
	'panels.inviteAuthorities.empty': 'No invitations yet.',

	// --- Public election view (53-07, D-08) -------------------------------
	//
	// Ten keys when 53-07 landed, because apps/VoteTorrentPublic's
	// ElectionShell actually mounted every one of them -- never
	// speculatively (D-08); 54-09 then added sixty-one more under the
	// amended warrant recorded in this file's header (the fact model's own
	// derived key contract, plus eleven keys each named by a locked
	// decision). Every value below was authored FRESH for a no-login
	// audience and was NEVER
	// produced by find-and-replacing `advisory.authority.body` or any
	// `gate.*`/`bootstrap.*` string (D-07); `packages/ui-web/test/public-voice.test.mjs`
	// lints this block for banned lexemes (officer/permission/scope/login
	// words/account/dashboard/snapshot/simulated) and for any shared 6-word
	// run with the authority-voiced corpus.
	//
	// `advisory.public.body` is the sibling `AdvisoryDisclosure`'s
	// `advisory.${variant}.body` template resolves for `variant="public"` --
	// deliberately absent since 53-05 (it threw by name until this key
	// landed, which was the mechanism, not a gap). It must read true on BOTH
	// the shipped election-less page and 53-07's harness page, so it makes
	// no claim tied to any one election.
	//
	// REWRITTEN by 54-09. The value shipped by 53-07 was FALSE, and in two
	// distinct ways, both of them consequences of the same fact: this app's
	// only data source is the election records this particular browser
	// already holds.
	//   (1) It promised that whoever opens the page sees the election
	//       record. A first-time visitor's browser holds no record at all,
	//       so for them the page shows nothing -- the promise is not merely
	//       imprecise, it is wrong for the commonest visitor.
	//   (2) It promised that the page never shows different visitors
	//       different things. What any visitor sees depends entirely on
	//       their own browser's holdings, so two visitors routinely see
	//       different pages.
	// It is not enough to note this in a plan: the reason a well-formed
	// sentence like that one survived review and shipped is that no
	// automated gate in this repo can see a false word, so the correction
	// has to live where the next author will read it.
	//
	// The replacement carries exactly three claims, and they are the only
	// three that stay true across the move from today's read-once store to
	// real-time sync: the page shows the election's OWN PUBLISHED RECORD;
	// it shows the SAME RECORD to every visitor WHOSE BROWSER HOLDS IT; and
	// NOTHING DONE HERE CHANGES IT. It deliberately makes no claim about
	// reach -- how far a record travels, who else can get one, whether the
	// two web apps share a store. There is no replication layer anywhere in
	// the web tree, and the origin topology of the two web apps is an open
	// question, so any sentence about reach would be unverifiable today and
	// could be falsified whichever way that question resolves. A claim this
	// page cannot check is the same defect as the one being replaced.
	'advisory.public.body':
		"This page shows the election's own published record, exactly as this browser holds it. Every visitor whose browser holds the same record sees the same facts here, and nothing done on this page changes what the record says.",
	'public.chrome.appName': 'VoteTorrent Public Election View',
	'public.election.addressLabel': 'Election address',
	// unreadableAddress.*: this app holds no election data at all, so it
	// cannot say an election does not exist -- only that the ADDRESS in the
	// link could not be read. It must not tell the reader to sign in, and
	// must not ask them to contact anyone by role name -- it names the link
	// itself as the thing to check.
	'public.election.unreadableAddress.title': "This link's election address isn't readable.",
	'public.election.unreadableAddress.body':
		"The part of this link that names an election doesn't match the expected form, so this page can't tell which election it points to. Check the link for a typo, or ask whoever shared it to send it again.",
	// slot.* are SLOT LABELS -- the name of the thing whose place is held --
	// never a status message. None may say "loading"/"fetching"/"please
	// wait"/"updating": a placeholder here is not evidence of an in-flight
	// request, because none exists (D-18).
	'public.election.slot.title': 'Election title',
	'public.election.slot.lifecycle': 'Lifecycle phase',
	'public.election.slot.timeline': 'Election timeline',
	'public.details.summary': 'About this view',
	// The one structural fact this page can honestly state with no election
	// loaded: a lifecycle phase, when shown, is computed from an election's
	// own published timeline, never picked by anyone -- it makes no claim
	// about where that timeline comes from, because in this phase it comes
	// from nowhere.
	//
	// REWRITTEN by 54-09. The value shipped by 53-07 named THREE phases,
	// using the retired organizing/running/released vocabulary; the shared
	// model now derives FOUR, and the three-phase sentence had no word at
	// all for the one a reader is most likely to meet. Settling -- after
	// voting closes and before any result is final -- is where a realistic
	// election spends nearly all of its observable life: measured against
	// the phase's own sample timeline, 12.96 days settling against 0.54
	// days voting. A sentence that omits it describes the page's rarest
	// state and skips its commonest.
	//
	// The four words here are the same four the pill renders, so the prose
	// and the pill cannot disagree: a reader who sees "Settling" on the
	// pill finds "settling" explained in this paragraph, and a rename of
	// either would be visible as a disagreement rather than hidden as a
	// synonym.
	'public.details.body':
		'An election modeled here moves through four phases: being organized, voting, settling — after voting closes and before any result is final — and closed. Nobody picks the phase by hand; it follows from the dates the election itself publishes.',

	// --- Public election view, the fact/gap table (54-09) ------------------
	//
	// Sixty-one keys. Fifty of them are exactly the members of
	// `src/lifecycle/facts.js`'s frozen `FACT_COPY_KEYS` export -- the fact
	// model's own published contract, iterated (never transcribed) by
	// `test/copy.test.mjs`, so the two cannot drift. The other eleven sit
	// outside the fact model and are called out individually below.
	//
	// Every value here is subject to the same two lints as the block above
	// (banned lexemes; no shared 6-word run with the authority-voiced
	// corpus), which now run over all sixty-seven public-voice values rather
	// than the original ten, because `test/public-voice.test.mjs` derives
	// its key set from `FACT_COPY_KEYS` instead of listing it.

	// REWRITTEN (56-12, D-17). This is now a PERMANENT ARCHITECTURAL
	// STATEMENT, not a placeholder scheduled to expire -- the D-30
	// KNOWN-EXPIRING comment that used to sit here is gone on purpose. The
	// sentence names both halves of the real behaviour and stays true no
	// matter which one is active on a given visit: while the change channel
	// is live it updates on its own, and when it is not it shows the last
	// version this browser received. A later reader must not reinstate an
	// expiry note here -- rewriting a sentence that is already correct in
	// both states would be a regression, not a fix. The disconnected half is
	// what `public.staleness.badge`/`.body` below make concrete, with an
	// absolute timestamp; this line makes no claim about WHEN, only that one
	// of the two states always holds.
	'public.freshness.body':
		"This page updates automatically while it's connected to the network, and shows the last version it received when it isn't.",

	// Surface 1 (56-12, D-17): the staleness banner. Same redundant-cue rule
	// as the tone-chip words directly below -- the badge's colour (`--warn`
	// in app.css) and this ALL-CAPS word always render together, and neither
	// may render alone. `{{asOf}}` in `.body` receives an ABSOLUTE,
	// zone-labelled instant built from `formatReaderInstant()`'s `text` and
	// `zone` -- never a relative string, because a relative string decays
	// the instant it is painted and this page never re-renders on its own to
	// correct it (the same reasoning `use-public-election.ts`'s own header
	// gives for never rendering `live` as a badge).
	'public.staleness.badge': 'NOT CONNECTED',
	'public.staleness.body':
		"This is the last version of this election your browser received. As of {{asOf}}, it isn't connected to the network.",
	// Surface 5 (56-14, D-16's UI half / D-19's UI half): the live-update
	// badge. Same redundant-cue rule as every other chip word in this file --
	// the badge's colour (`--ok` in app.css) and this ALL-CAPS word always
	// render together, and neither may render alone. It is a REPORT of an
	// event this page observed (a peer write landed and was applied), never a
	// standing claim about the present moment -- it is absent from the DOM
	// outside a fixed window, and there is no persistent "connected" chip
	// anywhere on this page. It names no table, no row and no fact: the
	// notify channel this badge reacts to carries a table name plus a
	// three-valued op and nothing finer (56-09's own must-have on notify
	// granularity), and this value must never be widened to imply otherwise.
	'public.liveUpdate.badge': 'UPDATED',
	// Tone chip words. These are the REDUNDANT NON-COLOUR CUE for the status
	// banner: the chip's colour and this word always render together, and
	// neither may render alone. The word is what survives greyscale, a
	// monochrome print, and every form of colour blindness -- so it must
	// stay a short standalone status word and must never be reduced to a
	// restatement of the headline beside it.
	'public.tone.go': 'OPEN',
	'public.tone.wait': 'PENDING',
	'public.tone.done': 'CLOSED',
	'public.tone.bad': 'UNKNOWN',

	// Group headings. One per member of `facts.js`'s `FACT_GROUPS`, resolved
	// mechanically by `groupCopyKey()` -- a group added there without a key
	// here is a loud throw from `t()`, never a machine identifier on screen.
	'public.group.electionAndRules': 'The election and its rules',
	'public.group.ballot': 'The ballot',
	'public.group.electorate': 'The electorate',
	'public.group.outcome': 'The outcome',

	// Headlines. One per distinct outcome of `facts.js`'s `headlineKey()`,
	// which pairs each with a tone.
	//
	// `public.headline.pre.registrationUnknown` is the one value here that
	// is not adopted from the design spec, and it exists to refuse a guess.
	// Spike 088 collapsed an unreadable registration-end date into
	// "Registration has closed" -- which is not a cautious answer, it is an
	// invented one, and the derivation library's standing rule is that a
	// phase is either derived from readable dates or reported as underived.
	// This sentence states the one thing that IS derived from the phase
	// alone (voting has not started) and explicitly declines the one that is
	// not (whether registration is still open). It must not be reworded back
	// toward "closed": doing so would restore 088's defect while leaving
	// every gate green, since a guess and a derivation are indistinguishable
	// once written down as a sentence.
	'public.headline.pre.registrationOpen': 'Registration is open',
	'public.headline.pre.registrationClosed': 'Registration has closed — voting has not started',
	'public.headline.pre.registrationUnknown':
		"Voting has not started — whether registration is still open can't be read from this election's schedule.",
	'public.headline.voting': 'Polls are open',
	'public.headline.settling': 'Voting has closed — no result is final yet',
	'public.headline.closed': 'This election is closed',
	'public.headline.unknown': "This election's schedule can't be read, so its phase is unknown.",

	// Per-fact card labels, one per `FACTS` entry, taken from spike 088's own
	// label strings and corrected in six places:
	//   rules       -- was "Election rules", which duplicated its own group
	//                  heading almost exactly.
	//   ballot      -- was "The ballot", byte-identical to its group heading,
	//                  so the card looked like a repeat of the heading above
	//                  it.
	//   turnout     -- was "Ballots cast / turnout"; a slashed pair is a
	//                  label that could not decide, and "turnout" adds
	//                  nothing a reader of "Ballots cast" does not have.
	//   receipt     -- was "Verify my vote is included": an imperative naming
	//                  an affordance this page does not have. The card exists
	//                  to say that check is unavailable, so its label must
	//                  not offer it.
	//   merkle      -- was "Merkle root of vote blocks". The card's own
	//                  sentence already avoids that vocabulary; a label that
	//                  reintroduces it puts the jargon back on the always-
	//                  visible surface.
	//   timeline/polls are 088 verbatim and deliberately match the wording
	//                  already shipped elsewhere on the page.
	//
	// EXCEPTION, do not "fix" it: `registrantRoll` has no
	// `public.fact.*.label` key. Its `labelKey` is
	// `public.registrantRoll.heading`, set that way in `facts.js` (a landed
	// file) so the roll's heading, body, disclaimer and empty message stay
	// one namespace rather than being split across two. The asymmetry is
	// deliberate.
	'public.fact.identity.label': 'Election',
	'public.fact.authority.label': 'Who runs this election',
	'public.fact.governance.label': 'Signed governance trail',
	'public.fact.rules.label': 'Rules and policies',
	'public.fact.timeline.label': 'Timeline',
	'public.fact.registration.label': 'Registration',
	'public.fact.ballot.label': 'Questions and options',
	'public.fact.polls.label': 'Polls',
	'public.fact.electorate.label': 'Eligible electorate',
	'public.fact.keyholders.label': 'Keyholders',
	'public.fact.turnout.label': 'Ballots cast',
	'public.fact.receipt.label': 'Checking your own ballot',
	'public.fact.merkle.label': 'Cryptographic record of the votes',
	'public.fact.keyrelease.label': 'Keyholder key release',
	'public.fact.results.label': 'Results',
	'public.fact.validation.label': 'Validation report',
	'public.fact.certification.label': 'Certification',

	// The gap cards: six facts this system does not record anywhere, each
	// with two strings that are NOT interchangeable.
	//
	// `.sentence` renders on the card and is always visible. It is a plain
	// human sentence: what is missing, and enough of why that a reader who
	// stops here is not misled.
	// `.detail` renders only after a reader opens the details toggle. It
	// carries the technical reason and the specification citation, which is
	// why a schema table name may appear in a `.detail` value and appears in
	// no `.sentence` and no `.label`.
	//
	// The internal enumeration these gaps come from letters them A through
	// G. No letter appears in any key name or any value in this table --
	// not here, not in a heading, not in a detail. A reader has no way to
	// resolve a letter to a meaning, so it is an identifier leaking out of
	// the source, not information.
	'public.gap.turnout.sentence':
		"How many ballots have been cast isn't shown here — there's no record of vote counts in this system yet.",
	'public.gap.turnout.detail':
		"No Vote or VoteEntry table exists; vote and voter entries live in negotiated blocks the schema doesn't model (doc/election.md:95-110).",
	'public.gap.receipt.sentence':
		"There's no way on this page to confirm your own ballot was received — that check depends on a private receipt only you hold.",
	'public.gap.receipt.detail':
		'The vote nonce is held privately by the voter; nothing on the network can be checked against it (doc/election.md:97).',
	'public.gap.merkle.sentence': "The cryptographic record tying votes together isn't published here.",
	'public.gap.merkle.detail': 'No Block or MerkleNode table exists yet (doc/election.md:114).',
	'public.gap.results.sentence':
		"Results aren't published on this page — there's no tally recorded anywhere in the system yet.",
	'public.gap.results.detail': 'No Tally table exists (doc/election.md:124-132).',
	'public.gap.validation.sentence': 'No validation report or error-margin figure is available here.',
	'public.gap.validation.detail':
		'No Validation table exists, and no error-margin statistic is recorded anywhere (doc/election.md:134-153).',
	'public.gap.certification.sentence': "No signed certification of this election's outcome is available here.",
	'public.gap.certification.detail':
		'No Certification table exists; each authority is meant to publish one, but nothing stores it (doc/election.md:155-159).',

	// Key release -- the one entry in the outcome group that is FILLED
	// rather than gapped, and the only fact on this page carrying live data
	// during the settling window. It renders on a plain fact card and must
	// never be given the gap card's dashed, muted, de-emphasised treatment:
	// it is the counter-example the rest of that group exists to set off.
	//
	// `{{released}}` and `{{total}}` are interpolated by `t()` from values
	// the shell supplies out of the public read. Both placeholder names must
	// stay byte-identical to the `interpolates` array on this fact's entry
	// in `facts.js`; the copy test asserts that correspondence in both
	// directions, and `t()` throws by name on any placeholder left
	// unresolved.
	//
	// THE DENOMINATOR -- the load-bearing half of this note. `{{total}}` is
	// fed from the read's KEYHOLDER COUNT, and never from the read's own
	// `total` field. That field counts release-key TASKS, and no task exists
	// until one is raised, so feeding it would render "0 of 0" for the whole
	// ~13-day settling window: the emptiest possible answer for the one fact
	// that is supposed to be non-empty exactly then. The placeholder is
	// deliberately NOT renamed to match the value it carries, because the
	// render plan's call site is already written against these two names and
	// `facts.js`'s `interpolates` array is frozen and landed -- renaming
	// here would break both. The clean rename touches this file, `facts.js`,
	// its test and the render component together, and is recorded as
	// outstanding rather than done. Until then: a later reader who "tidies"
	// the call site to pass the read's `.total` reintroduces the "0 of 0"
	// defect, and this comment is what stands between them and it.
	'public.fact.keyrelease.sentence': '{{released}} of {{total}} keyholders have released their keys.',
	'public.fact.keyrelease.detail':
		"This counts keyholders whose key-release task has completed; it doesn't show which keyholder released a key or when (doc/election.md:118-122).",
	// Fail-closed disclosure for the aggregate above, bound by name at its
	// render site (it cannot be the entry's `emptyKey`: that field is null
	// on this fact and `facts.js` is a landed file, so this key sits outside
	// `FACT_COPY_KEYS`). When the count cannot be read, the card stays and
	// says so. The alternative considered and rejected was omitting the
	// card: on a page whose whole subject is what can and cannot be known, a
	// card that silently disappears is indistinguishable from a fact that
	// does not exist, which is the one confusion this page is built to
	// prevent.
	'public.fact.keyrelease.unreadable':
		"The number of keyholders who have released their keys couldn't be read, so it isn't shown here.",
	// Phase 60 (60-06, C6): the meter's dedicated empty-frame copy for the
	// genuinely-reachable branch where `readKeyReleaseProgress` computes
	// `keyholderCount` as zero -- distinct from `.unreadable` above, which
	// says the number could not be read at all. Rendering `.unreadable` here
	// would be false (it was read, and is zero) and would contradict the
	// sentence rendered directly above the meter.
	'public.fact.keyrelease.meterEmpty': 'No keyholders are recorded for this election yet.',

	// The voter roll. `.disclaimer` is the one that earns its length: it
	// tells the reader that what they are looking at is the published
	// subset, not a redaction of something richer, and it does so WITHOUT
	// naming the field collection that is never read or the selective-
	// disclosure mechanism that is out of scope -- both are internal
	// vocabulary, and this string renders on the card rather than behind the
	// details toggle, so neither may appear in it.
	'public.registrantRoll.heading': 'Voter roll',
	'public.registrantRoll.body':
		'These are the people registered to vote in this election, as published by the authority.',
	'public.registrantRoll.disclaimer':
		'This shows only the publicly named fields — no other registrant detail is shown or read.',
	'public.registrantRoll.empty': 'No registrants recorded yet.',
	// Phase 60 (60-06, C7): roll composition chart -- district hover tooltip
	// (single hue, D-9/D-09) and the fold label for districts below the
	// small-count threshold.
	'public.registrantRoll.chart.tooltip': '{{district}}: {{count}} registrant(s)',
	'public.registrantRoll.chart.otherBucket': 'Other',

	// The two standing caveats. EXACTLY TWO ship, and the count is a
	// decision rather than an accident: a third candidate -- that some facts
	// have no source anywhere in the system -- was considered and dropped,
	// because every gap card on the page already says precisely that about
	// itself, and a page-level restatement would repeat content already on
	// screen while adding a second place for it to go stale.
	//
	// `public.caveat.readOnly` is REWRITTEN, not adopted. The drafted
	// version used the words for having no login, which this table's own
	// lint bans outright -- this app has no such concept to name, and a
	// public page that mentions one invites the reader to look for it. The
	// replacement keeps both halves of the original claim (nothing here
	// changes anything; nothing here asks who you are) in words that belong
	// to this page. The key NAME is unaffected by the value lint, but the
	// VALUE must never contain the hyphenated phrase this table forbids in
	// contract C3 above.
	'public.caveat.timelineUnvalidated':
		"This election's schedule is published by its own authority and isn't independently checked here.",
	'public.caveat.readOnly':
		'Nothing on this page can be changed, and nothing here asks who you are — it can only show what this browser holds.',

	// The string half of the fail-closed rule for the rules card: when one
	// of an election's disclosure settings cannot be read, the page says so
	// instead of quietly rendering one fewer row. The BEHAVIOUR half -- show
	// nothing for that field and never omit it silently -- belongs to the
	// render plan; this key exists so that the failure is sayable at all.
	'public.rules.policyUnreadable':
		"One of this election's disclosure settings couldn't be read, so nothing for that field is shown.",

	// The index of elections this browser holds.
	//
	// `public.index.emptyBody` is REWRITTEN, not adopted, for two
	// independent reasons and it is worth recording both. The drafted
	// version told the reader to redeem a code or open a link to a specific
	// election. First, it used a banned lexeme, so it was red against a lint
	// that has shipped for some time -- adopted verbatim it would not have
	// built. Second, and more seriously, its remedy was FALSE: this page
	// reads only what this browser already holds, so opening someone else's
	// link resolves nothing, and a page with no records would have offered a
	// remedy that cannot work. That is the same class of defect as the
	// advisory sentence rewritten above -- an unverifiable promise in a
	// well-formed sentence -- caught here before it shipped rather than
	// after. The replacement states the limit and stops.
	//
	// `public.index.someUnreadable` is the qualifier that keeps the empty
	// label honest, and three things about it are load-bearing.
	//   (i)   It says only that something held here could not be read. No
	//         cause, no suggestion that the data exists elsewhere, no
	//         implication that it would arrive later -- so it stays true
	//         after real-time sync lands.
	//   (ii)  It names no internal vocabulary: no store, no registry, no
	//         state name.
	//   (iii) Its GATE, which is the part a render site can get wrong: it
	//         belongs to the loaded result's own completeness flag being
	//         false, and NEVER to a count of unreadable networks. A registry
	//         read that throws leaves that count at zero while completeness
	//         is false, so a count-based gate would let precisely the
	//         corrupt-registry case render an unqualified "no elections"
	//         with no qualifier at all -- the exact hole this sentence
	//         exists to close. A page that is merely still loading cannot
	//         trip it, and needs no second guard to prevent that: there is
	//         no result at all while loading, so the flag cannot be false
	//         then.
	// It must read sensibly BOTH as the only content of an otherwise empty
	// index AND directly beside the empty heading and body, because the
	// empty label is gated on emptiness alone: one network reading fine and
	// holding nothing while another cannot be read at all renders all three
	// together.
	'public.index.viewElectionCta': 'View election',
	'public.index.emptyHeading': 'This browser holds no elections yet.',
	'public.index.emptyBody':
		'This page can only show elections whose records are already stored in this browser, and none are stored here yet.',
	'public.index.someUnreadable':
		"Something stored in this browser couldn't be read, so this page may not be showing everything it holds.",

	// --- D-02's addressed-but-not-held sentence (54-12) --------------------
	//
	// These two answer a DIFFERENT question from the three `public.index.empty*`
	// keys above, and the difference is the whole reason they exist as their
	// own pair rather than as a reuse. The index keys answer "this browser
	// holds no elections AT ALL", which is a statement about the browser.
	// These answer "this browser holds no copy of THE ELECTION THIS LINK
	// NAMES", which is a statement about one addressed record while other
	// records may well be present. Collapsing the two would make one of the
	// two situations describable only by a sentence that is false about it.
	//
	// Neither may drift toward an error voice. Not holding an addressed
	// election is an ORDINARY state for an anonymous reader whose browser was
	// seeded from a different network -- nothing failed, and saying otherwise
	// would put a fault where there is only an absence (the same distinction
	// `public-election-source.js` keeps between `notHeld` and `unreadable`).
	// Neither may offer a remedy either: this page reads only what this
	// browser already holds, so "open the link again" or "ask for access"
	// would be an unverifiable promise, which is exactly the defect
	// `public.index.emptyBody` was rewritten to remove.
	'public.election.notHeld.title': "This browser doesn't hold this election.",
	'public.election.notHeld.body':
		'Nothing has been loaded into this browser for the election this link names, so there is nothing here to show.',

	// The two details-toggle summary labels. TWO KEYS ON PURPOSE, and a
	// later merge of them into one is the regression the copy test's
	// pairwise-difference assertion exists to catch. A gap card's detail
	// explains WHY THERE IS NO SOURCE; a filled card's detail explains WHAT
	// THE VALUE MEANS. The only wording that serves both -- "More detail" --
	// throws away exactly the distinction that putting the technical
	// material behind a toggle was meant to preserve. Neither may collapse
	// into the page-level `public.details.summary` either: that one is about
	// the view as a whole, not about a card.
	'public.gap.detailsSummary': "Why this isn't shown",
	'public.fact.detailsSummary': 'What this shows',

	// --- Surface 3 (56-12, D-13): the bootstrap config-fault box -----------
	//
	// Two variants, both real, distinguished by copy alone -- reusing
	// `.election-unreadable` verbatim (zero new CSS). Neither may say "this
	// browser doesn't hold this election": the real fact in both cases is
	// that this DEPLOYMENT cannot learn where to dial at all, which is a
	// different and more specific failure than an absent election record
	// (`public.election.notHeld.*` above). Both say plainly that the problem
	// is with how this page was set up, never with the reader's browser or
	// connection -- there is nothing a reader can do about either variant,
	// and neither may imply otherwise.
	'public.config.missing.title': "This page can't be configured to reach the network.",
	'public.config.missing.body':
		"The list of network addresses this page needs wasn't found, so it can't look up any election right now. This is a problem with how this page is set up, not with your browser or your connection.",
	'public.config.malformed.title': "This page's network configuration can't be read.",
	'public.config.malformed.body':
		"The list of network addresses this page needs is present but couldn't be understood, so it can't look up any election right now. This is a problem with how this page is set up, not with your browser or your connection.",
	// --- Live dashboard (66-05): pairing screen, webcam scanner, header ----
	// --- status, officer-swap and forget dialogs, unpaired notice, panel ----
	// --- action notes, network switcher, change marks ----------------------
	//
	// These keys serve the live officer dashboard and arrive ahead of the
	// screens that mount them, under the same "named by an already-planned
	// call site" warrant the 54-09 header amendment uses: `t()` throws on an
	// unknown key, so each key has to exist before the screen that renders it.
	// Every value is transcribed from the dashboard UI contract.
	//
	// `panel.readOnly.*` is an ACTION NOTE on pending items ("decide these in
	// the Authority app"), not the read-only panel STATE that contract C3
	// forbids, and neither value contains the word C3 bans.
	//
	// `marks.announceOne` is the derived singular partner of the spec's plural
	// `marks.announceMany`, following this table's separate singular and plural
	// key convention (`panelFrame.sitePill` / `panelFrame.sitesPill`).
	'pairing.title': 'Pair this browser',
	'pairing.intro':
		"In the Authority app, open Paired browsers and choose Pair a browser. Paste the code it shows, or scan its QR code with this computer's camera.",
	'pairing.cta': 'Pair this browser',
	'pairing.scanCta': 'Scan QR code',
	'pairing.fieldLabel': 'Pairing code',
	'pairing.fieldHelp':
		"Single use, valid for about 15 minutes. Keep it private until you've pasted it.",
	'pairing.emptyHeading': 'No networks yet',
	'pairing.emptyBody':
		'Pair this browser from the Authority app to follow a network live. Nothing is shown here until you do.',
	'pairing.verifying.heading': 'Checking the code',
	'pairing.verifying.body': 'Making sure the code is genuine and still valid.',
	'pairing.joining.heading': 'Joining {{authorityName}}',
	'pairing.joining.body': 'This can take a minute or two the first time.',
	'pairing.catchingUpSlow':
		'Still catching up. The data is arriving; you can leave this page open.',
	'pairing.step.connecting': 'Connecting to the network',
	'pairing.step.joining': "Joining as {{officerName}}'s browser",
	'pairing.step.first-sync': 'Catching up on the first sync',
	'pairing.stepState.waiting': 'Waiting',
	'pairing.stepState.inProgress': 'In progress',
	'pairing.stepState.done': 'Done',
	'pairing.stepState.failed': 'Failed',
	'pairing.stop': 'Stop pairing',
	'pairing.action.tryAgain': 'Try again',
	'pairing.action.tryAnother': 'Try another code',
	'pairing.action.retry': 'Retry pairing',
	'pairing.failed.malformed.heading': "That isn't a pairing code.",
	'pairing.failed.malformed.body':
		'Paste the whole code from the Authority app, or scan its QR code.',
	'pairing.failed.old-style.heading': 'This is an old sign-in code.',
	'pairing.failed.old-style.body':
		'This dashboard now pairs instead. In the Authority app, open Paired browsers and make a new code.',
	'pairing.failed.expired.heading': 'That code has expired.',
	'pairing.failed.expired.body':
		'Codes last about 15 minutes. Make a new one in the Authority app.',
	'pairing.failed.spent.heading': 'That code was already used.',
	'pairing.failed.spent.body': 'Each code works once. Make a new one in the Authority app.',
	'pairing.failed.unreachable.heading': "Couldn't reach the network.",
	'pairing.failed.unreachable.body':
		"The network's relay didn't answer. Check this computer's connection and try again. If it keeps happening, make a new code.",
	'pairing.failed.digest-mismatch.heading': "This code doesn't match the network it names.",
	'pairing.failed.digest-mismatch.body':
		"The network's records don't match what the code promised, so nothing was saved. Make a new code from the Authority app and try again; if it happens again, contact the person who runs the network.",
	'pairing.failed.officer-not-valid.heading': "That officer can't pair a browser.",
	'pairing.failed.officer-not-valid.body':
		"The officer's key in the code isn't current any more. Ask them to check their keys in the Authority app.",
	'pairing.failed.no-storage.heading': "This browser can't store the data.",
	'pairing.failed.no-storage.body':
		'Allow site storage for this page (private windows often block it) and try again.',
	'pairing.failed.unsupported.heading': "This browser isn't supported.",
	'pairing.failed.unsupported.body': 'Use a current version of Chrome, Edge, Firefox or Safari.',
	'scanner.asking':
		'Allow camera access to scan the QR code. The picture stays in this browser.',
	'scanner.denied':
		"Camera access is blocked. Allow it in the browser's site settings, or paste the code instead.",
	'scanner.noCamera': 'No camera found. Paste the code instead.',
	'scanner.insecureContext':
		'The camera needs a secure connection (https). Paste the code instead.',
	'scanner.instruction': 'Hold the QR code inside the frame, about 30 cm from the camera.',
	'scanner.found': 'Code found.',
	'scanner.notPairingCode':
		"That QR code isn't a pairing code. Keep scanning or paste the code.",
	'scanner.close': 'Close scanner',
	'scanner.pasteInstead': 'Paste the code instead',
	'status.chip.live': 'Live',
	'status.chip.catching-up': 'Catching up',
	'status.chip.offline': 'Offline · last update {{time}}',
	'status.chip.offline-no-update': 'Offline · no update yet',
	'status.chip.not-live': 'Not live',
	'status.title.live': 'Connected and up to date. Last checked at {{time}}',
	'status.title.catching-up': 'Connected. Newer data is still arriving.',
	'status.reconnect': 'Reconnect',
	'status.reconnecting': 'Reconnecting…',
	'status.followerNote':
		"This network is open in another tab. This tab shows its last data and doesn't update.",
	'swap.heading': 'Replace {{oldOfficer}} with {{newOfficer}} on this browser?',
	'swap.body':
		"This browser is paired as {{oldOfficer}} for {{authorityName}}. Continuing deletes {{oldOfficer}}'s pairing and this browser's local copy of the data, then pairs it as {{newOfficer}}. {{oldOfficer}}'s pairing may still be listed in their Authority app until they remove it.",
	'swap.confirm': 'Replace and continue',
	'swap.keep': 'Keep {{oldOfficer}}',
	'forget.cta': 'Forget this network',
	'forget.heading': 'Forget {{authorityName}} on this browser?',
	'forget.body':
		"This deletes this browser's pairing key and its local copy of {{authorityName}}'s data from this browser. It doesn't remove this browser from the network: do that in the Authority app under Paired browsers. Data this browser has already received may remain in other places, such as backups. Type {{authorityName}} to confirm.",
	'forget.fieldLabel': 'Network name',
	'unpaired.heading': 'This browser was unpaired.',
	'unpaired.body.revoked':
		"{{officerName}} removed it in the Authority app, so its local copy of {{authorityName}}'s data was deleted from this browser. Pair again with a new code to follow the network.",
	'unpaired.body.removed':
		'This browser was removed from the network, so its local copy was deleted from this browser.',
	'unpaired.body.key-invalid':
		"{{officerName}}'s key is no longer valid, so this browser was unpaired and its local copy deleted.",
	'unpaired.dismiss': 'Dismiss',
	'panel.readOnly.short': 'Taken in the Authority app.',
	'panel.readOnly.long': 'This dashboard only shows these. Decide them in the Authority app.',
	'switcher.rowDetail': '{{domain}} · {{officerName}}',
	'switcher.rowDetailNotSyncing': '{{domain}} · {{officerName}} · Not syncing',
	'switcher.opening': 'Opening {{authorityName}}…',
	'switcher.pairAnother': '+ Pair another network',
	'shell.openFailed':
		'Something went wrong opening this network. Reconnect, or forget it and pair again.',
	'marks.updated': 'updated',
	'marks.announceOne': '{{count}} item updated in {{panel}}',
	'marks.announceMany': '{{count}} items updated in {{panel}}',
	// --- Live dashboard gaps (66-22): states the UI contract's copy table ---
	// --- does not cover --------------------------------------------------
	//
	// Five keys found missing while building the pairing screen, the webcam
	// scanner and the forget dialog. Each fills a state or a datum the
	// contract's table leaves open:
	//
	// `pairing.step.joiningUnnamed` -- the pairing code carries no officer
	// name, so the named `pairing.step.joining` row is used only when a name
	// is known (from an accepted officer swap); this is the unnamed row.
	//
	// `pairing.officerUnknown` -- the fallback for `{{officerName}}`,
	// `{{oldOfficer}}` and `{{newOfficer}}` when the local copy holds no name
	// for that officer.
	//
	// `pairing.failed.no-storage.otherTab` -- a delete blocked by another tab
	// that holds the same network also resolves as no-storage; this extra line
	// names that cause when the browser's lock list shows it.
	//
	// `scanner.unavailable` -- the camera is busy, the request was aborted, or
	// the decoder failed to load: none of the other scanner states fits.
	//
	// `forget.failed` -- the forget dialog's failure line (a teardown blocked
	// by another tab is the usual cause).
	'pairing.step.joiningUnnamed': "Joining as the officer's browser",
	'pairing.officerUnknown': 'Unnamed officer',
	'pairing.failed.no-storage.otherTab':
		'This network is open in another tab. Close that tab and try again.',
	'scanner.unavailable': "The scanner couldn't start. Paste the code instead.",
	'forget.failed':
		"Couldn't forget this network. Close any other tab that has it open, then try again.",
});

/**
 * Look up `key` in `COPY` and interpolate `{{name}}` placeholders from `params`.
 *
 * Throws if `key` is unknown (naming the key) or if any `{{placeholder}}` survives
 * interpolation (naming the first unresolved placeholder) -- this project's rule is
 * that a rejection names the reason.
 *
 * @param {string} key
 * @param {Record<string, unknown>} [params]
 * @returns {string}
 */
export function t(key, params = {}) {
	const template = COPY[key];
	if (typeof template !== 'string') {
		throw new Error(`t(): unknown copy key "${key}"`);
	}

	const interpolated = template.replace(/\{\{(\w+)\}\}/g, (match, name) => {
		// Leave the placeholder untouched when the param is missing, so the
		// unresolved-placeholder check below can name it. Replacing a missing
		// param with the literal string "undefined" would silently swallow the
		// gap that check exists to catch.
		return name in params ? String(params[name]) : match;
	});

	const unresolved = interpolated.match(/\{\{(\w+)\}\}/);
	if (unresolved) {
		throw new Error(
			`t(): unresolved placeholder "{{${unresolved[1]}}}" in copy key "${key}" -- missing param "${unresolved[1]}"`,
		);
	}

	return interpolated;
}
