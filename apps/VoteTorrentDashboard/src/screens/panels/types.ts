/**
 * types.ts — the panel contract (contract C7) consumed by 50-09, 50-10 and
 * 50-11.
 *
 * `PanelProps` deliberately carries NO `evaluation` field. `evaluate()`'s
 * result (src/auth/gate.js) lives in 50-09's `PanelGrid`, which is the only
 * place that calls `evaluate()` and the only place that composes
 * `PanelFrame` around a panel. A panel component never sees an evaluation
 * and makes no gating decision of its own — do not "fix" this interface by
 * widening it to carry one; that would let a panel render its own denied
 * state, which is exactly the thing `PanelFrame`'s structural guard exists
 * to centralize.
 *
 * `db` is typed from `@quereus/quereus` directly, NOT from 50-05's
 * `open-db.js` (`@votetorrent/web-data` since 54-03a). That keeps this contract free of a wave-3 sibling
 * dependency — this file's only job is the shape of props a panel receives,
 * not how a Database handle was constructed. `db` is nullable because a
 * panel can mount before a network is bootstrapped; a panel that receives
 * `null` renders its own empty state.
 *
 * Live panels get their live inputs from `src/live/`, never through new
 * props here, so this contract (no `evaluation` in panel props) stays as it
 * is: they read `DataVersionContext` and re-read their rows when its
 * `version` changes, mark changed rows and figures through
 * `useChangeMarks`, and show pending items with `ReadOnlyNote`.
 */
import type { FC } from 'react';
import type { Database } from '@quereus/quereus';
import type { Capability } from '../../auth/capabilities.js';

export interface PanelProps {
	capability: Capability;
	db: Database | null;
}

export type PanelComponent = FC<PanelProps>;
