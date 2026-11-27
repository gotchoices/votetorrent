/**
 * PanelFrame.tsx — the shared panel chrome, COMPOSED AROUND a panel by
 * 50-09's `PanelGrid` — never rendered by a panel itself (contract C7). This
 * file ships in this plan because it is shared, and because the
 * denied-body guard below is a security control (T-50-06-03) that must
 * exist before any panel content does; its only *caller* arrives in wave 5.
 *
 * This frame renders NO partial-access-versus-full-access indicator of any
 * kind. Neither of those two states exists in this phase: D-17 drops the
 * write-window gate entirely (there is nothing to write), so the only two
 * panel states this frame can produce are visible and denied. See
 * 50-06-PLAN.md's inherited-spec reconciliation for the "why" behind that
 * omission.
 *
 * Live marks: the frame hosts the per-panel mark sink (`PanelMarkContext`)
 * that a panel's `useChangeMarks` reports to. When a pass deletes rows or
 * changes more rows than the cap, the frame marks its own header (same tint
 * and bar as a row) and puts the word "updated" in the heading's accessible
 * name. It forwards one sentence per pass ("{n} items updated in {panel}")
 * to the grid's single live region. The sink sits inside the visible-body
 * guard below, so a denied panel can never produce a mark or announcement.
 */
import { useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Capability } from '../../auth/capabilities.js';
import type { GateResult } from '../../auth/gate.js';
import { t } from '@votetorrent/ui-web';
import { MARK_LIFETIME_MS } from '../../live/change-marks.js';
import {
	announceText,
	ChangeMarkWord,
	MarkAnnouncerContext,
	markClassName,
	mergePassMarks,
	PanelMarkContext,
	useMarkLifetime,
	type PanelMarkSink,
	type PassMarks,
} from '../../live/useChangeMarks.js';
import { ChartViewProvider, readStoredPanelView, writeStoredPanelView, type PanelView } from './ChartViewContext.js';
import './panels.css';

export interface PanelFrameProps {
	capability: Capability;
	evaluation: GateResult;
	children: ReactNode;
}

export function PanelFrame({ capability, evaluation, children }: PanelFrameProps) {
	// Lazy initialiser: the stored value is read once at mount, so the panel
	// never flashes the D-18 default before correcting itself to the D-19
	// stored choice.
	const [view, setView] = useState<PanelView>(() => readStoredPanelView(capability.id));

	function selectChart() {
		setView('chart');
		writeStoredPanelView(capability.id, 'chart');
	}

	function selectGrid() {
		setView('grid');
		writeStoredPanelView(capability.id, 'grid');
	}

	const panelTitle = t(capability.titleKey);
	const announcer = useContext(MarkAnnouncerContext);
	const [passMarks, setPassMarks] = useState<PassMarks | null>(null);
	const [headerToken, setHeaderToken] = useState(0);
	const report = useCallback((post: PassMarks) => setPassMarks((prev) => mergePassMarks(prev, post)), []);
	const sink = useMemo<PanelMarkSink>(() => ({ panelTitle, report }), [panelTitle, report]);

	// One effect per merged pass: mark the header when the pass asked for it,
	// post the panel's sentence to the grid's live region, and forget the
	// pass after the mark lifetime so a later pass with an equal version
	// starts a fresh count instead of adding to this one.
	useEffect(() => {
		if (passMarks === null) return undefined;
		if (passMarks.headerMarked) setHeaderToken((n) => n + 1);
		const text = announceText(passMarks.count, panelTitle);
		if (text !== null) announcer.announce(capability.id, text, passMarks.version);
		const timer = setTimeout(() => setPassMarks(null), MARK_LIFETIME_MS);
		return () => clearTimeout(timer);
	}, [passMarks]);

	const headerPhase = useMarkLifetime(headerToken);
	const headerMarked = headerPhase !== 'none';
	const headerContent = (
		<>
			<span className="panel-icon" aria-hidden="true">
				{capability.icon}
			</span>
			<h3 className="panel-title">
				{panelTitle}
				{headerMarked ? <ChangeMarkWord /> : null}
			</h3>
		</>
	);

	return (
		<section className={`panel${evaluation.visible ? '' : ' panel--denied'}`}>
			{/* Same element type in both branches, so React keeps the header
			    node and only its class changes; the unmarked branch keeps the
			    static class literal the class-coverage check reads. */}
			{headerMarked ? (
				<header className={'panel-header ' + markClassName(headerPhase)}>{headerContent}</header>
			) : (
				<header className="panel-header">{headerContent}</header>
			)}
			<div className="panel-pills">
				<span className="pill pill-scope" title={capability.schemaName}>
					{capability.scope}
				</span>
				{/* Both pills render through `t()`. They used to be authored
				    English -- "tier", "site", and the add-an-s pluralisation
				    rule -- living outside the frozen copy table that contract
				    C2 makes the ONLY place a user-facing string may live. The
				    Spanish locale the producer half ships had no path to
				    translate either word. */}
				<span className="pill pill-tier">{t('panelFrame.tierPill', { tier: String(capability.tier) })}</span>
				<span
					className="pill pill-sites"
					title={capability.siteCountCaveat ?? undefined}
				>
					{t(capability.sites === 1 ? 'panelFrame.sitePill' : 'panelFrame.sitesPill', {
						count: String(capability.sites),
					})}
				</span>
				{/* D-13/D-17: a per-panel view-state toggle, not a primary CTA --
				    it lives here, in the shared chrome's header, and NOT inside a
				    panel body, so the control-absence gates over panel bodies keep
				    their full original meaning (D-12). Rendered only when the
				    panel is visible: a denied panel emits no body, so a view
				    control over nothing would advertise a capability that is not
				    there. */}
				{evaluation.visible ? (
					<div className="panel-view-switch">
						<button
							type="button"
							className={
								view === 'chart'
									? 'panel-view-switch__option panel-view-switch__option--active'
									: 'panel-view-switch__option'
							}
							aria-pressed={view === 'chart'}
							onClick={selectChart}
						>
							{t('panelFrame.viewChart')}
						</button>
						<button
							type="button"
							className={
								view === 'grid'
									? 'panel-view-switch__option panel-view-switch__option--active'
									: 'panel-view-switch__option'
							}
							aria-pressed={view === 'grid'}
							onClick={selectGrid}
						>
							{t('panelFrame.viewGrid')}
						</button>
					</div>
				) : null}
			</div>
			{/*
			 * Binding guard (T-50-06-03): a denied panel's children are not
			 * rendered AT ALL, not merely hidden with CSS. Hiding a rendered
			 * body would leave the officer's data in the DOM — an
			 * information-disclosure failure this frame exists to prevent. The
			 * view-state provider goes INSIDE this guard, never around it, and
			 * so does the mark sink: a denied panel mounts no body, so no
			 * change-mark hook runs for it and it can never mark a row, mark
			 * its header or announce anything.
			 */}
			{evaluation.visible ? (
				<div className="panel-body">
					<PanelMarkContext.Provider value={sink}>
						<ChartViewProvider view={view}>{children}</ChartViewProvider>
					</PanelMarkContext.Provider>
				</div>
			) : null}
		</section>
	);
}
