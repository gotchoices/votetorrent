/**
 * ElectionsPanel.tsx -- the `mel` panel body plus the computed lifecycle
 * pill mount point.
 *
 * Live: the read effect re-runs whenever the replicated data version moves,
 * so rows that arrive from other devices land in place with no click and no
 * reload. A re-read keeps the rows already on screen until the new ones
 * arrive (only a different database handle resets to the empty state), and a
 * failed re-read keeps the last good rows. Every rendered row and figure is
 * keyed into one live change-mark hook, so a changed value carries the mark
 * and the hidden word "updated"; the panel chrome owns the header mark and
 * the grid owns the screen-reader summary, so neither is rendered here.
 *
 * The lifecycle pill and the timeline's past/current classes compare against
 * a coarse clock (`useNow`), so the pill crosses a deadline while the
 * dashboard stays open. The clock never enters a mark signature: marks follow
 * replicated data, not the passage of time.
 *
 * Renders no control of any kind (rule R2) and issues its own reads from an
 * effect against `props.db` (rule R6) -- see `RegistrationsPanel.tsx`'s
 * header for the shared reasoning.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { PanelComponent } from './types.js';
import { t } from '@votetorrent/ui-web';
import {
	selectActiveElection,
	readElectionOverview,
	readElectionPolicies,
	countElections,
} from '@votetorrent/web-data/officer';
import { ELECTION_EVENT_ORDER, derivePhase } from '@votetorrent/ui-web/lifecycle';
import { toCanonicalDatetime } from '@votetorrent/vote-engine/browser';
import { LifecyclePill } from '@votetorrent/ui-web/components';
import { useDataVersion } from '../../live/DataVersionContext.js';
import { useChangeMarks, ChangeMarkWord } from '../../live/useChangeMarks.js';
import { useNow } from '../../live/useNow.js';
import './election-ops.css';

const EM_DASH = '—';

// The REDUNDANT NON-COLOUR CUE for the marked timeline row. The
// `.eo-tl--current` class carries the colour/weight half of the signal; this
// marker carries the half that survives greyscale, colour-blindness and a
// screenshot pasted into a monochrome report. Both are required -- a
// class-driven colour change alone is not a cue every officer can perceive.
const STAGE_MARKER = '→ ';
const CANONICAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

// Field labels reproduced VERBATIM from the schema (rule R1), rendered as
// JSX EXPRESSIONS, never as literal JSX text.
const COL = Object.freeze({
	type: 'Type',
	date: 'Date',
	revisionDeadline: 'RevisionDeadline',
	ballotDeadline: 'BallotDeadline',
	revision: 'Revision',
	revisionTimestamp: 'RevisionTimestamp',
	keyholderThreshold: 'KeyholderThreshold',
	tags: 'Tags',
	registrationFieldCount: 'ElectionRegistrationField',
	disclosurePolicyCount: 'ElectionDisclosurePolicy',
	attestationRequired: 'AttestationRequired',
});

/**
 * Normalise one raw `Timeline` event value for display/comparison. Never
 * throws: an un-normalisable value (or an absent event) resolves to `null`,
 * and the caller renders the em dash for it.
 */
function normalizeTimelineValue(raw: unknown): string | null {
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== 'string' && typeof raw !== 'number') return null;
	const normalized = toCanonicalDatetime(raw);
	return CANONICAL_RE.test(normalized) ? normalized : null;
}

/** The raw Timeline column as an event map; anything unreadable is an empty map. Never throws. */
function parseTimeline(raw: unknown): Record<string, unknown> {
	try {
		const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
		if (parsed && typeof parsed === 'object') {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// An unreadable Timeline renders every event as the em dash.
	}
	return {};
}

interface ElectionsData {
	active: NonNullable<Awaited<ReturnType<typeof selectActiveElection>>>;
	overview: NonNullable<Awaited<ReturnType<typeof readElectionOverview>>>;
	policies: Awaited<ReturnType<typeof readElectionPolicies>>;
	totalElections: number;
}

interface ElectionsState {
	loading: boolean;
	data: ElectionsData | null;
}

// --- Live change marks (UI-SPEC "2. In-place change mark") -------------------

type MarkRow = { key: string; sig: string };
const markKey = (row: MarkRow) => row.key;
const markSig = (row: MarkRow) => row.sig;

/** `base` alone when there is no mark, else `base` plus the mark classes. */
function withMark(base: string, mark: string): string {
	return mark ? `${base} ${mark}` : base;
}

type KvValue = string | number | null | undefined;

/** The key/value list exactly as rendered, label first. */
function electionKvPairs(data: ElectionsData): Array<[string, KvValue]> {
	const { active, overview } = data;
	return [
		[COL.type, active.TypeName ?? EM_DASH],
		[COL.date, active.Date],
		[COL.revisionDeadline, active.RevisionDeadline],
		[COL.ballotDeadline, active.BallotDeadline],
		[COL.revision, overview.Revision],
		[COL.revisionTimestamp, overview.RevisionTimestamp],
		[COL.keyholderThreshold, overview.KeyholderThreshold],
		[COL.tags, overview.Tags.join(', ')],
	];
}

/** The three count figures exactly as rendered, label first. */
function electionCountPairs(data: ElectionsData): Array<[string, KvValue]> {
	const { policies } = data;
	return [
		[COL.registrationFieldCount, policies.registrationFieldCount],
		[COL.disclosurePolicyCount, policies.disclosurePolicyCount],
		[COL.attestationRequired, policies.attestationRequired ?? EM_DASH],
	];
}

/**
 * One mark row per rendered row or figure. Signatures cover exactly what is
 * displayed; the lifecycle phase and the clock are deliberately left out.
 */
function buildElectionMarkRows(data: ElectionsData): MarkRow[] {
	const { active, overview, policies, totalElections } = data;
	const rows: MarkRow[] = [{ key: 'title', sig: JSON.stringify([active.Title]) }];
	for (const [label, value] of electionKvPairs(data)) {
		rows.push({ key: `kv:${label}`, sig: JSON.stringify([value]) });
	}
	const timeline = parseTimeline(overview.Timeline);
	for (const event of ELECTION_EVENT_ORDER) {
		rows.push({ key: `tl:${event}`, sig: JSON.stringify([normalizeTimelineValue(timeline[event]) ?? EM_DASH]) });
	}
	rows.push({ key: 'instructions', sig: JSON.stringify([overview.Instructions]) });
	for (const [label, value] of electionCountPairs(data)) {
		rows.push({ key: `count:${label}`, sig: JSON.stringify([value]) });
	}
	for (const row of policies.registrationFieldBreakdown) {
		rows.push({
			key: `breakdown:${row.Tier}-${row.Requirement}`,
			sig: JSON.stringify([row.TierName, row.RequirementName, row.Count]),
		});
	}
	if (totalElections > 1) {
		rows.push({ key: 'elections', sig: JSON.stringify([`1 / ${totalElections}`]) });
	}
	return rows;
}

const ElectionsPanel: PanelComponent = ({ capability, db }) => {
	const { version } = useDataVersion();
	const nowMs = useNow();
	const readDbRef = useRef<unknown>(undefined);
	const [state, setState] = useState<ElectionsState>({ loading: true, data: null });

	useEffect(() => {
		let cancelled = false;
		const dbChanged = readDbRef.current !== db;
		readDbRef.current = db;

		if (!db) {
			setState({ loading: false, data: null });
			return () => {
				cancelled = true;
			};
		}

		// A version bump keeps the rows on screen until the new ones arrive;
		// only a different database handle starts again from the empty state.
		if (dbChanged) setState({ loading: true, data: null });

		const boundDb = db;
		(async () => {
			try {
				const active = await selectActiveElection(boundDb);
				if (!active) {
					if (!cancelled) setState({ loading: false, data: null });
					return;
				}
				const overview = await readElectionOverview(boundDb, active.Id);
				if (!overview) {
					if (!cancelled) setState({ loading: false, data: null });
					return;
				}
				const policies = await readElectionPolicies(boundDb, active.Id);
				const totalElections = await countElections(boundDb);
				if (!cancelled) {
					setState({ loading: false, data: { active, overview, policies, totalElections } });
				}
			} catch (err) {
				// The error CLASS only, never the message. `err` comes from a query
				// against tables full of registrant information, and Quereus and its
				// constraint layer routinely embed the offending row and column values
				// in an error message. The browser console is a durable, exportable,
				// screenshot-able sink; a message must name table names, column names
				// and integer counts only.
				// eslint-disable-next-line no-console
				console.error('ElectionsPanel: a read failed:', (err as { name?: string })?.name ?? 'Error');
				// A failed re-read keeps the last good rows on screen.
				if (!cancelled) setState((prev) => (dbChanged ? { loading: false, data: null } : prev));
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [db, version]);

	// null while not loaded (never an empty list, which would read as "every
	// row was deleted"); an empty list is the genuine loaded-and-empty state.
	const markRows = useMemo(() => (!db || state.loading ? null : state.data ? buildElectionMarkRows(state.data) : []), [db, state]);
	const marks = useChangeMarks(markRows, markKey, markSig);

	if (!db || state.loading || !state.data) {
		return <p className="panel-empty">{t(capability.emptyKey)}</p>;
	}

	const { active, overview, policies, totalElections } = state.data;
	const atCanonical = toCanonicalDatetime(nowMs);
	// `overview.Timeline` is passed UNMODIFIED: it is the raw column value, a
	// JSON string in practice, and `derivePhase` parses it itself.
	// The first argument is the SCHEMA-ENFORCED cross-check row -- it can only
	// populate the result's cross-check diagnostics, never change the phase.
	//
	// Only `{ phase, stage }` is taken. The derivation also returns a populated
	// cross-check array and two machine diagnostics; those are DELIBERATELY not
	// rendered. They embed raw, unvalidated Timeline values and English authored
	// outside the copy table, and an officer-facing timeline-discrepancy view is
	// broader work nobody has sized. This omission is a decision, not an
	// oversight.
	//
	// No local default of any kind: an undecidable timeline must reach
	// `LifecyclePill` untouched so the unknown pill renders. Rendering a
	// confident phase because a cut-off was absent from an unconstrained blob is
	// the worst output this panel can produce.
	const { phase, stage } = derivePhase(
		{ date: active.Date, ballotDeadline: active.BallotDeadline },
		overview.Timeline,
		atCanonical,
	);

	const timeline = parseTimeline(overview.Timeline);
	const electionsFigure = `1 / ${totalElections}`;
	const kvPairs = electionKvPairs(state.data);
	const countPairs = electionCountPairs(state.data);

	return (
		<>
			<section className="eo-section">
				<div className={withMark('eo-row', marks.markClass('title'))}>
					<span>{active.Title}</span>
					<LifecyclePill phase={phase} />
					{marks.isMarked('title') ? <ChangeMarkWord /> : null}
				</div>
			</section>

			<section className="eo-section">
				<dl className="eo-kv">
					{kvPairs.map(([label, value]) => {
						const key = `kv:${label}`;
						return (
							<Fragment key={label}>
								<dt>{label}</dt>
								<dd className={marks.markClass(key) || undefined}>
									{value}
									{marks.isMarked(key) ? <ChangeMarkWord /> : null}
								</dd>
							</Fragment>
						);
					})}
				</dl>
			</section>

			<section className="eo-section">
				<ul className="eo-timeline">
					{ELECTION_EVENT_ORDER.map((event) => {
						const normalized = normalizeTimelineValue(timeline[event]);
						const display = normalized ?? EM_DASH;
						const isPast = normalized !== null && normalized < atCanonical;
						// The newest published cut-off that has already passed. It says
						// exactly that and nothing more: it is a fact about the authority's
						// published schedule, never about what was counted, checked or
						// declared -- no such table exists to read.
						const isCurrent = normalized !== null && event === stage;
						// The mark sits on the value span, not the list item: the current
						// item paints its own background, which would hide the mark tint.
						const key = `tl:${event}`;
						return (
							<li key={event} className={isCurrent ? 'eo-tl--current' : isPast ? 'eo-tl--past' : 'eo-tl--future'}>
								<span>{isCurrent ? `${STAGE_MARKER}${event}` : event}</span>
								<span className={marks.markClass(key) || undefined}>
									{display}
									{marks.isMarked(key) ? <ChangeMarkWord /> : null}
								</span>
							</li>
						);
					})}
				</ul>
			</section>

			<section className="eo-section">
				<p className={withMark('eo-datum', marks.markClass('instructions'))}>
					{overview.Instructions}
					{marks.isMarked('instructions') ? <ChangeMarkWord /> : null}
				</p>
			</section>

			<section className="eo-section">
				<div className="eo-count-grid">
					{countPairs.map(([label, value]) => {
						// The mark sits on the value span, not the grid cell: the cell
						// paints its own background, which would hide the mark tint.
						const key = `count:${label}`;
						return (
							<div key={label}>
								<span className="eo-datum">{label}</span>
								<span className={marks.markClass(key) || undefined}>
									{value}
									{marks.isMarked(key) ? <ChangeMarkWord /> : null}
								</span>
							</div>
						);
					})}
				</div>
				{policies.registrationFieldBreakdown.map((row) => {
					const key = `breakdown:${row.Tier}-${row.Requirement}`;
					return (
						<div className={withMark('eo-row', marks.markClass(key))} key={`${row.Tier}-${row.Requirement}`}>
							<span>{row.TierName}</span>
							<span>{row.RequirementName}</span>
							<span>{row.Count}</span>
							{marks.isMarked(key) ? <ChangeMarkWord /> : null}
						</div>
					);
				})}
			</section>

			{totalElections > 1 ? (
				<span className={withMark('eo-datum', marks.markClass('elections'))}>
					{electionsFigure}
					{marks.isMarked('elections') ? <ChangeMarkWord /> : null}
				</span>
			) : null}
		</>
	);
};

export default ElectionsPanel;
