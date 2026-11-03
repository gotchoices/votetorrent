/**
 * BallotsQuestionsPanel.tsx -- the `ceb` panel body: ballots, their
 * questions and option counts, for the active election.
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
 * A pending ballot signing task is decided in the Authority app. The panel
 * shows the count and the action note beside it, never a control.
 *
 * Renders no control of any kind (rule R2) and issues its own reads from an
 * effect against `props.db` (rule R6) -- see `RegistrationsPanel.tsx`'s
 * header for the shared reasoning.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PanelComponent } from './types.js';
import { t } from '@votetorrent/ui-web';
import { readBallots, readQuestions, parseOptionRange, countBallotSigningTasks, selectActiveElection } from '@votetorrent/web-data/officer';
import { useDataVersion } from '../../live/DataVersionContext.js';
import { useChangeMarks, ChangeMarkWord } from '../../live/useChangeMarks.js';
import { ReadOnlyNote } from '../../live/ReadOnlyNote.js';
import './election-ops.css';

// Field labels reproduced VERBATIM from the schema (rule R1), rendered as
// JSX EXPRESSIONS, never as literal JSX text.
const COL = Object.freeze({
	ballotDeadline: 'BallotDeadline',
	required: 'Required',
	pendingSigningTasks: 'BallotSignatureTaskExtension',
});

type QuestionRow = Awaited<ReturnType<typeof readQuestions>>[number];

interface BallotsData {
	title: string;
	ballotDeadline: string;
	ballots: Awaited<ReturnType<typeof readBallots>>;
	questionsByBallot: Map<string, QuestionRow[]>;
	pendingSigningTasks: number;
}

interface BallotsState {
	loading: boolean;
	data: BallotsData | null;
}

/**
 * Render an `OptionRange` column as a `"min-max"` figure. The column holds the
 * pg form `{min, max}` (or, on rows confirmed before the writer fix, JSON);
 * `parseOptionRange` reads both. Never throws; unreadable yields ''.
 */
function optionRangeFigure(raw: unknown): string {
	const r = parseOptionRange(raw);
	return r ? `${r.min}-${r.max}` : '';
}

// --- Live change marks (UI-SPEC "2. In-place change mark") -------------------

type MarkRow = { key: string; sig: string };
const markKey = (row: MarkRow) => row.key;
const markSig = (row: MarkRow) => row.sig;

/** `base` alone when there is no mark, else `base` plus the mark classes. */
function withMark(base: string, mark: string): string {
	return mark ? `${base} ${mark}` : base;
}

/** One mark row per rendered row or figure; signatures cover exactly what is displayed. */
function buildBallotMarkRows(data: BallotsData): MarkRow[] {
	const rows: MarkRow[] = [{ key: 'header', sig: JSON.stringify([data.title, data.ballotDeadline]) }];
	for (const ballot of data.ballots) {
		rows.push({ key: `ballot:${ballot.Id}`, sig: JSON.stringify([ballot.Description, ballot.Districts.join(', '), ballot.Id]) });
		for (const question of data.questionsByBallot.get(ballot.Id) ?? []) {
			rows.push({
				key: `question:${question.BallotId}-${question.Code}`,
				sig: JSON.stringify([
					question.Code,
					question.Title,
					question.TypeName,
					optionRangeFigure(question.OptionRange),
					question.OptionCount,
					question.Required,
				]),
			});
		}
	}
	rows.push({ key: 'pending', sig: JSON.stringify([data.pendingSigningTasks]) });
	return rows;
}

const BallotsQuestionsPanel: PanelComponent = ({ capability, db }) => {
	const { version } = useDataVersion();
	const readDbRef = useRef<unknown>(undefined);
	const [state, setState] = useState<BallotsState>({ loading: true, data: null });

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
				const ballots = await readBallots(boundDb, active.Id);
				if (ballots.length === 0) {
					if (!cancelled) setState({ loading: false, data: null });
					return;
				}
				const questions = await readQuestions(boundDb, active.Id);
				const questionsByBallot = new Map<string, QuestionRow[]>();
				for (const question of questions) {
					const existing = questionsByBallot.get(question.BallotId) ?? [];
					existing.push(question);
					questionsByBallot.set(question.BallotId, existing);
				}
				const pendingSigningTasks = await countBallotSigningTasks(boundDb);
				if (!cancelled) {
					setState({
						loading: false,
						data: {
							title: active.Title,
							ballotDeadline: active.BallotDeadline,
							ballots,
							questionsByBallot,
							pendingSigningTasks,
						},
					});
				}
			} catch (err) {
				// The error CLASS only, never the message. `err` comes from a query
				// against tables full of registrant information, and Quereus and its
				// constraint layer routinely embed the offending row and column values
				// in an error message. The browser console is a durable, exportable,
				// screenshot-able sink; a message must name table names, column names
				// and integer counts only.
				// eslint-disable-next-line no-console
				console.error('BallotsQuestionsPanel: a read failed:', (err as { name?: string })?.name ?? 'Error');
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
	const markRows = useMemo(() => (!db || state.loading ? null : state.data ? buildBallotMarkRows(state.data) : []), [db, state]);
	const marks = useChangeMarks(markRows, markKey, markSig);

	if (!db || state.loading || !state.data) {
		return <p className="panel-empty">{t(capability.emptyKey)}</p>;
	}

	const { title, ballotDeadline, ballots, questionsByBallot, pendingSigningTasks } = state.data;
	const pendingFigure = `${COL.pendingSigningTasks} ${pendingSigningTasks}`;

	return (
		<>
			<div className={withMark('eo-row', marks.markClass('header'))}>
				<span>{title}</span>
				<span className="eo-datum" title={COL.ballotDeadline}>
					{ballotDeadline}
				</span>
				{marks.isMarked('header') ? <ChangeMarkWord /> : null}
			</div>
			{ballots.map((ballot) => {
				const districtsJoined = ballot.Districts.join(', ');
				const questions = questionsByBallot.get(ballot.Id) ?? [];
				const ballotKey = `ballot:${ballot.Id}`;
				return (
					<section className="eo-section" key={ballot.Id}>
						<div className={withMark('eo-row', marks.markClass(ballotKey))}>
							<span>{ballot.Description}</span>
							<span className="eo-datum">{districtsJoined}</span>
							<span className="pill">{ballot.Id}</span>
							{marks.isMarked(ballotKey) ? <ChangeMarkWord /> : null}
						</div>
						{questions.map((question) => {
							const questionKey = `question:${question.BallotId}-${question.Code}`;
							return (
								<div className={withMark('eo-row', marks.markClass(questionKey))} key={`${question.BallotId}-${question.Code}`}>
									<span>{question.Code}</span>
									<span>{question.Title}</span>
									<span className="eo-datum">{question.TypeName}</span>
									<span className="eo-datum">{optionRangeFigure(question.OptionRange)}</span>
									<span>{question.OptionCount}</span>
									{question.Required === 1 ? <span className="pill">{COL.required}</span> : null}
									{marks.isMarked(questionKey) ? <ChangeMarkWord /> : null}
								</div>
							);
						})}
					</section>
				);
			})}
			<span className={withMark('eo-datum', marks.markClass('pending'))}>
				{pendingFigure}
				{marks.isMarked('pending') ? <ChangeMarkWord /> : null}
			</span>
			{pendingSigningTasks > 0 ? <ReadOnlyNote variant="short" /> : null}
		</>
	);
};

export default BallotsQuestionsPanel;
