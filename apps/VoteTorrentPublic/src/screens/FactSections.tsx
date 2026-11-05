import { t } from '@votetorrent/ui-web';
import { BarSeries, DetailsToggle, Meter } from '@votetorrent/ui-web/components';
import { groupFactsForPhase } from '../fact-groups.js';
import { foldDistrictCounts } from '../roll-disclosure.js';
import { RegistrantRoll } from './RegistrantRoll';
import type { RegistrantRollRow } from './RegistrantRoll';

/**
 * FactSections.tsx — the body of the public election page: the facts, and,
 * just as prominently PLACED but far less prominently STYLED, the gaps
 * (D-11, D-12, D-14, D-16, D-35).
 *
 * Six things a later reader cannot infer from the code alone:
 *
 * 1. WHY THE GAP MODIFIER IS WRITTEN AS TWO LITERAL BRANCHES AND NEVER AS A
 *    TEMPLATE LITERAL. `scripts/lib/css-class-coverage.mjs`'s
 *    `extractStaticClassNameTokens` matches only brace-free
 *    `className="..."` attributes. A COMPUTED class attribute therefore makes
 *    the tier-1 class-coverage gate structurally BLIND to the gap modifier,
 *    and a mounted class with no matching selector is exactly the defect class
 *    this repo has already shipped twice past green gates — a code clipped at
 *    84 characters, and a whole screen rendered with no styling at all, both
 *    of which passed every gate because the gates asserted PRESENCE. The
 *    duplication between the two branches below IS the gate's evidence. Do not
 *    "clean it up" into a computed string.
 *
 * 2. WHY EVERY CARD CARRIES THE TWO `data-fact-*` ATTRIBUTES BELOW — a stable
 *    per-card identity, and the branch it took. (Named by prefix here rather
 *    than spelled out, so a raw grep for either attribute counts the two
 *    render sites and not this paragraph: a checker whose own prose satisfies
 *    the pattern it hunts is permanently green, and this phase has
 *    manufactured that failure seven times.) The browser
 *    tier must select one gap card and one filled card FROM THE SAME RENDERED
 *    PAGE and compare their computed styles; that comparison is the only thing
 *    that can prove the three de-emphasis cues actually reach a reader.
 *    Presence is not rendering, and no source scan in this repo can substitute
 *    for that assertion — a stable selector is what makes it writable at all.
 *    The `settling` phase renders both kinds together, which is why it is the
 *    phase that gate should use.
 *
 * 3. D-12: the plain human sentence is ON the card; the technical reason and
 *    its `doc/election.md` citation are behind the SHARED `DetailsToggle`.
 *    There is no second disclosure component anywhere in this file — building
 *    a parallel `<details>` element or a hand-rolled toggle would fork the
 *    D-19 React-identity gate's subject, whose whole value is that it is the
 *    one hook-calling component on the page.
 *
 * 4. D-12, the other half: the internal gap letters A-G are spike vocabulary
 *    and appear NOWHERE in this file. The `gap` / `filledGap` fields select a
 *    BRANCH; they are never interpolated, never rendered and never passed to
 *    `t()`. The repo has a standing rule against internal identifiers in
 *    user-facing strings, and a letter on a card would be one.
 *
 * 5. D-14: `keyrelease` takes the FILLED branch because its `gap` is `null`.
 *    There is no id-specific check anywhere below — the data decides, so a
 *    future entry that gains a `filledGap` renders correctly with no edit
 *    here. The key-release body is selected on `interpolates !== null` for the
 *    same reason. `facts.js` guarantees `keyrelease` is the only entry with a
 *    non-null `interpolates`; if that ever changed, `t()` would throw loudly
 *    on the missing parameter rather than rendering a wrong sentence, and that
 *    loud failure is the intended behaviour.
 *
 * 6. THE DENOMINATOR ON SCREEN IS `keyholderCount`, NOT `total`. `total`
 *    counts release-key work items, which is ZERO before any is raised — so a
 *    denominator taken from it would read "0 of 0" for the entire settling
 *    window, indistinguishable from a genuinely empty election
 *    (`54-RESEARCH.md` Pitfall 4, and `read-keyrelease.js`'s own JSDoc). The
 *    interpolation PARAMETER is still named `total`, because that is the
 *    placeholder 54-09's sentence declares and 54-04 froze in `interpolates`;
 *    renaming it would make `t()` throw. The name is the sentence's, the value
 *    is the keyholder count's.
 *
 * 7. THE ROLL BRANCH IS SELECTED ON THE DATA TOO, and the field it reads is
 *    `emptyKey`. That field means "this fact's body is a COLLECTION, which
 *    can legitimately be empty" -- exactly one entry in the model carries it,
 *    and the model is what makes that true rather than a hard-coded id here.
 *    A card whose body is a table also owns its own detail sentence and its
 *    own empty message, so BOTH the generic details toggle and the generic
 *    empty path are suppressed on this branch: the roll renders its
 *    disclaimer visibly above the table, and a second mount through the
 *    toggle would show the same sentence twice. Selecting on the id instead
 *    would put a render decision somewhere the model cannot see it, which is
 *    the same mistake point 5 rejects for the key-release branch.
 *
 * A FAULT IS NOT AN ABSENCE. When the key-release aggregate could not be
 * read, the card still renders and SAYS SO (D-23, applied to the one fact on
 * this page carrying live data). Dropping the card would make a read fault
 * indistinguishable from a deliberate withholding, which is the failure class
 * this whole phase exists to correct.
 *
 * No hook of any kind lives here: the only stateful behaviour on these cards
 * is `DetailsToggle`'s own. Every rendered string is a `t()` call — a literal
 * English run in JSX is a defect `scripts/lint-copy.mjs` fails on. No
 * `dangerouslySetInnerHTML`: authority-supplied text reaches the DOM only as a
 * JSX text node, where React's default escaping applies.
 */

/** The three numbers D-14 permits to cross from the data package into the
 * render layer. Never a row, never an identifier — see this file's point 5. */
export interface KeyReleaseProgress {
	released: number;
	total: number;
	keyholderCount: number;
}

/** The renderable projection of a `facts.js` entry. Only the four copy-key
 * fields, the branch predicate and the id — `source`, `filledGap` and the
 * phase list are provenance for a code reader and are not consumed here. */
interface FactEntryView {
	id: string;
	labelKey: string;
	sentenceKey: string | null;
	detailKey: string | null;
	/** Non-null only for a fact whose body is a collection -- see header
	 * point 7. It is the branch predicate for the roll, never rendered here:
	 * the component that owns the collection owns its empty message too. */
	emptyKey: string | null;
	interpolates: ReadonlyArray<string> | null;
	gap: string | null;
}

export interface FactSectionsProps {
	/** The derived lifecycle phase id, or `null`/`indeterminate` when the
	 * schedule could not be read — in which case nothing renders and 54-12's
	 * explicit unknown headline stands alone. */
	phase: string | null;
	/** `null` when the aggregate could not be read, or when no database was
	 * opened at all. */
	keyRelease: KeyReleaseProgress | null;
	/** The published voter roll, or `null` when it could not be read or no
	 * database was opened. Passed straight through to the roll card, which
	 * renders the same honest empty state for both. */
	roll: ReadonlyArray<RegistrantRollRow> | null;
}

/**
 * The card's body text. Returns `null` for a label-only fact, which renders a
 * label and nothing more rather than an empty paragraph.
 */
function factBody(fact: FactEntryView, keyRelease: KeyReleaseProgress | null): string | null {
	if (fact.interpolates !== null && fact.sentenceKey !== null) {
		// The fail-closed branch (D-23). Its own key, because `t()` throws on an
		// unresolved placeholder and the sentence key cannot be reused with
		// absent counts.
		if (keyRelease === null) return t('public.fact.keyrelease.unreadable');
		// `total:` is the PLACEHOLDER's name; `keyholderCount` is the value.
		// See this file's header point 6 before changing either side.
		return t(fact.sentenceKey, { released: keyRelease.released, total: keyRelease.keyholderCount });
	}
	if (fact.sentenceKey === null) return null;
	return t(fact.sentenceKey);
}

/** Margins plus the numeric axis Recharts reserves for itself. This is fixed
 * overhead: it is spent once, not once per row, so it has to sit OUTSIDE the
 * per-row term. Folding it in was the original defect -- at three rows the
 * whole chart was 84px, of which ~46px was chrome, leaving ~12.7px of category
 * band per row for labels that need three times that. */
const ROLL_CHART_FIXED_CHROME_PX = 46;
/** One row's category band. A production-length district name wraps to three
 * lines in the axis width below, and each line needs ~13px. A bar is still
 * ≤24px thick (60-03's `MAX_BAR_THICKNESS_PX`); this is the LABEL's budget,
 * which is the larger of the two and therefore the one that sets the row. */
const ROLL_CHART_PER_ROW_PX = 40;
/** The UI-SPEC caps C7 so the chart cannot dominate its fact card. The cap is
 * expressed in rows rather than a bare pixel count so it stays meaningful if
 * the per-row budget changes. */
const ROLL_CHART_MAX_ROWS = 6;
const ROLL_CHART_MAX_HEIGHT_PX = ROLL_CHART_FIXED_CHROME_PX + ROLL_CHART_MAX_ROWS * ROLL_CHART_PER_ROW_PX;
/** Two rows, so a one- or two-bar chart is not a sliver. */
const ROLL_CHART_MIN_HEIGHT_PX = ROLL_CHART_FIXED_CHROME_PX + 2 * ROLL_CHART_PER_ROW_PX;
/** The band reserved for district names on the category axis, so a
 * production-length name has somewhere to go. */
const ROLL_CHART_CATEGORY_AXIS_PX = 140;

/**
 * One card. Two sibling branches whose class attributes are STATIC LITERALS,
 * selected by `gap !== null`. They differ only in the class attribute, the
 * `data-fact-kind` value and the details summary key — deliberately identical
 * otherwise, so a computed-style comparison between them isolates styling
 * rather than structure.
 *
 * Multiple `return` statements are fine here: case 1's single-return rule is
 * scoped to `ElectionShell.tsx`, which is exactly why this component lives in
 * a different file.
 */
function FactCard({
	fact,
	keyRelease,
	roll,
}: {
	fact: FactEntryView;
	keyRelease: KeyReleaseProgress | null;
	roll: ReadonlyArray<RegistrantRollRow> | null;
}) {
	const body = factBody(fact, keyRelease);
	// Header point 7: a collection card owns its own detail sentence and its
	// own empty message, so the generic toggle below is suppressed for it.
	const rendersCollection = fact.emptyKey !== null;
	// The same predicate `factBody` already uses to select the key-release
	// card -- it selects WHICH card, exactly as header point 5 requires, and
	// introduces no new state branch.
	const rendersKeyRelease = fact.interpolates !== null && fact.sentenceKey !== null;
	const districtBuckets = rendersCollection ? foldDistrictCounts(roll) : [];

	if (fact.gap !== null) {
		return (
			<article className="fact-card fact-card--gap" data-fact-id={fact.id} data-fact-kind="gap">
				<h3 className="fact-card__label">{t(fact.labelKey)}</h3>
				{body === null ? null : <p className="fact-card__body">{body}</p>}
				{fact.detailKey === null ? null : (
					<DetailsToggle summary={t('public.gap.detailsSummary')}>{t(fact.detailKey)}</DetailsToggle>
				)}
			</article>
		);
	}

	return (
		<article className="fact-card" data-fact-id={fact.id} data-fact-kind="fact">
			<h3 className="fact-card__label">{t(fact.labelKey)}</h3>
			{body === null ? null : <p className="fact-card__body">{body}</p>}
			{rendersKeyRelease && keyRelease !== null ? (
				<div className="fact-card__chart">
					<Meter
						value={keyRelease.released}
						total={keyRelease.keyholderCount}
						variant="compact"
						emptyCopyKey="public.fact.keyrelease.meterEmpty"
					/>
				</div>
			) : null}
			{rendersCollection ? <RegistrantRoll rows={roll} /> : null}
			{districtBuckets.length > 0 ? (
				<div className="fact-card__chart">
					<BarSeries
						data={districtBuckets.map((bucket) => {
							const label = bucket.label ?? t('public.registrantRoll.chart.otherBucket');
							return {
								key: bucket.key,
								label,
								value: bucket.count,
								tooltip: t('public.registrantRoll.chart.tooltip', { district: label, count: String(bucket.count) }),
							};
						})}
						orientation="horizontal"
						defaultTone="series-1"
						categoryAxisWidth={ROLL_CHART_CATEGORY_AXIS_PX}
						height={Math.min(
							ROLL_CHART_MAX_HEIGHT_PX,
							Math.max(
								ROLL_CHART_MIN_HEIGHT_PX,
								ROLL_CHART_FIXED_CHROME_PX + districtBuckets.length * ROLL_CHART_PER_ROW_PX,
							),
						)}
					/>
				</div>
			) : null}
			{fact.detailKey === null || rendersCollection ? null : (
				<DetailsToggle summary={t('public.fact.detailsSummary')}>{t(fact.detailKey)}</DetailsToggle>
			)}
		</article>
	);
}

/**
 * The four groups, in the model's own order, each holding its phase's facts in
 * declaration order. Returns `null` when the phase carries no facts, so an
 * unreadable schedule shows the explicit unknown headline and no empty
 * scaffolding beneath it.
 *
 * No wrapper element, no `role`, no `aria-busy` and no `aria-live`: this page
 * has no loading semantics of its own, and the shell is already held to that
 * rule one file over.
 */
export function FactSections({ phase, keyRelease, roll }: FactSectionsProps) {
	const groups = groupFactsForPhase(phase);
	if (groups.length === 0) return null;

	return (
		<>
			{groups.map((group) => (
				<section className="fact-section" key={group.group} data-fact-group={group.group}>
					<h2 className="fact-section__heading">{t(group.headingKey)}</h2>
					{group.facts.map((fact: FactEntryView) => (
						<FactCard fact={fact} keyRelease={keyRelease} roll={roll} key={fact.id} />
					))}
				</section>
			))}
		</>
	);
}

export default FactSections;
