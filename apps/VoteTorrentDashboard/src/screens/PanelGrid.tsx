/**
 * PanelGrid.tsx — the nine-panel grid, in `CAPABILITIES`' frozen order.
 *
 * The scope set `evaluate()` is asked about arrives from exactly ONE place —
 * `useEffectiveScopes()` — and is never computed here. This seam is
 * unchanged in spirit from 50-06's own gate contract, precisely so a
 * "preview as" control can vary it without editing this file and without
 * this gate ever being stubbed. There is deliberately NO `grantedScopes`
 * prop beside that hook: one existed, was threaded in by `DashboardShell`,
 * and was never read — a dead second source of the same answer that made a
 * real defect (the provider freezing an empty real-scope set) hard to see
 * from the call site.
 *
 * `snapshotInstant` is still ACCEPTED, so the shell that passes it keeps
 * compiling, but it is IGNORED and no longer forwarded to any panel: the
 * Elections lifecycle pill falls back to the current time when it receives
 * no instant, and the live panels follow the clock instead. The live shell
 * removes the prop.
 *
 * Two providers wrap the grid, so live panels get what they need without a
 * new panel prop:
 *   - `DataVersionContext`, from the optional `dataVersion` prop, passed
 *     straight through (no state is seeded from it, so a new value always
 *     reaches the panels). With no prop the default never marks anything.
 *   - `MarkAnnouncerContext`, which collects each panel's "{n} items updated
 *     in {panel}" sentence for the ONE polite live region rendered after the
 *     grid. The region is always mounted (a live region must exist before
 *     its text changes to be announced), carries only counts and panel
 *     titles, and clears after the mark lifetime. It is not a status role:
 *     the header status chip owns that role.
 *
 * COMPOSITION, NOT DELEGATION: this file calls `evaluate()` and composes
 * `PanelFrame` around each registry component -- a panel never renders its
 * own frame (contract C7). A denied capability that is not revealed emits
 * NOTHING; a denied capability that IS revealed emits a frame with no
 * children, so the registry component never mounts and no query ever runs
 * against the officer's data for something they cannot see. This is real
 * behaviour, and its honest limit is the same one `src/auth/gate.js`
 * states: it is NOT enforcement. Read authorization here is advisory —
 * there is no CHECK behind it, and anyone holding this browser's
 * bootstrapped copy holds the whole database regardless of what is
 * rendered.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Database } from '@quereus/quereus';
import { CAPABILITIES } from '../auth/capabilities.js';
import { evaluate } from '../auth/gate.js';
import { MARK_LIFETIME_MS } from '../live/change-marks.js';
import { DataVersionContext, DEFAULT_DATA_VERSION } from '../live/DataVersionContext.js';
import type { DataVersion } from '../live/DataVersionContext.js';
import { announcementText, EMPTY_ANNOUNCEMENT, MarkAnnouncerContext, mergeAnnouncement } from '../live/useChangeMarks.js';
import type { Announcement, MarkAnnouncer } from '../live/useChangeMarks.js';
import { useEffectiveScopes } from './GrantedScopesContext.js';
import { PanelFrame } from './panels/PanelFrame.js';
import { PANEL_REGISTRY } from './panels/registry.js';
import { t } from '@votetorrent/ui-web';

export interface PanelGridProps {
	db: Database | null;
	revealDenied: boolean;
	onToggleReveal: () => void;
	/**
	 * @deprecated Accepted so the current shell compiles; ignored and not
	 * forwarded to any panel. The live shell removes it.
	 */
	snapshotInstant?: string | null;
	/** The live data version; omitted means the default, which never marks. */
	dataVersion?: DataVersion;
}

export function PanelGrid({ db, revealDenied, onToggleReveal, dataVersion }: PanelGridProps) {
	const effective = useEffectiveScopes();
	const [announcement, setAnnouncement] = useState<Announcement>(EMPTY_ANNOUNCEMENT);
	const announcer = useMemo<MarkAnnouncer>(
		() => ({
			announce(panelId: string, text: string, version: number): void {
				setAnnouncement((prev) => mergeAnnouncement(prev, panelId, text, version));
			},
		}),
		[],
	);

	useEffect(() => {
		if (announcement.entries.length === 0) return undefined;
		const timer = setTimeout(() => setAnnouncement(EMPTY_ANNOUNCEMENT), MARK_LIFETIME_MS);
		return () => clearTimeout(timer);
	}, [announcement]);

	return (
		<DataVersionContext.Provider value={dataVersion ?? DEFAULT_DATA_VERSION}>
			<MarkAnnouncerContext.Provider value={announcer}>
				<div className="sh-panel-grid-wrap">
					<button type="button" className="sh-reveal-toggle" aria-pressed={revealDenied} onClick={onToggleReveal}>
						{t('gate.revealDeniedCta')}
					</button>
					<div className="panel-grid">
						{CAPABILITIES.map((capability) => {
							const evaluation = evaluate(capability, effective);
							const Component = PANEL_REGISTRY[capability.id];

							if (evaluation.visible) {
								return (
									<div key={capability.id} id={`panel-${capability.id}`}>
										<PanelFrame capability={capability} evaluation={evaluation}>
											<Component capability={capability} db={db} />
										</PanelFrame>
									</div>
								);
							}

							if (revealDenied) {
								// No children -- the registry component is never mounted for a
								// denied capability, so no query ever runs against the
								// officer's data on its behalf.
								return (
									<div key={capability.id} id={`panel-${capability.id}`}>
										<PanelFrame capability={capability} evaluation={evaluation} children={null} />
									</div>
								);
							}

							return null;
						})}
					</div>
					<div className="change-mark-live-region" aria-live="polite" aria-atomic="true">
						{announcementText(announcement)}
					</div>
				</div>
			</MarkAnnouncerContext.Provider>
		</DataVersionContext.Provider>
	);
}

export default PanelGrid;
