/**
 * useChangeMarks.ts -- the React half of the in-place change mark.
 *
 * The pure diff lives in `./change-marks.js` (`diffForMarks`, the row cap and
 * the lifetime constants); this file only feeds it rows, remembers what the
 * previous render showed, and keeps the mark on screen for its lifetime.
 *
 * What is marked, and when:
 *   - A row or figure whose signature changed, or that is new, is marked
 *     only after the hook's first render AND only when the data version says
 *     the pass is eligible (`markEligible`). The producer sets that false for
 *     the first catch-up and for any load from the local copy, so opening a
 *     dashboard never causes a wall of marks. With no provider mounted the
 *     default is not eligible, so nothing is ever marked.
 *   - More changed rows than the cap, or any deleted row, marks the panel
 *     header instead (the header carries the word "updated" in its name).
 *   - A figure is a one-row list, e.g. `[{ key: 'total', ... }]`.
 *
 * `rows` null or undefined means "not loaded yet": no diff runs and the last
 * index is kept, so a loading flash never reads as "everything was deleted".
 *
 * Panels render neither the header mark nor the announcement. The hook posts
 * both to the panel chrome (which owns the header) and to the grid (which
 * owns the single polite live region). A panel that rendered `announce`
 * itself would announce every pass twice.
 *
 * A new marked pass inside the lifetime replaces the previous marks and
 * restarts the lifetime. There is one timer per hook instance, never one
 * per row.
 *
 * Errors: a failed diff logs only the error's name. Row keys and signatures
 * can identify a registrant, and the announcement text carries only a count
 * and the panel title.
 */
import { createContext, createElement, Fragment, useContext, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { t } from '@votetorrent/ui-web';
import { diffForMarks, MARK_LIFETIME_MS } from './change-marks.js';
import { DataVersionContext } from './DataVersionContext.js';

export const CHANGE_MARK_CLASS = 'change-mark';
export const CHANGE_MARK_FADING_CLASS = 'change-mark--fading';
export const CHANGE_MARK_WORD_CLASS = 'change-mark__word';

/** none: no mark; fresh: tint and bar at full strength; fading: the tint is fading out. */
export type MarkPhase = 'none' | 'fresh' | 'fading';

/** The class list for a mark phase; empty when there is no mark. */
export function markClassName(phase: MarkPhase): string {
	if (phase === 'fresh') return CHANGE_MARK_CLASS;
	if (phase === 'fading') return CHANGE_MARK_CLASS + ' ' + CHANGE_MARK_FADING_CLASS;
	return '';
}

export interface MarkStep {
	nextIndex: Map<string, string>;
	marked: string[];
	headerMarked: boolean;
	/** Changed rows plus removed rows; kept even when the cap empties `marked`. */
	count: number;
}

/** One diff step: what to mark for `rows` given what the previous render showed. */
export function computeMarkStep<T>(
	prevIndex: Map<string, string> | null,
	rows: ReadonlyArray<T>,
	keyOf: (row: T) => string,
	sigOf: (row: T) => string,
	eligible: boolean,
): MarkStep {
	const mapped = rows.map((row) => ({ key: keyOf(row), sig: sigOf(row) }));
	const result = diffForMarks(prevIndex, mapped, { eligible });
	let count = 0;
	if (prevIndex !== null && eligible) {
		for (const [key, sig] of result.nextIndex) {
			if (prevIndex.get(key) !== sig) count += 1;
		}
		count += result.removedCount;
	}
	return { nextIndex: result.nextIndex, marked: result.marked, headerMarked: result.headerMarked, count };
}

/** The live-region sentence for one panel, or null when nothing changed. */
export function announceText(count: number, panelTitle: string): string | null {
	if (!(count >= 1)) return null;
	if (count === 1) return t('marks.announceOne', { count: '1', panel: panelTitle });
	return t('marks.announceMany', { count: String(count), panel: panelTitle });
}

/** What one hook reports to its panel chrome after a marked pass. */
export interface PassMarks {
	version: number;
	count: number;
	headerMarked: boolean;
}

/** Combine reports from several hooks in one panel: same version sums, a new version replaces. */
export function mergePassMarks(prev: PassMarks | null, post: PassMarks): PassMarks {
	if (prev === null || prev.version !== post.version) return post;
	return {
		version: post.version,
		count: prev.count + post.count,
		headerMarked: prev.headerMarked || post.headerMarked,
	};
}

/** The grid's pending announcement: one entry per panel, for one data version. */
export interface Announcement {
	version: number;
	entries: ReadonlyArray<readonly [string, string]>;
}

export const EMPTY_ANNOUNCEMENT: Announcement = Object.freeze({
	version: -1,
	entries: Object.freeze([]) as ReadonlyArray<readonly [string, string]>,
});

/** Add or replace one panel's sentence; a new version starts over. Entries keep first-seen order. */
export function mergeAnnouncement(prev: Announcement, panelId: string, text: string, version: number): Announcement {
	if (prev.version !== version) {
		return { version, entries: [[panelId, text]] };
	}
	let replaced = false;
	const entries = prev.entries.map((entry): readonly [string, string] => {
		if (entry[0] !== panelId) return entry;
		replaced = true;
		return [panelId, text];
	});
	if (!replaced) entries.push([panelId, text]);
	return { version, entries };
}

/** The live region's text: every panel's sentence, joined by one space. */
export function announcementText(a: Announcement): string {
	return a.entries.map((entry) => entry[1]).join(' ');
}

/** Provided by the panel chrome, inside its visible-body guard only. */
export interface PanelMarkSink {
	panelTitle: string;
	report(post: PassMarks): void;
}

export const PanelMarkContext = createContext<PanelMarkSink | null>(null);
PanelMarkContext.displayName = 'PanelMarkContext';

/** Provided by the panel grid, which owns the single polite live region. */
export interface MarkAnnouncer {
	announce(panelId: string, text: string, version: number): void;
}

const NOOP_ANNOUNCER: MarkAnnouncer = Object.freeze({
	announce(): void {
		// No grid mounted: there is no live region to post to.
	},
});

export const MarkAnnouncerContext = createContext<MarkAnnouncer>(NOOP_ANNOUNCER);
MarkAnnouncerContext.displayName = 'MarkAnnouncerContext';

/**
 * The phase of a mark started by `token`. Token 0 is no mark; each new
 * non-zero token shows the mark fresh, switches to fading after two
 * animation frames (so the tint paints once before the fade target applies)
 * and drops it at the end of the lifetime.
 */
export function useMarkLifetime(token: number): MarkPhase {
	const [phase, setPhase] = useState<MarkPhase>('none');
	useEffect(() => {
		if (token === 0) return undefined;
		setPhase('fresh');
		const hasFrames = typeof requestAnimationFrame === 'function';
		let outer = 0;
		let inner = 0;
		if (hasFrames) {
			outer = requestAnimationFrame(() => {
				inner = requestAnimationFrame(() => setPhase('fading'));
			});
		}
		const timer = setTimeout(() => setPhase('none'), MARK_LIFETIME_MS);
		return () => {
			if (hasFrames) {
				cancelAnimationFrame(outer);
				cancelAnimationFrame(inner);
			}
			clearTimeout(timer);
		};
	}, [token]);
	return phase;
}

export interface ChangeMarks {
	isMarked(key: string): boolean;
	headerMarked: boolean;
	announce: string | null;
	markClass(key: string): string;
}

interface MarkState {
	token: number;
	marked: ReadonlySet<string>;
	header: boolean;
	announce: string | null;
}

const INITIAL_MARK_STATE: MarkState = Object.freeze({
	token: 0,
	marked: new Set<string>(),
	header: false,
	announce: null,
});

/**
 * Marks for one list of rows (or one figure as a one-row list). Put
 * `markClass(key)` on the row's className and render `<ChangeMarkWord />`
 * inside it when `isMarked(key)`.
 */
export function useChangeMarks<T>(
	rows: ReadonlyArray<T> | null | undefined,
	keyOf: (row: T) => string,
	sigOf: (row: T) => string,
): ChangeMarks {
	const dataVersion = useContext(DataVersionContext);
	const sink = useContext(PanelMarkContext);

	// Latest-value refs, so the diff effect depends on `rows` only.
	const keyOfRef = useRef(keyOf);
	const sigOfRef = useRef(sigOf);
	const sinkRef = useRef(sink);
	const versionRef = useRef(dataVersion);
	keyOfRef.current = keyOf;
	sigOfRef.current = sigOf;
	sinkRef.current = sink;
	versionRef.current = dataVersion;

	const prevIndexRef = useRef<Map<string, string> | null>(null);
	const [state, setState] = useState<MarkState>(INITIAL_MARK_STATE);

	useEffect(() => {
		if (rows === null || rows === undefined) return;
		const { version, markEligible } = versionRef.current;
		let step: MarkStep;
		try {
			step = computeMarkStep(prevIndexRef.current, rows, keyOfRef.current, sigOfRef.current, markEligible);
		} catch (err) {
			console.error('useChangeMarks: a mark diff failed:', (err as { name?: string } | null)?.name ?? 'Error');
			prevIndexRef.current = null;
			return;
		}
		prevIndexRef.current = step.nextIndex;
		if (step.marked.length === 0 && !step.headerMarked) return;
		const currentSink = sinkRef.current;
		const announce = currentSink ? announceText(step.count, currentSink.panelTitle) : null;
		setState((prev) => ({
			token: prev.token + 1,
			marked: new Set(step.marked),
			header: step.headerMarked,
			announce,
		}));
		currentSink?.report({ version, count: step.count, headerMarked: step.headerMarked });
	}, [rows]);

	const phase = useMarkLifetime(state.token);
	const live = phase !== 'none';

	function isMarked(key: string): boolean {
		return live && state.marked.has(key);
	}

	return {
		isMarked,
		markClass(key: string): string {
			return isMarked(key) ? markClassName(phase) : '';
		},
		headerMarked: live && state.header,
		announce: live ? state.announce : null,
	};
}

/** The visually hidden word "updated", preceded by a space so it never fuses with the text before it. */
export function ChangeMarkWord(): ReactElement {
	return createElement(
		Fragment,
		null,
		' ',
		createElement('span', { className: CHANGE_MARK_WORD_CLASS }, t('marks.updated')),
	);
}
