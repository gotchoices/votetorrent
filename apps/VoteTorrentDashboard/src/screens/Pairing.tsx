/**
 * Pairing.tsx -- the officer's first screen: pair this browser from an
 * officer's pairing code. It replaced the old sign-in code screen, which
 * restored a one-off copy of the data; a paired browser is a member device
 * that follows the network live.
 *
 * The officer pastes the `vtpair1.` code the Authority app shows, or scans its
 * QR with the webcam (QrScanner.tsx). Either path hands the whitespace-free
 * code to `pairBrowser` (src/peer/pairing.js) with the real officer strand
 * reader (src/peer/strand-read.js) as `deps.openStrandReader`. The peer layer
 * is loaded by dynamic import() only when a pairing starts, so the entry chunk
 * carries no network stack.
 *
 * THE CODE IS A BEARER CREDENTIAL. It is never logged, written to the URL or
 * to any storage, put in an error, a title or an aria-label. It leaves the DOM
 * on success and on every failure that consumed it (old-style, expired,
 * spent, digest mismatch, officer not valid, unsupported, and a stop after the
 * join began); it stays only where a retry needs it (malformed, no storage,
 * unreachable, and a stop or swap refusal before the join began). The field
 * turns spellcheck, autocomplete, autocapitalize and autocorrect off so the
 * text is not sent to a cloud spellchecker.
 *
 * THE SWAP DIALOG LIVES HERE. When the browser already holds this network for
 * a different officer, `pairBrowser` asks `confirmSwap` before it deletes
 * anything; that question arrives while pairBrowser runs, so this screen (not
 * the live shell) renders the dialog. It names both officers and keeps the old
 * one unless the officer chooses to replace.
 *
 * Stop pairing aborts the run's signal; pairBrowser then stops the node and
 * removes the half-made pairing itself. The abort handle is dropped the moment
 * pairBrowser settles, so the unmount that follows a successful pairing
 * aborts nothing and the handed-off member node keeps running in the shell.
 *
 * Errors are logged as a fixed prefix plus the error's name only.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClipboardEvent, ReactElement, Ref } from 'react';
import { t } from '@votetorrent/ui-web';
import {
	PAIRING_CODE_MAX_CHARS,
	decodeNetworkJoinCode,
	decodePairingCode,
} from '@votetorrent/vote-engine/browser';
import { nodeLockName } from '../lifecycle/forget-network.js';
import { QrScanner } from './QrScanner.js';
import './pairing.css';

// --- types -----------------------------------------------------------------------

export type PairPhase = 'verifying' | 'connecting' | 'joining' | 'first-sync';

export type PairFailureReason =
	| 'malformed'
	| 'old-style'
	| 'expired'
	| 'spent'
	| 'unreachable'
	| 'digest-mismatch'
	| 'officer-not-valid'
	| 'no-storage'
	| 'unsupported';

export type UnpairedNotice = {
	reason: 'revoked' | 'removed' | 'key-invalid';
	authorityName: string;
	officerName: string | null;
};

export type PairingHandoff = { memberNode: unknown; strandReader: unknown };

export type PairResult =
	| { ok: true; networkHash: string; handoff: PairingHandoff }
	| { ok: false; reason: string };

export type SwapRequest = {
	networkHash: string;
	authorityName: string;
	held: { userId: string; name: string | null };
	incoming: { userId: string; name: string | null };
	incomingVerified: boolean;
};

/** confirmSwap's answer. A named alias so no `=> ... <` sequence sits on one
 * line (lint-copy reads `>text<` on a line as a JSX text node). */
export type SwapAnswer = boolean | Promise<boolean>;

export type PairBrowserOptions = {
	code: string;
	onProgress?: (phase: PairPhase) => void;
	confirmSwap?: (request: SwapRequest) => SwapAnswer;
	signal?: AbortSignal;
	deps?: { openStrandReader: unknown };
};

export type PairBrowserFn = (options: PairBrowserOptions) => Promise<PairResult>;

export type PairingModule = { pairBrowser: PairBrowserFn; openStrandReader: unknown };

export type PairingView = 'idle' | 'verifying' | 'joining' | 'stopping' | 'failed';

// --- constants and pure helpers -----------------------------------------------------

/** After this long in the first sync, the slow-sync line appears. */
export const PAIRING_SLOW_SYNC_MS = 30_000;

type FailureView = Readonly<{
	headingKey: string;
	bodyKey: string;
	ctaKey: string | null;
	keepsCode: boolean;
	codeIsBad: boolean;
}>;

/** Every failure state's copy and code rule. `keepsCode` false = the code was consumed. */
export const FAILURE_VIEWS: Readonly<Record<PairFailureReason, FailureView>> = Object.freeze({
	malformed: Object.freeze({
		headingKey: 'pairing.failed.malformed.heading',
		bodyKey: 'pairing.failed.malformed.body',
		ctaKey: 'pairing.action.tryAgain',
		keepsCode: true,
		codeIsBad: true,
	}),
	'old-style': Object.freeze({
		headingKey: 'pairing.failed.old-style.heading',
		bodyKey: 'pairing.failed.old-style.body',
		ctaKey: null,
		keepsCode: false,
		codeIsBad: false,
	}),
	expired: Object.freeze({
		headingKey: 'pairing.failed.expired.heading',
		bodyKey: 'pairing.failed.expired.body',
		ctaKey: 'pairing.action.tryAnother',
		keepsCode: false,
		codeIsBad: true,
	}),
	spent: Object.freeze({
		headingKey: 'pairing.failed.spent.heading',
		bodyKey: 'pairing.failed.spent.body',
		ctaKey: 'pairing.action.tryAnother',
		keepsCode: false,
		codeIsBad: true,
	}),
	unreachable: Object.freeze({
		headingKey: 'pairing.failed.unreachable.heading',
		bodyKey: 'pairing.failed.unreachable.body',
		ctaKey: 'pairing.action.retry',
		keepsCode: true,
		codeIsBad: false,
	}),
	'digest-mismatch': Object.freeze({
		headingKey: 'pairing.failed.digest-mismatch.heading',
		bodyKey: 'pairing.failed.digest-mismatch.body',
		ctaKey: 'pairing.action.tryAnother',
		keepsCode: false,
		codeIsBad: true,
	}),
	'officer-not-valid': Object.freeze({
		headingKey: 'pairing.failed.officer-not-valid.heading',
		bodyKey: 'pairing.failed.officer-not-valid.body',
		ctaKey: null,
		keepsCode: false,
		codeIsBad: false,
	}),
	'no-storage': Object.freeze({
		headingKey: 'pairing.failed.no-storage.heading',
		bodyKey: 'pairing.failed.no-storage.body',
		ctaKey: 'pairing.action.tryAgain',
		keepsCode: true,
		codeIsBad: false,
	}),
	unsupported: Object.freeze({
		headingKey: 'pairing.failed.unsupported.heading',
		bodyKey: 'pairing.failed.unsupported.body',
		ctaKey: null,
		keepsCode: false,
		codeIsBad: false,
	}),
});

function isFailureReason(reason: unknown): reason is PairFailureReason {
	return typeof reason === 'string' && Object.prototype.hasOwnProperty.call(FAILURE_VIEWS, reason);
}

/** The pasted or scanned text with every whitespace character removed. */
export function normalizePairingInput(text: unknown): string {
	return typeof text === 'string' ? text.replace(/\s+/g, '') : '';
}

/** Phases in report order; the join begins at `joining`. */
const PHASE_ORDER: readonly PairPhase[] = Object.freeze(['verifying', 'connecting', 'joining', 'first-sync']);

function phaseIndex(phase: PairPhase | null | undefined): number {
	return phase ? PHASE_ORDER.indexOf(phase) : -1;
}

/**
 * Whether the field keeps the code after a result. Failures follow
 * FAILURE_VIEWS; a stop or a swap refusal keeps it only before the join began
 * (after that the code has been spent on the network).
 */
export function keepsCodeAfterFailure(reason: string, reachedPhase: PairPhase | null | undefined): boolean {
	if (isFailureReason(reason)) return FAILURE_VIEWS[reason].keepsCode;
	if (reason === 'cancelled' || reason === 'swap-declined') {
		return phaseIndex(reachedPhase) < phaseIndex('joining');
	}
	return false;
}

export type StepState = 'waiting' | 'progress' | 'done' | 'failed';

export type StepRow = { phase: PairPhase; labelKey: string; stateKey: string; state: StepState };

const STEP_STATE_KEYS: Readonly<Record<StepState, string>> = Object.freeze({
	waiting: 'pairing.stepState.waiting',
	progress: 'pairing.stepState.inProgress',
	done: 'pairing.stepState.done',
	failed: 'pairing.stepState.failed',
});

const STEP_LABEL_KEYS = Object.freeze([
	Object.freeze({ phase: 'connecting' as const, labelKey: 'pairing.step.connecting' }),
	Object.freeze({ phase: 'joining' as const, labelKey: 'pairing.step.joining' }),
	Object.freeze({ phase: 'first-sync' as const, labelKey: 'pairing.step.first-sync' }),
]);

/** The three step rows for the phase reached so far; `failed` marks the current row failed. */
export function stepRows(reachedPhase: PairPhase | null | undefined, { failed }: { failed: boolean }): StepRow[] {
	const reached = phaseIndex(reachedPhase);
	return STEP_LABEL_KEYS.map(({ phase, labelKey }) => {
		const own = phaseIndex(phase);
		const state: StepState = reached > own ? 'done' : reached === own ? (failed ? 'failed' : 'progress') : 'waiting';
		return { phase, labelKey, stateKey: STEP_STATE_KEYS[state], state };
	});
}

/** The unpaired notice's resolved heading and body. */
export function unpairedNoticeCopy(notice: UnpairedNotice): { heading: string; body: string } {
	const officerName = notice.officerName ?? t('pairing.officerUnknown');
	const heading = t('unpaired.heading');
	switch (notice.reason) {
		case 'revoked':
			return { heading, body: t('unpaired.body.revoked', { officerName, authorityName: notice.authorityName }) };
		case 'key-invalid':
			return { heading, body: t('unpaired.body.key-invalid', { officerName }) };
		default:
			return { heading, body: t('unpaired.body.removed') };
	}
}

export type Route = { kind: 'pairing' } | { kind: 'shell'; networkHash: string };

/**
 * Where the app opens: the live shell for a paired entry (the preferred one
 * when it is paired), else pairing. A legacy entry is never adopted.
 */
export function routeFromRegistry(
	entries: unknown,
	isLegacyEntry: (entry: unknown) => boolean,
	preferredHash?: string | null,
): Route {
	const list = Array.isArray(entries) ? entries : [];
	const paired = list.filter(
		(e): e is { networkHash: string } =>
			e !== null &&
			typeof e === 'object' &&
			typeof (e as { networkHash?: unknown }).networkHash === 'string' &&
			!isLegacyEntry(e),
	);
	if (paired.length === 0) return { kind: 'pairing' };
	if (typeof preferredHash === 'string' && preferredHash.length > 0) {
		const hit = paired.find((e) => e.networkHash === preferredHash);
		if (hit) return { kind: 'shell', networkHash: hit.networkHash };
	}
	return { kind: 'shell', networkHash: paired[0].networkHash };
}

/** True when this browser lacks something pairing needs. */
export function detectUnsupportedBrowser(globals: unknown): boolean {
	const g = (globals ?? {}) as {
		indexedDB?: unknown;
		crypto?: { subtle?: unknown };
		WebSocket?: unknown;
		TextEncoder?: unknown;
	};
	return !g.indexedDB || !g.crypto || !g.crypto.subtle || !g.WebSocket || !g.TextEncoder;
}

export type PairingRun = {
	start(options: Omit<PairBrowserOptions, 'signal'>): Promise<PairResult>;
	abort(): boolean;
	inFlight(): boolean;
};

/**
 * One pairing at a time with its own abort handle. The handle is dropped as
 * soon as pairBrowser settles, so nothing can abort a signal the handed-off
 * member node still holds.
 */
export function createPairingRun(pairBrowser: PairBrowserFn): PairingRun {
	let controller: AbortController | null = null;
	return {
		async start(options) {
			const own = new AbortController();
			controller = own;
			try {
				return await pairBrowser({ ...options, signal: own.signal });
			} finally {
				if (controller === own) controller = null;
			}
		},
		abort() {
			if (controller === null) return false;
			controller.abort();
			return true;
		},
		inFlight() {
			return controller !== null;
		},
	};
}

function logFailure(err: unknown): void {
	const name = err && typeof err === 'object' ? (err as { name?: unknown }).name : undefined;
	console.warn('screens/pairing:', typeof name === 'string' && name.length > 0 ? name : 'Error');
}

/** Loads the peer layer on demand: never in the entry chunk. */
async function defaultLoadPairing(): Promise<PairingModule> {
	const [pairing, strandRead] = await Promise.all([
		import('../peer/pairing.js'),
		import('../peer/strand-read.js'),
	]);
	return {
		pairBrowser: pairing.pairBrowser as unknown as PairBrowserFn,
		openStrandReader: strandRead.openOfficerStrandReader,
	};
}

/** Best effort: does another tab hold this network's node lock? Never throws. */
async function heldByAnotherTab(networkHash: string): Promise<boolean> {
	try {
		const locks = (globalThis as { navigator?: { locks?: { query?: () => Promise<unknown> } } }).navigator?.locks;
		if (!locks || typeof locks.query !== 'function') return false;
		const snapshot = (await locks.query()) as { held?: Array<{ name?: unknown }> } | null;
		const name = nodeLockName(networkHash);
		return Array.isArray(snapshot?.held) && snapshot.held.some((lock) => lock?.name === name);
	} catch {
		return false;
	}
}

/** The decoded code's network hash and display name, or nulls. Never throws. */
function peekCode(code: string): { networkHash: string | null; authorityName: string } {
	try {
		const decoded = decodePairingCode(code);
		const join = decodeNetworkJoinCode(decoded.joinCode);
		if (join.ok) return { networkHash: join.code.networkHash, authorityName: join.code.name };
	} catch {
		// pairBrowser judges the code; this peek only labels the screen.
	}
	return { networkHash: null, authorityName: '' };
}

// --- pure views -----------------------------------------------------------------------

export interface PairingStateViewProps {
	view: PairingView;
	code: string;
	failure?: PairFailureReason | null;
	reachedPhase?: PairPhase | null;
	slow?: boolean;
	otherTab?: boolean;
	authorityName?: string;
	officerName?: string | null;
	notice?: UnpairedNotice | null;
	hasPairedNetworks: boolean;
	noticeHeadingRef?: Ref<HTMLHeadingElement>;
	textareaRef?: Ref<HTMLTextAreaElement>;
	onCodeChange?: (code: string) => void;
	onCodePaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
	onSubmit?: () => void;
	onScan?: () => void;
	onStop?: () => void;
	onCta?: (ctaKey: string) => void;
	onDismissNotice?: () => void;
}

function StepStateWord({ row }: { row: StepRow }): ReactElement {
	const word = t(row.stateKey);
	switch (row.state) {
		case 'done':
			return <span className="pr-step-state pr-step-state--done">{word}</span>;
		case 'progress':
			return <span className="pr-step-state pr-step-state--progress">{word}</span>;
		case 'failed':
			return <span className="pr-step-state pr-step-state--failed">{word}</span>;
		default:
			return <span className="pr-step-state pr-step-state--waiting">{word}</span>;
	}
}

function StepList({ rows, officerName }: { rows: StepRow[]; officerName: string | null | undefined }): ReactElement {
	return (
		<ol className="pr-steps">
			{rows.map((row) => (
				<li key={row.phase} className="pr-step">
					<span className="pr-step-label">
						{row.phase === 'joining'
							? officerName
								? t('pairing.step.joining', { officerName })
								: t('pairing.step.joiningUnnamed')
							: t(row.labelKey)}
					</span>
					<StepStateWord row={row} />
				</li>
			))}
		</ol>
	);
}

function FailureAlert(props: { failure: PairFailureReason; otherTab: boolean; onCta?: (ctaKey: string) => void }): ReactElement {
	const view = FAILURE_VIEWS[props.failure];
	const ctaKey = view.ctaKey;
	return (
		<div className="pr-alert" role="alert">
			{view.codeIsBad ? (
				<h2 className="pr-heading pr-heading--fail">{t(view.headingKey)}</h2>
			) : (
				<h2 className="pr-heading">{t(view.headingKey)}</h2>
			)}
			<p className="pr-body">{t(view.bodyKey)}</p>
			{props.failure === 'no-storage' && props.otherTab ? (
				<p className="pr-body">{t('pairing.failed.no-storage.otherTab')}</p>
			) : null}
			{ctaKey !== null ? (
				<button type="button" className="pr-button" onClick={() => props.onCta?.(ctaKey)}>
					{t(ctaKey)}
				</button>
			) : null}
		</div>
	);
}

/** The whole pairing screen for one state. Hook-free. */
export function PairingStateView(props: PairingStateViewProps): ReactElement {
	const { view, notice, hasPairedNetworks } = props;
	const failure = view === 'failed' && props.failure ? props.failure : null;
	// Defence in depth: a consumed code is never put back on screen, whatever the caller passes.
	const fieldValue = failure !== null && !FAILURE_VIEWS[failure].keepsCode ? '' : props.code;
	const showForm = view === 'idle' || view === 'failed';
	const noticeCopy = notice ? unpairedNoticeCopy(notice) : null;
	const showFailedSteps = failure !== null && phaseIndex(props.reachedPhase) >= phaseIndex('connecting');

	return (
		<main className="pr-screen">
			{noticeCopy !== null ? (
				<section className="pr-notice">
					<h2 className="pr-notice-heading" tabIndex={-1} ref={props.noticeHeadingRef}>
						{noticeCopy.heading}
					</h2>
					<p className="pr-notice-body">{noticeCopy.body}</p>
					<button type="button" className="pr-text-button" onClick={props.onDismissNotice}>
						{t('unpaired.dismiss')}
					</button>
				</section>
			) : null}
			{noticeCopy === null && !hasPairedNetworks && showForm ? (
				<section className="pr-empty">
					<h2 className="pr-empty-heading">{t('pairing.emptyHeading')}</h2>
					<p className="pr-empty-body">{t('pairing.emptyBody')}</p>
				</section>
			) : null}
			<div className="pr-card">
				<h1 className="pr-title">{t('pairing.title')}</h1>
				<p className="pr-intro">{t('pairing.intro')}</p>

				{view === 'verifying' ? (
					<div className="pr-status" aria-live="polite">
						<h2 className="pr-heading">{t('pairing.verifying.heading')}</h2>
						<p className="pr-body">{t('pairing.verifying.body')}</p>
						<span className="pr-spinner" aria-hidden="true" />
					</div>
				) : null}

				{view === 'joining' || view === 'stopping' ? (
					<div className="pr-status" aria-live="polite">
						<h2 className="pr-heading">
							{props.authorityName
								? t('pairing.joining.heading', { authorityName: props.authorityName })
								: t('pairing.title')}
						</h2>
						<StepList rows={stepRows(props.reachedPhase, { failed: false })} officerName={props.officerName} />
						<p className="pr-body">{t('pairing.joining.body')}</p>
						{props.slow ? <p className="pr-slow">{t('pairing.catchingUpSlow')}</p> : null}
						<button
							type="button"
							className="pr-text-button"
							disabled={view === 'stopping'}
							onClick={props.onStop}
						>
							{t('pairing.stop')}
						</button>
					</div>
				) : null}

				{failure !== null ? (
					<FailureAlert failure={failure} otherTab={props.otherTab === true} onCta={props.onCta} />
				) : null}
				{showFailedSteps ? (
					<StepList rows={stepRows(props.reachedPhase, { failed: true })} officerName={props.officerName} />
				) : null}

				{showForm ? (
					<form
						className="pr-form"
						onSubmit={(event) => {
							event.preventDefault();
							props.onSubmit?.();
						}}
					>
						<label className="pr-label" htmlFor="pr-code">
							{t('pairing.fieldLabel')}
						</label>
						<textarea
							id="pr-code"
							className="pr-code"
							ref={props.textareaRef}
							rows={4}
							spellCheck={false}
							autoComplete="off"
							autoCapitalize="off"
							autoCorrect="off"
							value={fieldValue}
							onChange={(event) => props.onCodeChange?.(event.target.value)}
							onPaste={props.onCodePaste}
						/>
						<p className="pr-help">{t('pairing.fieldHelp')}</p>
						<div className="pr-actions">
							<button type="submit" className="pr-cta" disabled={fieldValue.trim() === ''}>
								{t('pairing.cta')}
							</button>
							<button type="button" className="pr-button" onClick={props.onScan}>
								{t('pairing.scanCta')}
							</button>
						</div>
					</form>
				) : null}
			</div>
		</main>
	);
}

export interface SwapDialogViewProps {
	authorityName: string;
	oldOfficer: string | null;
	newOfficer: string | null;
	keepRef?: Ref<HTMLButtonElement>;
	onConfirm?: () => void;
	onKeep?: () => void;
}

/** The officer-swap question's content. Hook-free. */
export function SwapDialogView(props: SwapDialogViewProps): ReactElement {
	const unknown = t('pairing.officerUnknown');
	const oldOfficer = props.oldOfficer ?? unknown;
	const newOfficer = props.newOfficer ?? unknown;
	return (
		<div className="pr-dialog-body">
			<h2 id="pr-swap-heading" className="pr-heading">
				{t('swap.heading', { oldOfficer, newOfficer })}
			</h2>
			<p className="pr-body">
				{t('swap.body', { oldOfficer, newOfficer, authorityName: props.authorityName })}
			</p>
			<div className="pr-actions">
				<button type="button" className="pr-cta" onClick={props.onConfirm}>
					{t('swap.confirm')}
				</button>
				<button type="button" className="pr-button" ref={props.keepRef} onClick={props.onKeep}>
					{t('swap.keep', { oldOfficer })}
				</button>
			</div>
		</div>
	);
}

function SwapDialog(props: { request: SwapRequest; onAnswer: (replace: boolean) => void }): ReactElement {
	const dialogRef = useRef<HTMLDialogElement | null>(null);
	const keepRef = useRef<HTMLButtonElement | null>(null);
	useEffect(() => {
		const dialog = dialogRef.current;
		if (dialog === null) return undefined;
		if (!dialog.open) {
			try {
				dialog.showModal();
			} catch {
				// The dialog still renders inline.
			}
		}
		keepRef.current?.focus();
		return () => {
			if (dialog.open) dialog.close();
		};
	}, []);
	const { request, onAnswer } = props;
	return (
		<dialog
			ref={dialogRef}
			className="pr-dialog"
			aria-labelledby="pr-swap-heading"
			onCancel={(event) => {
				event.preventDefault();
				onAnswer(false);
			}}
		>
			<SwapDialogView
				authorityName={request.authorityName}
				oldOfficer={request.held.name}
				newOfficer={request.incoming.name}
				keepRef={keepRef}
				onConfirm={() => onAnswer(true)}
				onKeep={() => onAnswer(false)}
			/>
		</dialog>
	);
}

// --- the stateful screen ---------------------------------------------------------------

export interface PairingProps {
	notice: UnpairedNotice | null;
	onDismissNotice: () => void;
	hasPairedNetworks: boolean;
	onPaired: (result: { networkHash: string; handoff: PairingHandoff }) => void;
	onCancel?: () => void;
	loadPairing?: () => Promise<PairingModule>;
}

export function Pairing(props: PairingProps): ReactElement {
	const [view, setView] = useState<PairingView>('idle');
	const [code, setCode] = useState('');
	const [failure, setFailure] = useState<PairFailureReason | null>(null);
	const [reachedPhase, setReachedPhase] = useState<PairPhase | null>(null);
	const [slow, setSlow] = useState(false);
	const [otherTab, setOtherTab] = useState(false);
	const [scannerOpen, setScannerOpen] = useState(false);
	const [swapRequest, setSwapRequest] = useState<SwapRequest | null>(null);
	const [knownNames, setKnownNames] = useState<{ authorityName: string; officerName: string | null }>({
		authorityName: '',
		officerName: null,
	});

	const propsRef = useRef(props);
	propsRef.current = props;
	const runRef = useRef<PairingRun | null>(null);
	const busyRef = useRef(false);
	const reachedRef = useRef<PairPhase | null>(null);
	const mountedRef = useRef(true);
	const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const swapResolverRef = useRef<((replace: boolean) => void) | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const noticeHeadingRef = useRef<HTMLHeadingElement | null>(null);
	const focusFieldRef = useRef(false);

	const clearSlowTimer = () => {
		if (slowTimerRef.current !== null) {
			clearTimeout(slowTimerRef.current);
			slowTimerRef.current = null;
		}
	};

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			// Aborts only while a pairing is in flight; after success the handle is already gone.
			runRef.current?.abort();
			clearSlowTimer();
			const resolve = swapResolverRef.current;
			swapResolverRef.current = null;
			resolve?.(false);
		};
	}, []);

	// Focus the field after a CTA or "Paste the code instead".
	useEffect(() => {
		if (!focusFieldRef.current) return;
		focusFieldRef.current = false;
		textareaRef.current?.focus();
	});

	// The unpaired notice takes focus when it appears.
	useEffect(() => {
		if (props.notice) noticeHeadingRef.current?.focus();
	}, [props.notice]);

	const onProgress = useCallback((phase: PairPhase) => {
		if (!mountedRef.current) return;
		reachedRef.current = phase;
		setReachedPhase(phase);
		if (phase === 'connecting' || phase === 'joining' || phase === 'first-sync') {
			setView((current) => (current === 'stopping' ? current : 'joining'));
		}
		if (phase === 'first-sync' && slowTimerRef.current === null) {
			slowTimerRef.current = setTimeout(() => {
				slowTimerRef.current = null;
				if (mountedRef.current) setSlow(true);
			}, PAIRING_SLOW_SYNC_MS);
		}
	}, []);

	const confirmSwap = useCallback(
		(request: SwapRequest) =>
			new Promise<boolean>((resolve) => {
				if (!mountedRef.current) {
					resolve(false);
					return;
				}
				swapResolverRef.current = resolve;
				setSwapRequest(request);
			}),
		[],
	);

	const answerSwap = (replace: boolean) => {
		const request = swapRequest;
		const resolve = swapResolverRef.current;
		swapResolverRef.current = null;
		setSwapRequest(null);
		if (replace && request) {
			setKnownNames((names) => ({ ...names, officerName: request.incoming.name }));
		}
		resolve?.(replace);
	};

	const failWith = (reason: PairFailureReason) => {
		setFailure(reason);
		setView('failed');
		if (!FAILURE_VIEWS[reason].keepsCode) setCode('');
	};

	const submit = async (raw: string) => {
		if (busyRef.current) return;
		const next = normalizePairingInput(raw);
		if (next === '') return;
		setCode(next);
		setOtherTab(false);
		reachedRef.current = null;
		setReachedPhase(null);
		if (next.length > PAIRING_CODE_MAX_CHARS) {
			failWith('malformed');
			return;
		}
		if (detectUnsupportedBrowser(globalThis)) {
			failWith('unsupported');
			return;
		}
		busyRef.current = true;
		propsRef.current.onDismissNotice();
		setFailure(null);
		setSlow(false);
		setView('verifying');
		const peek = peekCode(next);
		setKnownNames({ authorityName: peek.authorityName, officerName: null });
		try {
			let mod: PairingModule;
			try {
				mod = await (propsRef.current.loadPairing ?? defaultLoadPairing)();
			} catch (err) {
				logFailure(err);
				if (mountedRef.current) failWith('unreachable');
				return;
			}
			if (!mountedRef.current) return;
			const run = createPairingRun(mod.pairBrowser);
			runRef.current = run;
			const result = await run.start({
				code: next,
				onProgress,
				confirmSwap,
				deps: { openStrandReader: mod.openStrandReader },
			});
			clearSlowTimer();
			if (!mountedRef.current) {
				if (result.ok) {
					// Nobody adopted this node (the screen left mid-pairing); the next boot resumes it.
					const node = result.handoff.memberNode as { stop?: () => unknown } | null;
					void Promise.resolve()
						.then(() => node?.stop?.())
						.catch(logFailure);
				}
				return;
			}
			if (result.ok) {
				setCode('');
				propsRef.current.onPaired({ networkHash: result.networkHash, handoff: result.handoff });
				return;
			}
			if (result.reason === 'cancelled' || result.reason === 'swap-declined') {
				setView('idle');
				if (!keepsCodeAfterFailure(result.reason, reachedRef.current)) setCode('');
				return;
			}
			const reason: PairFailureReason = isFailureReason(result.reason) ? result.reason : 'unreachable';
			failWith(reason);
			if (reason === 'no-storage' && peek.networkHash !== null) {
				const held = await heldByAnotherTab(peek.networkHash);
				if (mountedRef.current) setOtherTab(held);
			}
		} finally {
			busyRef.current = false;
		}
	};

	const onStop = () => {
		setView('stopping');
		runRef.current?.abort();
	};

	const onCta = (ctaKey: string) => {
		if (ctaKey === 'pairing.action.retry') {
			void submit(code);
			return;
		}
		if (ctaKey === 'pairing.action.tryAnother') setCode('');
		setFailure(null);
		setView('idle');
		focusFieldRef.current = true;
	};

	const onCodePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
		const text = event.clipboardData?.getData('text');
		if (typeof text !== 'string') return;
		event.preventDefault();
		setCode(normalizePairingInput(text));
	};

	// Escape returns to the shell when there is one to return to.
	useEffect(() => {
		const doc = (globalThis as { document?: Document }).document;
		if (!doc) return undefined;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			if (!props.hasPairedNetworks) return;
			if (view !== 'idle' && view !== 'failed') return;
			if (scannerOpen || swapRequest !== null) return;
			propsRef.current.onCancel?.();
		};
		doc.addEventListener('keydown', onKeyDown);
		return () => doc.removeEventListener('keydown', onKeyDown);
	}, [props.hasPairedNetworks, view, scannerOpen, swapRequest]);

	return (
		<>
			<PairingStateView
				view={view}
				code={code}
				failure={failure}
				reachedPhase={reachedPhase}
				slow={slow}
				otherTab={otherTab}
				authorityName={knownNames.authorityName}
				officerName={knownNames.officerName}
				notice={props.notice}
				hasPairedNetworks={props.hasPairedNetworks}
				noticeHeadingRef={noticeHeadingRef}
				textareaRef={textareaRef}
				onCodeChange={setCode}
				onCodePaste={onCodePaste}
				onSubmit={() => void submit(code)}
				onScan={() => setScannerOpen(true)}
				onStop={onStop}
				onCta={onCta}
				onDismissNotice={props.onDismissNotice}
			/>
			<QrScanner
				open={scannerOpen}
				onFound={(text) => {
					setScannerOpen(false);
					void submit(text);
				}}
				onClose={() => setScannerOpen(false)}
				onPasteInstead={() => {
					setScannerOpen(false);
					focusFieldRef.current = true;
				}}
			/>
			{swapRequest !== null ? <SwapDialog request={swapRequest} onAnswer={answerSwap} /> : null}
		</>
	);
}

export default Pairing;
