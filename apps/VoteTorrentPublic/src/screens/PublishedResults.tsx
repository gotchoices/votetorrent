import { t } from '@votetorrent/ui-web';
import type { PublicResultsReading } from './use-public-election';

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
 * control). Every element is unclassed, so this view needs no new CSS.
 */
export function PublishedResults({ results }: { results: PublicResultsReading }) {
	if (results.state === 'none') return <p>{t('public.fact.results.none')}</p>;
	if (results.state !== 'published') return <p>{t('public.fact.results.unreadable')}</p>;

	const { value } = results;
	const manyBallots = value.ballots.length > 1;
	return (
		<div>
			<p>{t('public.fact.results.blocks', { blocks: value.blockCount })}</p>
			{value.ballots.map((ballot) => (
				<section key={ballot.ballotId}>
					{manyBallots && ballot.description !== null && ballot.description !== '' ? <h4>{ballot.description}</h4> : null}
					<p>
						{t('public.fact.results.ballotTotals', {
							votes: ballot.votes,
							valid: ballot.valid,
							invalid: ballot.invalid,
							excluded: ballot.excluded,
						})}
					</p>
					{ballot.questions.map((question) => (
						<div key={question.code}>
							<h4>{question.title}</h4>
							<ul>
								{question.options.map((option) => (
									<li key={option.code}>{t('public.fact.results.optionCount', { option: option.title, count: option.count })}</li>
								))}
								<li>{t('public.fact.results.blank', { count: question.blank })}</li>
							</ul>
						</div>
					))}
					{ballot.unsupported.map((question) => (
						<p key={question.code}>{t('public.fact.results.unsupported', { question: question.title, count: question.answered })}</p>
					))}
				</section>
			))}
		</div>
	);
}

export default PublishedResults;
