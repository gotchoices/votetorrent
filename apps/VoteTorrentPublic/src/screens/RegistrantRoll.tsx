import { t } from '@votetorrent/ui-web';
import { ROLL_DISCLOSURE_POLICY, resolveRollColumns } from '../roll-disclosure.js';

/**
 * RegistrantRoll.tsx — the published voter roll: three columns, inline, for a
 * reader with no login, no identity and no device key (D-18, D-19, D-20,
 * D-23).
 *
 * Seven things a later reader cannot infer from the code alone.
 *
 * 1. IT RENDERS INLINE, WITH NOTHING TO CLICK FIRST (D-20). There is no
 *    disclosure component anywhere below and there must never be one. A roll
 *    a reader has to open is a roll most readers never see, and the whole
 *    point of publishing it is that an anonymous visitor can check who is
 *    registered without asking anyone for anything.
 *
 * 2. THE DISCLAIMER RENDERS VISIBLY, ABOVE THE DATA, AND UNCONDITIONALLY —
 *    a DELIBERATE DEPARTURE from the convention one file over, where a fact's
 *    detail text sits behind the shared toggle. The disclaimer states what
 *    this page does NOT show. A page whose whole subject is honest gaps must
 *    not make its own limitation less visible than the data it publishes, so
 *    this one sentence is promoted out of the collapsible. This is also why
 *    the fact body must not ALSO route this fact's detail key through the
 *    toggle: it would render the same sentence twice.
 *
 * 3. THE FAIL-CLOSED STATEMENT RENDERS HERE, NOT IN THE RULES CARD. The
 *    UI-SPEC drafted `public.rules.policyUnreadable` as a rules-card string.
 *    The omission it explains happens in this table, and three group sections
 *    away the statement would no longer be attached to the column it is
 *    about — a reader would see a table with a column missing and a sentence
 *    elsewhere about "a field", with nothing joining them. The key NAME is
 *    unchanged, so the copy table needs no edit. It renders ONCE rather than
 *    once per withheld field, because the shipped sentence is singular in
 *    form and pluralising it would be page-authored copy.
 *
 * 4. THE CLASS NAMES ARE 54-09'S, AND `registrant-roll__note` IS THE RIGHT
 *    ONE FOR ALL THREE SENTENCES. 54-09 declared that rule for "the
 *    disclaimer and the empty message" — Label size, muted — and the
 *    fail-closed statement is the same kind of sentence about the same table.
 *    Both class attributes below are STATIC LITERALS and must stay that way:
 *    the class-coverage gate matches only brace-free `className="..."`
 *    attributes, so a computed one makes it structurally blind, and an
 *    unstyled class is the defect class this repo has shipped twice past
 *    green gates.
 *
 * 5. NOTHING HERE COLLAPSES, FILTERS, SORTS OR DEDUPES `rows`. The roll is
 *    rendered verbatim and in order. The read layer pins each registrant to
 *    its CURRENT public record; if that pin were ever dropped, a registrant
 *    whose record was reissued would appear twice — and this component must
 *    make that VISIBLE rather than papering it over into a plausible-looking
 *    list. The render layer cannot tell which of two rows is current, so it
 *    must not pretend to.
 *
 * 6. A CELL RENDERS ONLY A STRING. All three published columns are nullable
 *    text in the schema, and the values are authority-supplied with no
 *    content constraints at all. A non-string reaching a React child is
 *    either a crash or a rendered object, so the coercion is the value-level
 *    half of failing closed. There is deliberately NO placeholder glyph or
 *    word for an absent value: any such substitute would be page-authored
 *    copy about a named person, and would then have to come from the shared
 *    copy table, for which no key exists. An empty cell still reads as a cell
 *    because 54-09's cell rule carries a bottom border.
 *
 * 7. THE HEADER TEXT IS THE SCHEMA FIELD NAME ITSELF. This is the one place a
 *    raw schema identifier is exempt from the copy table, precedent-matched
 *    to the dashboard's elections panel. It comes from a variable, so it sits
 *    inside a JSX expression container — which is also what keeps the copy
 *    lint's text-run matcher from reading it as hard-coded prose.
 *
 * This component FETCHES NOTHING. It receives rows and imports nothing that
 * could reach a database. Authority-supplied text reaches the DOM only as a
 * JSX text node, where React's default escaping applies; there is no
 * raw-HTML escape hatch here and there must never be one.
 */

/**
 * One published roll row. Indexed by column NAME rather than declared with
 * three named fields, deliberately: the cells are read through the resolved
 * column list, so a key outside that list is never indexed and a widened
 * upstream select cannot widen the page.
 */
export type RegistrantRollRow = Readonly<Record<string, unknown>>;

export interface RegistrantRollProps {
	/** The published rows, or `null` when none could be read. Both render the
	 * same honest empty state — this page surfaces no error class and no row
	 * content in copy. */
	rows: ReadonlyArray<RegistrantRollRow> | null;
	/** The page's declared disclosure policy. INJECTABLE for the same reason
	 * the shell's own seams are: a fault branch nothing can reach in a test is
	 * a branch nobody has proven works, and every one of D-23's fault modes
	 * lives behind this prop. Production never passes it. */
	policy?: unknown;
}

export function RegistrantRoll({ rows, policy = ROLL_DISCLOSURE_POLICY }: RegistrantRollProps) {
	const { columns, unreadable } = resolveRollColumns(policy);
	const hasRows = rows !== null && rows.length > 0;
	const showTable = columns.length > 0 && hasRows;

	return (
		<>
			<p className="registrant-roll__note">{t('public.registrantRoll.disclaimer')}</p>
			{showTable ? (
				<div className="registrant-roll">
					<table>
						<thead>
							<tr>
								{columns.map((column) => (
									<th key={column}>{column}</th>
								))}
							</tr>
						</thead>
						<tbody>
							{(rows ?? []).map((row, index) => (
								<tr key={index}>
									{columns.map((column) => (
										<td key={column}>{typeof row[column] === 'string' ? (row[column] as string) : ''}</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : null}
			{hasRows ? null : <p className="registrant-roll__note">{t('public.registrantRoll.empty')}</p>}
			{unreadable.length > 0 ? <p className="registrant-roll__note">{t('public.rules.policyUnreadable')}</p> : null}
		</>
	);
}

export default RegistrantRoll;
