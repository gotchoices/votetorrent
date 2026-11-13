import { useEffect, useState } from 'react';
import { t } from '@votetorrent/ui-web';
import { ELECTION_ADDRESS_PARAM, NETWORK_ADDRESS_PARAM } from '../election-address.js';
import { loadHeldElections, combineIndexElections } from '../election-index-source.js';
import type { HeldElectionsResult } from '../election-index-source.js';
import { listNetworkElections, NETWORK_LIST_STATUS } from '../peer/network-index.js';
import type { NetworkListResult } from '../peer/network-index.js';

/**
 * ElectionIndex.tsx — D-34's index of the elections THIS BROWSER holds, D-02's
 * explicit no-data label, and the incomplete-holdings qualifier that keeps
 * that label honest.
 *
 * 56-29: when the link names a NETWORK (but no election), the index also asks
 * that network for its elections (`peer/network-index.js`, which stores
 * nothing) and lists them ahead of what this browser holds. Three more
 * sentences, each with its own condition: "looking" while the network is
 * asked (the list counts as still loading if nothing is held yet);
 * `networkEmpty` when the network answered with none -- a fourth
 * `indexState`, so the browser-empty pair below keeps meaning "this browser
 * holds nothing" and keeps its emptiness-alone gate; and `networkUnreachable`
 * when the network could not be asked, which qualifies the browser-only list
 * the way the completeness qualifier does.
 *
 * THE GOVERNING INVARIANT, and the thing a later editor is most likely to
 * break by "simplifying" one of the two conditions:
 *
 *   The page never makes an UNQUALIFIED "no elections" claim it cannot
 *   support. The empty label states what was found; the qualifier states that
 *   the finding is incomplete. They are INDEPENDENT and they CO-OCCUR — an
 *   empty list plus a network that could not be read renders both, and
 *   together they are jointly honest in a way neither is alone.
 *
 * The precedent is D-10's unreadable timeline and D-23's unreadable policy
 * row: both say so rather than omitting silently, because a silent omission is
 * indistinguishable from a deliberate withholding. A registry whose entries
 * could not be established is the same class of fault and gets the same
 * answer, applied to the page's own reach rather than to an election's data.
 *
 * The two conditions, stated separately because they are separate:
 *   - the empty label is gated on EMPTINESS ALONE, never on completeness;
 *   - the qualifier is gated on the loaded result's own completeness flag
 *     being false, and NEVER on a count of unreadable networks. A registry
 *     read that throws leaves that count at zero while the flag is false, so a
 *     count-based gate would let precisely the corrupt-registry case render an
 *     unqualified "no elections" with no qualifier at all — the exact hole the
 *     qualifier exists to close.
 *
 * Completeness is a SEPARATE AXIS from emptiness, which is why the browser
 * tier reads two attributes rather than one tri-state: a single attribute
 * cannot express a state that is both empty and incomplete, and that state is
 * the one this component was rewritten for.
 *
 * Renders nothing else. No date (a reader-local, zone-labelled instant is
 * D-26's, owned by a later plan, and an unlabelled date here would pre-empt it
 * with a different convention), no election id, no network hash, no count
 * text, no raw error text. The only class names it renders are the two the
 * stylesheet already declares; the three sentence-level elements are
 * deliberately unclassed, so this file creates no dependency on a class that
 * does not exist. Titles are authority-supplied text rendered as JSX text
 * nodes only — React's default escaping is the control, and there is no
 * raw-HTML escape hatch anywhere in this file.
 */
export interface ElectionIndexProps {
	/** The addressed network. Used ONLY to scope the load — never rendered. */
	networkHash?: string | null;
	/** The injected seam, mirroring `ElectionShell`'s `election` prop:
	 * production passes nothing and the effect below loads; tests pass a value
	 * and the effect stands down. */
	result?: HeldElectionsResult | null;
	/** 56-29: the injected network answer, same seam as `result`. An injected
	 * `result` stands the network lookup down; this value is then used as the
	 * network's answer (`null` = the link named no network). */
	networkResult?: NetworkListResult | null;
}

/** The shape the catch branch below falls back to: nothing found, and the
 * finding explicitly not established. */
const UNESTABLISHED: HeldElectionsResult = Object.freeze({
	elections: Object.freeze([]),
	networksAttempted: 0,
	networksUnreadable: 0,
	complete: false,
});

export function ElectionIndex({ networkHash = null, result = null, networkResult = null }: ElectionIndexProps) {
	const [loaded, setLoaded] = useState<HeldElectionsResult | null>(null);
	const [network, setNetwork] = useState<NetworkListResult | null>(null);
	const injected = result !== null;
	const asksNetwork = typeof networkHash === 'string' && networkHash !== '' && !injected;

	useEffect(() => {
		if (injected) return;
		let cancelled = false;
		loadHeldElections({ networkHash })
			.then((next) => {
				// A resolution arriving after unmount is discarded rather than
				// setting state on a component that is gone.
				if (!cancelled) setLoaded(next);
			})
			.catch(() => {
				// `loadHeldElections` never rejects, so this branch is
				// unreachable today. It exists because a future edit to the
				// seam could reintroduce a throw, and the failure mode then
				// would be a blank page rather than an honest one. It falls
				// back to an UNESTABLISHED result, never to an empty-and-
				// complete one, so an unreachable page cannot masquerade as a
				// browser that holds nothing.
				if (!cancelled) setLoaded(UNESTABLISHED);
			});
		// 56-29. `listNetworkElections` never rejects and releases its own node
		// and read handle; a superseded mount only discards the answer.
		if (asksNetwork) {
			setNetwork(null);
			void listNetworkElections({ networkHash }).then((next) => {
				if (!cancelled) setNetwork(next);
			});
		}
		return () => {
			cancelled = true;
		};
	}, [networkHash, injected, asksNetwork]);

	const resolved: HeldElectionsResult | null = result ?? loaded;
	const answer: NetworkListResult | null = injected ? networkResult : network;
	const networkPending = asksNetwork && answer === null;
	const networkListed = answer !== null && answer.status === NETWORK_LIST_STATUS.LISTED;
	const networkUnreachable =
		answer !== null && (answer.status === NETWORK_LIST_STATUS.FAILED || answer.status === NETWORK_LIST_STATUS.CONFIG_FAULT);
	const elections =
		resolved === null ? [] : combineIndexElections(resolved.elections, networkListed && answer !== null ? answer.elections : []);

	// Every attribute below is DERIVED, never hard-coded.
	const indexState =
		resolved === null
			? 'loading'
			: elections.length > 0
				? 'listed'
				: networkPending
					? 'loading'
					: networkListed
						? 'networkEmpty'
						: 'empty';
	const indexComplete = resolved === null ? 'unknown' : String(resolved.complete);

	return (
		<section
			className="election-index"
			data-index-state={indexState}
			data-index-count={String(elections.length)}
			data-index-complete={indexComplete}
		>
			{elections.map((election) => (
				<div className="election-index__item" key={`${encodeURIComponent(election.networkHash)}/${encodeURIComponent(election.electionId)}`}>
					{typeof election.title === 'string' && election.title !== '' ? election.title : null}
					<a
						href={`?${NETWORK_ADDRESS_PARAM}=${encodeURIComponent(election.networkHash)}&${ELECTION_ADDRESS_PARAM}=${encodeURIComponent(election.electionId)}`}
					>
						{t('public.index.viewElectionCta')}
					</a>
				</div>
			))}
			{networkPending ? <p>{t('public.index.lookingOnNetwork')}</p> : null}
			{indexState === 'networkEmpty' ? <h2>{t('public.index.networkEmpty')}</h2> : null}
			{indexState === 'empty' ? <h2>{t('public.index.emptyHeading')}</h2> : null}
			{indexState === 'empty' ? <p>{t('public.index.emptyBody')}</p> : null}
			{resolved !== null && resolved.complete === false ? <p>{t('public.index.someUnreadable')}</p> : null}
			{networkUnreachable ? <p>{t('public.index.networkUnreachable')}</p> : null}
		</section>
	);
}

export default ElectionIndex;
