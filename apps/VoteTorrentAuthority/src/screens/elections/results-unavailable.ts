/**
 * Plain copy for an 'unavailable' results outcome. vote-engine's ElectionResultsEngine reports a machine reason
 * code (election-key-inconsistent, secret-mismatch, malformed-row, ...). That code is for logs; the officer sees one
 * of a few plain sentences, picked by what went wrong. An unknown code falls back to a general sentence.
 * Same grouping as the Voter app's results-unavailable.ts.
 */
export type UnavailableCopy = 'keyMismatch' | 'keyNotRebuilt' | 'electionIncomplete' | 'voteDataFailed' | 'readFailed' | 'general';

const BY_REASON: Record<string, UnavailableCopy> = {
	// the released shares, the election key and the revision's keyholders disagree
	'election-key-inconsistent': 'keyMismatch',
	'group-key-mismatch': 'keyMismatch',
	'secret-mismatch': 'keyMismatch',
	'invalid-secret': 'keyMismatch',
	// the key could not be put back together from the shares on this device
	'no-election-key': 'keyNotRebuilt',
	'insufficient-shares': 'keyNotRebuilt',
	'share-missing': 'keyNotRebuilt',
	'share-invalid': 'keyNotRebuilt',
	'reconstruction-failed': 'keyNotRebuilt',
	'release-window-not-open': 'keyNotRebuilt',
	// the device does not have a usable current version of the election
	'no-current-revision': 'electionIncomplete',
	'revision-not-current': 'electionIncomplete',
	'no-timeline': 'electionIncomplete',
	// the vote blocks did not pass the count's checks
	'malformed-input': 'voteDataFailed',
	'malformed-row': 'voteDataFailed',
	'not-released': 'voteDataFailed',
	'inconsistent-inputs': 'voteDataFailed',
	'count-overflow': 'voteDataFailed',
	'duplicate-block': 'voteDataFailed',
	'mixed-election': 'voteDataFailed',
	'mixed-revision': 'voteDataFailed',
	// a database read threw
	'read-failed': 'readFailed',
};

export function unavailableCopy(reason: string): UnavailableCopy {
	return Object.prototype.hasOwnProperty.call(BY_REASON, reason) ? BY_REASON[reason]! : 'general';
}

/** The i18n key for a reason code. */
export function unavailableCopyKey(reason: string): string {
	const c = unavailableCopy(reason);
	return `resultsUnavailable${c.charAt(0).toUpperCase()}${c.slice(1)}`;
}
