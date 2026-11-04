/**
 * shell-live.ts -- the live shell's pure decision layer.
 *
 * What the header status chip says, when a status flip may render, when the
 * panels may mark a change, how an officer is named, and which network boot
 * the shell owns. It lives outside the `.tsx` so node tests can run it under
 * type stripping.
 *
 * Rules this file keeps:
 *   - No clock read and no timer. Callers pass epoch-millisecond times in;
 *     the debounce step returns the time it next wants to run, and the
 *     component owns the one timeout.
 *   - No React and no peer import. The boot module arrives through the
 *     injected `loadBootModule`, so the entry chunk never carries the peer
 *     stack, and `ShellBoot` is declared structurally below.
 *   - No user-visible literal: every word comes from `t()`.
 *   - Logging is one fixed prefix plus an error's name, never its message.
 */
import { STATUS_DEBOUNCE_MS } from './status.js';
import type { DataVersion } from './DataVersionContext.js';
import { t } from '@votetorrent/ui-web';

/** The kinds the header chip renders. */
export type ChipKind = 'live' | 'catching-up' | 'offline' | 'not-live';

/** Why a network was unpaired. */
export type UnpairedReason = 'revoked' | 'removed' | 'key-invalid';

/** The status view the boot publishes (the reducer's view shape). */
export interface ChipView {
	kind: ChipKind | 'unpaired';
	lastPassAt: number | null;
	reconnecting: boolean;
	reason?: UnpairedReason;
}

/** Everything the chip renders, computed once per shown view. */
export interface ChipModel {
	kind: ChipKind;
	text: string;
	word: string;
	separator: string | null;
	detail: string | null;
	title: string | null;
	showReconnect: boolean;
	reconnecting: boolean;
	showFollowerNote: boolean;
}

/** The chip's text split at its first separator (the narrow layout puts the detail on a second line). */
export interface ChipTextParts {
	word: string;
	separator: string | null;
	detail: string | null;
}

/** The debounce memory: which view is on screen and which one is waiting to replace it. */
export interface ChipDebounceState {
	bootKey: string | null;
	shown: ChipView | null;
	pending: ChipView | null;
	pendingSince: number | null;
}

/** The part of the live boot the shell uses (structural: this file never imports the peer layer). */
export interface ShellBoot {
	readonly networkHash: string;
	readonly db: unknown;
	readonly failure: string | null;
	readonly role: 'leader' | 'follower';
	getStatus(): ChipView;
	subscribeStatus(listener: (view: ChipView) => void): () => void;
	getDataVersion(): DataVersion;
	subscribeData(listener: (value: DataVersion) => void): () => void;
	reconnect(): Promise<void>;
	stop(): Promise<void>;
	onUnpaired(cb: (reason: UnpairedReason) => void): () => void;
	onForgotten(cb: () => void): () => void;
}

/** The pairing handoff a first open may adopt. */
export interface ShellAdopt {
	memberNode: unknown;
	strandReader: unknown;
}

/** The two boot entry points the controller calls. */
export interface ShellBootModule {
	startDashboardBoot(options: { networkHash: string; adopt?: ShellAdopt; deps?: Record<string, unknown> }): Promise<ShellBoot>;
	switchDashboardBoot(current: ShellBoot | null, options: { networkHash: string; deps?: Record<string, unknown> }): Promise<ShellBoot>;
}

export interface OpenResult {
	boot: ShellBoot | null;
	stale: boolean;
	loadFailed: boolean;
}

export interface ShellBootController {
	open(networkHash: string, options?: { adopt?: ShellAdopt | null }): Promise<OpenResult>;
	stopActive(): Promise<void>;
	getBoot(): ShellBoot | null;
	subscribe(listener: (boot: ShellBoot | null) => void): () => void;
}

const LOG_PREFIX = 'live/shell-live:';

/** The chip text's separator: a middle dot with one space each side. */
const CHIP_SEPARATOR = ' · ';

function logFailure(err: unknown): void {
	const name =
		err !== null && typeof err === 'object' && typeof (err as { name?: unknown }).name === 'string'
			? (err as { name: string }).name
			: 'Error';
	// eslint-disable-next-line no-console
	console.error(LOG_PREFIX, name);
}

function pad2(value: number): string {
	return String(value).padStart(2, '0');
}

function requireTime(ms: unknown, who: string): number {
	if (typeof ms !== 'number' || !Number.isFinite(ms)) {
		throw new TypeError(`${who}: invalid time`);
	}
	return ms;
}

/** Local 24-hour `HH:MM`, or `HH:MM:SS` with seconds. */
export function formatClockTime(ms: number, withSeconds: boolean): string {
	const d = new Date(requireTime(ms, 'formatClockTime'));
	const base = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
	return withSeconds ? `${base}:${pad2(d.getSeconds())}` : base;
}

/** Local full date and time, 24-hour (the Offline chip's title). */
export function formatFullDateTime(ms: number): string {
	const at = requireTime(ms, 'formatFullDateTime');
	return new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'medium', hourCycle: 'h23' }).format(at);
}

/** Split at the first separator; without one the whole text is the word. */
export function splitChipText(text: string): ChipTextParts {
	const at = text.indexOf(CHIP_SEPARATOR);
	if (at < 0) return { word: text, separator: null, detail: null };
	return { word: text.slice(0, at), separator: CHIP_SEPARATOR, detail: text.slice(at + CHIP_SEPARATOR.length) };
}

function buildModel(
	kind: ChipKind,
	text: string,
	title: string | null,
	view: ChipView,
): ChipModel {
	const parts = splitChipText(text);
	return Object.freeze({
		kind,
		text,
		word: parts.word,
		separator: parts.separator,
		detail: parts.detail,
		title,
		showReconnect: kind === 'offline',
		reconnecting: view.reconnecting === true,
		showFollowerNote: kind === 'not-live',
	});
}

/** What the chip shows for a status view; null for no view and for an unpaired one. */
export function chipModel(view: ChipView | null | undefined): ChipModel | null {
	if (!view) return null;
	const lastPassAt = typeof view.lastPassAt === 'number' && Number.isFinite(view.lastPassAt) ? view.lastPassAt : null;
	switch (view.kind) {
		case 'live':
			return buildModel(
				'live',
				t('status.chip.live'),
				lastPassAt === null ? null : t('status.title.live', { time: formatClockTime(lastPassAt, true) }),
				view,
			);
		case 'catching-up':
			return buildModel('catching-up', t('status.chip.catching-up'), t('status.title.catching-up'), view);
		case 'offline':
			return lastPassAt === null
				? buildModel('offline', t('status.chip.offline-no-update'), null, view)
				: buildModel(
						'offline',
						t('status.chip.offline', { time: formatClockTime(lastPassAt, false) }),
						formatFullDateTime(lastPassAt),
						view,
					);
		case 'not-live':
			return buildModel('not-live', t('status.chip.not-live'), null, view);
		default:
			return null;
	}
}

function showNow(bootKey: string | null, view: ChipView | null): ChipDebounceState {
	return { bootKey, shown: view, pending: null, pendingSince: null };
}

/**
 * One debounce step. A kind change is shown only after it has held for
 * STATUS_DEBOUNCE_MS; a new boot, an unpaired view and a same-kind update
 * show at once. `wakeAt` is when the caller should step again (same view).
 */
export function stepChipDebounce(
	prev: ChipDebounceState | null,
	view: ChipView | null,
	nowMs: number,
	bootKey: string | null,
): { state: ChipDebounceState; wakeAt: number | null } {
	if (view === null || view === undefined) return { state: showNow(bootKey, null), wakeAt: null };
	if (prev === null || prev.bootKey !== bootKey || prev.shown === null) {
		return { state: showNow(bootKey, view), wakeAt: null };
	}
	if (view.kind === 'unpaired' || view.kind === prev.shown.kind) {
		return { state: showNow(bootKey, view), wakeAt: null };
	}
	const since =
		prev.pending !== null && prev.pending.kind === view.kind && prev.pendingSince !== null ? prev.pendingSince : nowMs;
	const due = since + STATUS_DEBOUNCE_MS;
	if (nowMs >= due) return { state: showNow(bootKey, view), wakeAt: null };
	return { state: { bootKey, shown: prev.shown, pending: view, pendingSince: since }, wakeAt: due };
}

/**
 * The version the panels see: marks stay off until this boot's view has been
 * live once (a follower's notices may mark), and on a local-copy load
 * (version 0).
 */
export function panelDataVersion(
	version: DataVersion,
	options: { everLive: boolean; follower: boolean },
): DataVersion {
	if (!version.markEligible) return version;
	if (version.version !== 0 && (options.everLive || options.follower)) return version;
	return Object.freeze({ version: version.version, changedTables: version.changedTables, markEligible: false });
}

/** The officer's name when it has text, else the officer's user id. */
export function officerLabel(name: string | null | undefined, userId: string): string {
	if (typeof name === 'string') {
		const trimmed = name.trim();
		if (trimmed.length > 0) return trimmed;
	}
	return userId;
}

/**
 * Owns the shell's one network boot. Every open drops the visible boot at
 * once (the screen never shows the old network's chip or panels), then, in
 * order behind any earlier open or stop, stops the previous boot before the
 * next one starts. An open overtaken by a later open or stop is stale: its
 * boot is stopped and never shown.
 */
export function createShellBootController(options: {
	loadBootModule: () => Promise<ShellBootModule>;
	bootDeps?: Record<string, unknown>;
}): ShellBootController {
	const { loadBootModule, bootDeps } = options;
	let generation = 0;
	let visible: ShellBoot | null = null;
	let owned: ShellBoot | null = null;
	let tail: Promise<unknown> = Promise.resolve();
	let modulePromise: Promise<ShellBootModule> | null = null;
	const listeners = new Set<(boot: ShellBoot | null) => void>();

	function notify(): void {
		for (const listener of [...listeners]) {
			try {
				listener(visible);
			} catch (err) {
				logFailure(err);
			}
		}
	}

	function setVisible(boot: ShellBoot | null): void {
		visible = boot;
		notify();
	}

	function enqueue<T>(task: () => Promise<T>): Promise<T> {
		const next = tail.catch(() => undefined).then(task);
		tail = next;
		return next;
	}

	function loadModule(): Promise<ShellBootModule> {
		if (modulePromise === null) {
			const attempt = Promise.resolve().then(() => loadBootModule());
			modulePromise = attempt;
			attempt.catch(() => {
				if (modulePromise === attempt) modulePromise = null;
			});
		}
		return modulePromise;
	}

	async function safeStop(boot: ShellBoot | null): Promise<void> {
		if (!boot) return;
		try {
			await boot.stop();
		} catch (err) {
			logFailure(err);
		}
	}

	return {
		open(networkHash, openOptions = {}) {
			const gen = ++generation;
			const adopt = openOptions.adopt ?? undefined;
			setVisible(null);
			return enqueue(async (): Promise<OpenResult> => {
				const prev = owned;
				owned = null;
				let mod: ShellBootModule;
				try {
					mod = await loadModule();
				} catch (err) {
					logFailure(err);
					await safeStop(prev);
					return { boot: null, stale: gen !== generation, loadFailed: true };
				}
				let boot: ShellBoot;
				try {
					if (prev && adopt) {
						await safeStop(prev);
						boot = await mod.startDashboardBoot({ networkHash, adopt, deps: bootDeps });
					} else if (prev) {
						boot = await mod.switchDashboardBoot(prev, { networkHash, deps: bootDeps });
					} else {
						boot = await mod.startDashboardBoot({ networkHash, adopt, deps: bootDeps });
					}
				} catch (err) {
					logFailure(err);
					return { boot: null, stale: gen !== generation, loadFailed: true };
				}
				if (gen !== generation) {
					await safeStop(boot);
					return { boot: null, stale: true, loadFailed: false };
				}
				owned = boot;
				setVisible(boot);
				return { boot, stale: false, loadFailed: false };
			});
		},
		stopActive() {
			++generation;
			setVisible(null);
			return enqueue(async () => {
				const prev = owned;
				owned = null;
				await safeStop(prev);
			});
		},
		getBoot() {
			return visible;
		},
		subscribe(listener) {
			if (typeof listener !== 'function') throw new TypeError('subscribe: the listener must be a function');
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
