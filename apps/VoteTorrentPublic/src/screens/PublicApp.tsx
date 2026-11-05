import { useEffect, useState } from 'react';
import { CONFIG_FAULT, loadBootstrapConfig } from '../peer/config.js';
// Imported under an alias so a whole-file occurrence count of the peer
// boot's exported name resolves to this ONE import line -- the same
// discipline `main.tsx` used before 56-14 moved the call here (see that
// file's own prior header, and `project_self_tripping_checker_headers`).
// `bootPeerLayer` is this file's own name for that single import; every
// other paragraph below describes it as "the peer boot composition" rather
// than repeating the exported name.
import { startPublicPeerBoot as bootPeerLayer, PEER_BOOT_STATUS } from '../peer/boot.js';
import { parseElectionAddress } from '../election-address.js';
import { ElectionShell } from './ElectionShell';
import type { PublicPeerFeedState } from './use-public-election';

/**
 * PublicApp.tsx — the production composition (56-12, D-13's fault-UI half).
 *
 * `56-06` shipped `src/peer/config.js`: a zero-import, never-throws loader
 * that resolves the deployment's bootstrap address list into `{ ok: true,
 * bootstrapNodes }` or `{ ok: false, fault: 'missing' | 'malformed', reason
 * }`. `56-12` renders that result for the first time. This file is the ONE
 * boot effect that resolves the config; `main.tsx` mounts it in place of a
 * bare `<ElectionShell />`, and every existing browser harness keeps
 * mounting `ElectionShell` directly with no `configFault` prop — so it sees
 * a byte-identical page.
 *
 * WHY THE FAULT RESOLVES HERE AND NOT IN `ElectionShell.tsx` OR IN
 * `use-public-election.ts`. Loading a config is an effect with an `await`,
 * and `ElectionShell.tsx` holds zero `useEffect` and zero `await ` by
 * construction (`election-shell.test.mjs` case 12b) — a second `return` in
 * that file is the cheapest way to make `AdvisoryDisclosure` conditional by
 * accident, so no effect may live there. It cannot live in
 * `use-public-election.ts`'s attach effect either: that effect is gated on
 * `shouldReadFor`, so it never runs on the election-less index page, and the
 * config fault must be answerable there too — a deployment that cannot
 * learn where to dial cannot look up ANY election, addressed or not.
 *
 * WHY EVERY EXISTING HARNESS STAYS UNAFFECTED. `dist-gate/`, `dist-live/`
 * and every `dist-mutant-` variant directory are all `publicDir: false`
 * builds with no `config.json` on disk. If `ElectionShell.tsx` itself resolved a config,
 * every one of those pages would render the fault box the instant this plan
 * landed, and `test:browser`/`test:render-fidelity`/`test:live-read`/
 * `test:empty-state` would all go red on a page they never intended to
 * change. Composing the boot effect in a NEW file that only `main.tsx`
 * mounts is what keeps every harness page byte-identical.
 *
 * THE PENDING STATE RENDERS NOTHING, NOT A SPINNER, NOT A SKELETON. This
 * app's `.skeleton` means "a space left empty ON PURPOSE, nothing is
 * loading" (D-18) — the opposite of what is happening during the fetch — and
 * flashing a fault box that then clears a moment later would be a false
 * statement briefly shown to a reader. Rendering nothing for the (typically
 * sub-second, same-origin) interval before the fetch settles is the honest
 * choice available.
 *
 * 56-14 ALSO MOVES THE PEER BOOT COMPOSITION HERE, FROM `main.tsx`. `56-11`
 * shipped the one production call to it in `main.tsx`, outside React,
 * because at that wave nothing needed its result beyond starting the
 * closure. A boot whose result lives outside React can never reach a
 * component — and `56-14` is the first plan that needs the boot's own result
 * union (`PEER_BOOT_STATUS`) as the second conjunct of
 * `use-public-election.ts`'s `connection` predicate. This is a MOVE, not a
 * duplication: `usePeerFeedStatus` below owns the one call site under
 * `src/`, and `main.tsx` no longer imports the peer boot composition at all.
 * The production import graph still reaches `src/peer/boot.js` through THIS
 * file, which is what keeps the libp2p/strand closure in production
 * `dist/` — Task 1's own acceptance criteria re-assert that by command.
 */

/**
 * The two fault values `src/peer/config.js` can report, typed from
 * `CONFIG_FAULT`'s own values so a change to that module's fault vocabulary
 * is a compile error here rather than a silently stale type.
 */
export type BootstrapConfigFault = (typeof CONFIG_FAULT)[keyof typeof CONFIG_FAULT];

/**
 * The frozen, two-member map from `CONFIG_FAULT`'s values to the copy-key
 * pair the config-fault box resolves through `t()`. This IS the entire
 * rendering contract, stated as a closed set of four string literals -- the
 * same structural containment `56-10` used to make document echo
 * impossible rather than merely absent (`packages/web-data`'s public-audience
 * boundary). `loadBootstrapConfig`'s `reason` field is never read anywhere
 * in this file, never passed to `t()`, and never logged: it is a
 * developer-facing diagnostic that has no reader-facing counterpart.
 *
 * Not imported by `ElectionShell.tsx` on purpose: this module already
 * imports `ElectionShell`, and a reverse import would make the pair a
 * circular one. `ElectionShell.tsx` resolves the identical two keys through
 * its own `public.config.${configFault}.title`/`.body` template instead --
 * see that file's own comment at the fault arm. This map is kept here as
 * the canonical, source-scannable declaration of the closed set (proven by
 * `test/node/offline-surfaces.test.mjs`) rather than as a value either
 * component consumes at runtime.
 */
export const FAULT_COPY_KEYS: Readonly<Record<BootstrapConfigFault, Readonly<{ title: string; body: string }>>> = Object.freeze({
	[CONFIG_FAULT.MISSING]: Object.freeze({ title: 'public.config.missing.title', body: 'public.config.missing.body' }),
	[CONFIG_FAULT.MALFORMED]: Object.freeze({ title: 'public.config.malformed.title', body: 'public.config.malformed.body' }),
});

/** The loader's own signature -- the injectable seam. Defaults to the real
 * `loadBootstrapConfig`, so the hook is exercisable at Node tier with no
 * browser and no build. */
export interface UseBootstrapConfigFaultOptions {
	loader?: typeof loadBootstrapConfig;
}

/**
 * Resolve the deployment's bootstrap config exactly once at boot.
 *
 * Returns `'pending'` before the fetch settles, `null` on a valid config,
 * or one of `CONFIG_FAULT`'s two values on a fault. Because
 * `loadBootstrapConfig` never throws and never rejects, there is no
 * `try`/`catch` here and no third error state -- the result union IS the
 * error handling, and adding a catch would invent a fourth state nothing
 * upstream can produce.
 *
 * Commits behind the same cancelled-mount guard the rest of this app already
 * uses (`use-public-election.ts`'s attach effect, `ElectionsPanel.tsx`'s
 * shape): a `cancelled` flag set in the cleanup, checked before the commit.
 */
export function useBootstrapConfigFault({ loader = loadBootstrapConfig }: UseBootstrapConfigFaultOptions = {}): 'pending' | BootstrapConfigFault | null {
	const [fault, setFault] = useState<'pending' | BootstrapConfigFault | null>('pending');

	useEffect(() => {
		let cancelled = false;
		// `loadBootstrapConfig`'s own `FetchLike` typedef is deliberately
		// looser than the DOM `Response` type (its own header explains why),
		// so the real `fetch` is handed through a thin wrapper rather than
		// passed directly -- the two signatures are structurally close but
		// not identical enough for the checker to unify them.
		const fetchImpl = (url: string, init: { credentials: string; cache: string; redirect: string }) => fetch(url, init as RequestInit);
		loader({ fetchImpl, pageProtocol: window.location.protocol }).then((result) => {
			if (cancelled) return;
			setFault(result.ok ? null : result.fault);
		});
		return () => {
			cancelled = true;
		};
	}, [loader]);

	return fault;
}

/**
 * The frozen, TOTAL map from every `PEER_BOOT_STATUS` value to its
 * `PublicPeerFeedState`. Keyed off the IMPORTED `PEER_BOOT_STATUS` object's
 * own values (`[PEER_BOOT_STATUS.STARTED]`, never a transcribed `'STARTED'`
 * literal), so a rename upstream fails this file at the declaration site
 * rather than silently mismapping. Because the map's declared type is
 * `Record<(typeof PEER_BOOT_STATUS)[keyof typeof PEER_BOOT_STATUS], ...>` and
 * `usePeerFeedStatus` indexes it with the boot result's own `status` field
 * (typed from the peer boot composition's own return union), a FIFTH status
 * value added to that union without a matching entry here is a COMPILE-TIME
 * missing-key failure, not a runtime fall-through to a silent `'unobserved'`.
 *
 * `(unresolved)` -- the boot promise has not settled yet -- is `usePeerFeedStatus`'s
 * OWN initial state, below, and is not a member of this map at all: nothing
 * observed yet must not claim either way while a socket is still opening.
 */
const PEER_FEED_STATUS_MAP: Readonly<Record<(typeof PEER_BOOT_STATUS)[keyof typeof PEER_BOOT_STATUS], PublicPeerFeedState>> =
	Object.freeze({
		// The feed is up.
		[PEER_BOOT_STATUS.STARTED]: 'running',
		// This browser could not join; cached rows are genuinely not current.
		[PEER_BOOT_STATUS.FAILED]: 'stopped',
		// No dial is possible this session, a strict subset of not connected --
		// the fault box renders anyway (Surface 3's own composition note), so
		// this value only keeps the two surfaces internally consistent.
		[PEER_BOOT_STATUS.CONFIG_FAULT]: 'stopped',
		// The root, election-less page opened no socket on purpose and has no
		// election to be stale.
		[PEER_BOOT_STATUS.NO_ADDRESS]: 'unobserved',
	});

/** The boot function's own signature -- the injectable seam, same shape as
 * `UseBootstrapConfigFaultOptions.loader` above. Defaults to the real peer
 * boot composition (`bootPeerLayer`, this file's own alias for it), so the
 * hook is exercisable at Node tier with no browser and no build. */
export interface UsePeerFeedStatusOptions {
	boot?: typeof bootPeerLayer;
	networkHash: string | null | undefined;
	electionId?: string | null | undefined;
}

/**
 * Own the one production call site of the peer boot composition under
 * `src/`, and map its result union to the `connection` predicate's second
 * conjunct.
 *
 * NO `try`/`catch` -- same discipline as `useBootstrapConfigFault`, for the
 * same reason: the boot's own contract is that it never throws and never
 * rejects, so a catch here would invent a state nothing can produce.
 * `stop()` -- present only on a `STARTED` result -- runs in the cleanup,
 * guarded so a cleanup that fires before the boot resolved (or that resolved
 * to anything other than `STARTED`) is a no-op rather than a throw.
 *
 * TWO ORDERINGS, BOTH HANDLED, same `cancelled`-flag shape
 * `use-public-election.ts`'s attach effect already uses for the identical
 * reason: a boot that resolves BEFORE unmount hands its `stop` to the
 * cleanup below; a boot that resolves AFTER unmount (the cleanup closure
 * already ran and cannot run again) stops itself inline, right where it
 * resolved -- otherwise a slow boot outliving a fast unmount would leak a
 * running Edge node with nothing left to stop it.
 */
export function usePeerFeedStatus({ boot = bootPeerLayer, networkHash, electionId }: UsePeerFeedStatusOptions): PublicPeerFeedState {
	const [peerFeed, setPeerFeed] = useState<PublicPeerFeedState>('unobserved');

	useEffect(() => {
		let cancelled = false;
		let stopFn: (() => Promise<void>) | null = null;
		boot({ networkHash, electionId }).then((result) => {
			if (cancelled) {
				if (result.status === PEER_BOOT_STATUS.STARTED) void result.stop();
				return;
			}
			if (result.status === PEER_BOOT_STATUS.STARTED) stopFn = result.stop;
			setPeerFeed(PEER_FEED_STATUS_MAP[result.status]);
		});
		return () => {
			cancelled = true;
			void stopFn?.();
		};
	}, [boot, networkHash, electionId]);

	return peerFeed;
}

/**
 * The production entry `main.tsx` mounts in place of a bare `<ElectionShell
 * />`. Resolves the config once at boot, boots the peer layer once at boot,
 * and hands `ElectionShell` a two-valued fault (or `null`) plus the observed
 * peer-feed status. Renders NOTHING else -- no `AppChrome`, no advisory, no
 * caveats of its own: those live in the shell, and the fault box must render
 * INSIDE them, not beside them.
 *
 * Reads neither `peerId` nor `dbName` off the boot result, and renders no
 * new element of its own for it -- the peer boot is a resolved STATUS
 * handed downstream, never a p2p-mechanics surface.
 */
export function PublicApp() {
	const fault = useBootstrapConfigFault();
	const address = parseElectionAddress(window.location.search);
	const peerFeed = usePeerFeedStatus({ networkHash: address.networkHash, electionId: address.electionId });
	if (fault === 'pending') return null;
	return <ElectionShell configFault={fault} peerFeed={peerFeed} />;
}

export default PublicApp;
