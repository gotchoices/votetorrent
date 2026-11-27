import { t } from '@votetorrent/ui-web';
import type { PublicResultsReading } from './use-public-election';
import { formatCount } from '../format-count.js';

/**
 * PublishedResults.tsx -- the body of the results card (56-30, gap E filled).
 *
 * Three states, never collapsed: `published` shows the totals, `none` says no
 * results have been published yet (a finding), `unreadable` says they couldn't
 * be read (a fault). The numbers are the root histogram of the officer-
 * published tally tree, exactly as published: this view does not recount and
 * makes no "verified" claim (the card's detail toggle says so).
 *
 * What it renders: the block count, then per ballot (its description only
 * when the election has more than one ballot) the vote totals, and per
 * question the question title, each option's title and count in the ballot's
 * own order, and the number of valid votes that left it unanswered. A question
 * type the tally cannot histogram is listed with its answered count and a
 * plain sentence. No id, code, root or hash reaches a text node; titles are
 * authority-supplied text rendered as JSX text (React's escaping is the
 * control).
 *
 * Headings sit under the card's own h3 label: the ballot description is an h4
 * and each question title the next level down (h5 under a ballot description,
 * h4 when no description heading is shown for its ballot). Each
 * carries its own class (app.css) so the two never render as the same bare
 * browser-default heading.
 */
export function PublishedResults({ results }: { results: PublicResultsReading }) {
	if (results.state === 'none') return <p>{t('public.fact.results.none')}</p>;
	if (results.state !== 'published') return <p>{t('public.fact.results.unreadable')}</p>;

	const { value } = results;
	const manyBallots = value.ballots.length > 1;
	return (
		<div>
			<p>{t('public.fact.results.blocks', { blocks: formatCount(value.blockCount) })}</p>
			{value.ballots.map((ballot) => {
				const ballotHeading = manyBallots && ballot.description !== null && ballot.description !== '';
				return (
					<section key={ballot.ballotId}>
						{ballotHeading ? <h4 className="results-ballot__title">{ballot.description}</h4> : null}
						<p>
							{t('public.fact.results.ballotTotals', {
								votes: formatCount(ballot.votes),
								valid: formatCount(ballot.valid),
								invalid: formatCount(ballot.invalid),
								excluded: formatCount(ballot.excluded),
							})}
						</p>
						{ballot.questions.map((question) => (
							<div key={question.code}>
								{ballotHeading ? (
									<h5 className="results-question__title">{question.title}</h5>
								) : (
									<h4 className="results-question__title">{question.title}</h4>
								)}
								<ul>
									{question.options.map((option) => (
										<li key={option.code}>{t('public.fact.results.optionCount', { option: option.title, count: formatCount(option.count) })}</li>
									))}
									<li>{t('public.fact.results.blank', { count: formatCount(question.blank) })}</li>
								</ul>
							</div>
						))}
						{ballot.unsupported.map((question) => (
							<p key={question.code}>{t('public.fact.results.unsupported', { question: question.title, count: formatCount(question.answered) })}</p>
						))}
					</section>
				);
			})}
		</div>
	);
}

export default PublishedResults;
