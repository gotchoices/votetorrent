/**
 * stages.ts -- Phase 59 plan 59-06, Task 1.
 *
 * Re-exports 59-02's frozen ten-member `ElectionEvent`-shaped id list under one stable local
 * name (`TIMELINE_STAGE_IDS`), so the rest of the voter app has a single name to import
 * regardless of what `timeline-core.js` calls its own array (`ELECTION_EVENT_ORDER`). Also
 * declares the stage -> title-key map and the frozen closed set of every i18n key this module
 * (and Task 2's `relative-date.ts`) can ever emit -- the D-20 "every user-facing string is a key
 * from a closed set" guard.
 *
 * This file, and every other source module under `src/timeline/`, deliberately never imports
 * `@votetorrent/vote-core` -- the D-09 cross-check against the persisted `ElectionEvent` enum
 * belongs in the test (`__tests__/vocabulary-guards.test.ts`), so the adapter itself stays free
 * of the persistence enum (D-07's directional intent: compute status, don't leak the enum).
 */
import {ELECTION_EVENT_ORDER} from '@votetorrent/ui-web/lifecycle-core';
import type {TimelineStageId} from '@votetorrent/ui-web/lifecycle-core';

export type {TimelineStageId};

/**
 * The ten stage ids, in D-09 order. THE single stable local name the rest of the voter app
 * imports -- never re-declared, only re-exported from 59-02's `ELECTION_EVENT_ORDER`.
 */
export const TIMELINE_STAGE_IDS: readonly TimelineStageId[] = ELECTION_EVENT_ORDER;

/**
 * Namespace-relative flat dotted title key per stage, within the `timeline` i18n namespace
 * (landed by 59-05): `stage.<id>.title` for nine ids, and `stage.votingPeriod.title` for
 * `votingStarts` -- the one row whose title key names the INTERVAL it represents, not the
 * `ElectionEvent` instant, per D-21 and the approved `59-UI-SPEC.md`.
 */
export const STAGE_TITLE_KEY: Record<TimelineStageId, string> = {
	registrationEnds: 'stage.registrationEnds.title',
	ballotsFinal: 'stage.ballotsFinal.title',
	votingStarts: 'stage.votingPeriod.title',
	accruingVotes: 'stage.accruingVotes.title',
	hashingVotes: 'stage.hashingVotes.title',
	releasingKeys: 'stage.releasingKeys.title',
	tallyingStarts: 'stage.tallyingStarts.title',
	validation: 'stage.validation.title',
	certificationStarts: 'stage.certificationStarts.title',
	closed: 'stage.closed.title',
};

/**
 * The exact closed set of `timeline` namespace keys this module and `relative-date.ts` can ever
 * emit: the ten `stage.*.title` keys, the five `subtitle.*` keys, and `rail.now`. Every key a
 * `deriveTimeline` output carries (`titleKey`, `subtitle.key`) must be a member of this set --
 * enforced by Task 3's closed-key-set assertion across all 41 sample points. This is what keeps
 * `TimelineViewModel.reason`/`conflicts[].detail` (machine diagnostics, raw English) out of the
 * render path: they are never members of this array.
 */
export const TIMELINE_KEYS: readonly string[] = Object.freeze([
	...Object.values(STAGE_TITLE_KEY),
	'subtitle.today',
	'subtitle.yesterday',
	'subtitle.futureWeekday',
	'subtitle.pastDate',
	'subtitle.futureDate',
	'rail.now',
]);
