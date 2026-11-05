/**
 * strand-changes.ts — this app's one strand change hub (vote-engine reactivity/strand-change-hub.ts).
 *
 * rn-db-factory attaches the open network strand's `StrandDatabase` (cadre-core `watchTables`), and screens
 * subscribe through `useStrandChanges`, so a commit to a table a screen shows (this device's, one replicated
 * into its storage, or, for `"optimystic.network_watch"` tables on a node with `strandReactivity`, one made
 * anywhere) re-runs that screen's read instead of waiting for a focus change or a timer.
 *
 * The hub is built on first use, not at module load. When the vote-engine entry does not provide it (a jest
 * mock of '@votetorrent/vote-engine/rn' that predates the hub), every call is a no-op: screens still re-read
 * on focus, which is what they did before the hub existed.
 *
 * Errors are logged in development builds only, by label and error class, never with row data.
 */
import * as voteEngine from '@votetorrent/vote-engine/rn';
import type {StrandChangeSource, StrandChangeSubscribeOptions} from '@votetorrent/vote-engine/rn';

type Hub = Pick<voteEngine.StrandChangeHub, 'attach' | 'detach' | 'subscribe'>;

const NO_HUB: Hub = {
	attach: () => undefined,
	detach: () => undefined,
	subscribe: () => () => undefined,
};

let hub: Hub | undefined;

function getHub(): Hub {
	if (hub === undefined) {
		const Ctor = (voteEngine as {StrandChangeHub?: typeof voteEngine.StrandChangeHub}).StrandChangeHub;
		hub =
			typeof Ctor === 'function'
				? new Ctor((label, err) => {
						if (__DEV__) {
							console.warn(`[strand-changes] ${label}: ${err instanceof Error ? err.name : typeof err}`);
						}
					})
				: NO_HUB;
	}
	return hub;
}

export const strandChanges = {
	attach: (strandId: string, source: StrandChangeSource): void => getHub().attach(strandId, source),
	detach: (strandId?: string): void => getHub().detach(strandId),
	subscribe: (
		tables: readonly string[],
		listener: () => void | Promise<void>,
		options: StrandChangeSubscribeOptions,
	): (() => void) => getHub().subscribe(tables, listener, options),
};
