/**
 * QrScanner.tsx -- the webcam QR scanner the pairing screen opens from its
 * "Scan QR code" button. It reads the pairing code the Authority app shows as
 * a QR and hands the text to the same submit path a paste uses.
 *
 * THE CAMERA ALWAYS TURNS OFF. Every camera track is stopped (the camera light
 * goes out) the moment one of these happens: a pairing code is found (before
 * verifying starts), "Close scanner", Esc (the dialog's cancel), a route
 * change (popstate, hashchange, pagehide, or the component unmounting), or the
 * tab staying hidden for more than SCANNER_HIDDEN_STOP_MS. A stream that the
 * browser hands over after the scanner was already closed is stopped at once
 * and never attached. A camera left running after the officer stopped looking
 * at it is a privacy defect, so teardown is one idempotent `stop()` that every
 * exit path goes through.
 *
 * FULL FRAME, NOT MIRRORED. The decoder reads the whole video frame
 * (videoWidth x videoHeight), not the viewfinder square: the square is only a
 * hint for the officer, and a dense code held a little off-centre still has
 * to decode. The preview is not mirrored (a mirrored preview makes people
 * misjudge distance and direction).
 *
 * THE DECODER IS LAZY. `jsqr` (the package approved at the dependency
 * checkpoint; plain JavaScript, so the page needs no wasm allowance) is loaded
 * by dynamic import() only when the scanner opens, which keeps it out of the
 * entry chunk.
 *
 * The scanned text is never rendered, logged, put in a title or an
 * aria-label: it is a bearer code until it is redeemed.
 *
 * `createScannerSession` holds all of the behaviour and takes every browser
 * object as an injected dependency, so the Node tier runs the real controller
 * against fakes. `ScannerStateView` is the hook-free markup.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement, Ref } from 'react';
import { t } from '@votetorrent/ui-web';
import {
	PAIRING_CODE_MAX_CHARS,
	PAIRING_CODE_PREFIX,
	PAIRING_QR_BYTE_BUDGET,
} from '@votetorrent/vote-engine/browser';
import './pairing.css';

/** A hidden tab stops the camera after this long. */
export const SCANNER_HIDDEN_STOP_MS = 60_000;

/** At most one decode per this many milliseconds. */
export const SCAN_INTERVAL_MS = 200;

/**
 * The getUserMedia requests, tried in order. Only an OverconstrainedError
 * moves to the next one; the last asks for any camera at all.
 */
export const VIDEO_CONSTRAINT_LADDER = Object.freeze([
	Object.freeze({
		audio: false,
		video: Object.freeze({
			facingMode: Object.freeze({ ideal: 'environment' }),
			width: Object.freeze({ ideal: 1920 }),
			height: Object.freeze({ ideal: 1080 }),
		}),
	}),
	Object.freeze({
		audio: false,
		video: Object.freeze({
			facingMode: Object.freeze({ ideal: 'environment' }),
			width: Object.freeze({ ideal: 1280 }),
			height: Object.freeze({ ideal: 720 }),
		}),
	}),
	Object.freeze({ audio: false, video: true }),
]);

export type ScannerState =
	| 'asking'
	| 'denied'
	| 'no-camera'
	| 'insecure'
	| 'unavailable'
	| 'scanning'
	| 'not-pairing'
	| 'found'
	| 'stopped';

/** A read-only set of states. A named alias so no `>... <` sequence sits on one
 * line (lint-copy reads `>text<` on a line as a JSX text node). */
type StateSet = ReadonlySet<ScannerState>;

/** States that end the session with a message the officer must read. */
const ERROR_STATES: StateSet = new Set<ScannerState>([
	'denied',
	'no-camera',
	'insecure',
	'unavailable',
]);

type TrackLike = {
	stop?: () => void;
	readyState?: string;
	getCapabilities?: () => unknown;
	applyConstraints?: (c: unknown) => Promise<unknown> | unknown;
};
type StreamLike = { getTracks?: () => TrackLike[]; getVideoTracks?: () => TrackLike[] };
type VideoLike = {
	srcObject: unknown;
	videoWidth: number;
	videoHeight: number;
	play?: () => Promise<unknown> | unknown;
};
type ImageDataLike = { data: Uint8ClampedArray; width: number; height: number };
type ContextLike = {
	drawImage: (source: unknown, x: number, y: number, w: number, h: number) => void;
	getImageData: (x: number, y: number, w: number, h: number) => ImageDataLike;
};
type CanvasLike = {
	width: number;
	height: number;
	getContext: (kind: '2d', options?: { willReadFrequently?: boolean }) => ContextLike | null;
};
type ListenerTarget = {
	addEventListener: (type: string, fn: () => void) => void;
	removeEventListener: (type: string, fn: () => void) => void;
};

export type Decode = (imageData: ImageDataLike) => Promise<string | null>;

export interface ScannerDeps {
	video: VideoLike;
	mediaDevices: { getUserMedia?: (constraints: unknown) => Promise<StreamLike> } | null | undefined;
	isSecureContext: boolean;
	loadDecoder: () => Promise<Decode>;
	createCanvas: (width: number, height: number) => CanvasLike;
	requestFrame: (callback: () => void) => unknown;
	cancelFrame: (handle: unknown) => void;
	now: () => number;
	setTimeout: (callback: () => void, ms: number) => unknown;
	clearTimeout: (handle: unknown) => void;
	doc: ListenerTarget & { visibilityState?: string };
	win: ListenerTarget;
	onState?: (state: ScannerState) => void;
	onFound?: (code: string) => void;
	onClose?: () => void;
}

export interface ScannerSession {
	start(): Promise<void>;
	stop(reason: string): void;
	getState(): ScannerState;
}

/** The scanned text's verdict: a pairing code (whitespace removed) or anything else. */
export function classifyScannedText(text: unknown): { kind: 'pairing'; code: string } | { kind: 'other' } {
	const code = typeof text === 'string' ? text.replace(/\s+/g, '') : '';
	if (!code.startsWith(PAIRING_CODE_PREFIX)) return { kind: 'other' };
	if (code.length > PAIRING_CODE_MAX_CHARS) return { kind: 'other' };
	if (new TextEncoder().encode(code).length > PAIRING_QR_BYTE_BUDGET) return { kind: 'other' };
	return { kind: 'pairing', code };
}

function errorName(err: unknown): string {
	const name = err && typeof err === 'object' ? (err as { name?: unknown }).name : undefined;
	return typeof name === 'string' && name.length > 0 ? name : 'Error';
}

/** A getUserMedia (or decoder) failure, mapped to the scanner state that explains it. */
export function mapCameraError(err: unknown): ScannerState {
	switch (errorName(err)) {
		case 'NotAllowedError':
		case 'SecurityError':
		case 'PermissionDeniedError':
			return 'denied';
		case 'NotFoundError':
		case 'DevicesNotFoundError':
			return 'no-camera';
		default:
			return 'unavailable';
	}
}

/** Stops every track of `stream`; each stop is guarded so one bad track cannot keep another alive. */
export function stopStream(stream: unknown): void {
	const s = stream as StreamLike | null | undefined;
	let tracks: TrackLike[] = [];
	try {
		tracks = typeof s?.getTracks === 'function' ? s.getTracks() : [];
	} catch {
		tracks = [];
	}
	for (const track of tracks) {
		try {
			track.stop?.();
		} catch {
			// One failing track must not keep the others running.
		}
	}
}

type JsqrResult = { data?: unknown } | null | undefined;
type JsqrFn = (
	data: Uint8ClampedArray,
	width: number,
	height: number,
	options?: { inversionAttempts?: string },
) => JsqrResult;

/**
 * Wraps the jsqr module (in whichever default-export shape the bundler or
 * Node gives it) as `(imageData) => Promise<text | null>`. The Authority's QR
 * is black on white and never inverted, so the inverted pass is skipped.
 */
export function adaptDecoderModule(mod: unknown): Decode {
	const m = mod as { default?: unknown } | ((...args: unknown[]) => unknown) | null | undefined;
	let fn: unknown = null;
	if (typeof m === 'function') fn = m;
	else if (m && typeof m.default === 'function') fn = m.default;
	else if (m && m.default && typeof (m.default as { default?: unknown }).default === 'function') {
		fn = (m.default as { default: unknown }).default;
	}
	if (typeof fn !== 'function') throw new TypeError('decoder module has no decode function');
	const decode = fn as JsqrFn;
	return async (imageData) => {
		const result = decode(imageData.data, imageData.width, imageData.height, {
			inversionAttempts: 'dontInvert',
		});
		return result && typeof result.data === 'string' ? result.data : null;
	};
}

/** Loads the approved decoder lazily (its own chunk, never the entry). */
export async function loadDecoder(): Promise<Decode> {
	return adaptDecoderModule(await import('jsqr'));
}

/** Asks the track for continuous focus only when it says it supports it; a refusal is ignored. */
function tryContinuousFocus(stream: StreamLike): void {
	let tracks: TrackLike[] = [];
	try {
		tracks =
			typeof stream.getVideoTracks === 'function'
				? stream.getVideoTracks()
				: typeof stream.getTracks === 'function'
					? stream.getTracks()
					: [];
	} catch {
		return;
	}
	for (const track of tracks) {
		try {
			const caps =
				typeof track.getCapabilities === 'function'
					? (track.getCapabilities() as { focusMode?: unknown } | null)
					: null;
			const modes = caps?.focusMode;
			if (!Array.isArray(modes) || !modes.includes('continuous')) continue;
			if (typeof track.applyConstraints !== 'function') continue;
			const pending = track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
			if (pending && typeof (pending as Promise<unknown>).catch === 'function') {
				(pending as Promise<unknown>).catch(() => undefined);
			}
		} catch {
			// Focus is a nicety; the scan works without it.
		}
	}
}

/**
 * The scanner's controller. No React: every browser object comes in through
 * `deps`, so the Node tier runs this exact code with fakes.
 */
export function createScannerSession(deps: ScannerDeps): ScannerSession {
	let state: ScannerState = 'stopped';
	let started = false;
	let stopped = false;
	let stream: StreamLike | null = null;
	let decode: Decode | null = null;
	let frameHandle: unknown = null;
	let hiddenTimer: unknown = null;
	let lastDecodeAt = Number.NEGATIVE_INFINITY;
	let decoding = false;
	let canvas: CanvasLike | null = null;
	let context: ContextLike | null = null;
	let logged = false;
	const listeners: Array<[ListenerTarget, string, () => void]> = [];

	const setState = (next: ScannerState) => {
		if (state === next) return;
		state = next;
		deps.onState?.(next);
	};

	const logOnce = (err: unknown) => {
		if (logged) return;
		logged = true;
		console.warn('screens/qr-scanner:', errorName(err));
	};

	const listen = (target: ListenerTarget, type: string, fn: () => void) => {
		target.addEventListener(type, fn);
		listeners.push([target, type, fn]);
	};

	const closeFrom = (reason: string) => {
		if (stopped) return;
		stop(reason);
		deps.onClose?.();
	};

	const onVisibility = () => {
		if (stopped) return;
		if (deps.doc.visibilityState === 'hidden') {
			if (hiddenTimer !== null) return;
			hiddenTimer = deps.setTimeout(() => {
				hiddenTimer = null;
				closeFrom('hidden');
			}, SCANNER_HIDDEN_STOP_MS);
		} else if (hiddenTimer !== null) {
			deps.clearTimeout(hiddenTimer);
			hiddenTimer = null;
		}
	};

	const onRoute = () => closeFrom('route');

	const schedule = () => {
		if (stopped) return;
		frameHandle = deps.requestFrame(onFrame);
	};

	const handleText = (text: string | null) => {
		if (stopped || text === null) return;
		const verdict = classifyScannedText(text);
		if (verdict.kind === 'other') {
			setState('not-pairing');
			return;
		}
		setState('found');
		stop('found');
		deps.onFound?.(verdict.code);
	};

	function onFrame() {
		frameHandle = null;
		if (stopped) return;
		const width = deps.video.videoWidth;
		const height = deps.video.videoHeight;
		const now = deps.now();
		if (decoding || !width || !height || now - lastDecodeAt < SCAN_INTERVAL_MS || decode === null) {
			schedule();
			return;
		}
		lastDecodeAt = now;
		let imageData: ImageDataLike;
		try {
			if (canvas === null || context === null || canvas.width !== width || canvas.height !== height) {
				canvas = deps.createCanvas(width, height);
				context = canvas.getContext('2d', { willReadFrequently: true });
			}
			if (context === null) throw new TypeError('no 2d context');
			context.drawImage(deps.video, 0, 0, width, height);
			imageData = context.getImageData(0, 0, width, height);
		} catch (err) {
			logOnce(err);
			schedule();
			return;
		}
		decoding = true;
		const run = decode;
		Promise.resolve()
			.then(() => run(imageData))
			.then(
				(text) => {
					decoding = false;
					handleText(typeof text === 'string' ? text : null);
				},
				(err) => {
					decoding = false;
					if (!stopped) logOnce(err);
				},
			);
		schedule();
	}

	function stop(_reason: string) {
		if (stopped) return;
		stopped = true;
		if (frameHandle !== null) {
			deps.cancelFrame(frameHandle);
			frameHandle = null;
		}
		if (hiddenTimer !== null) {
			deps.clearTimeout(hiddenTimer);
			hiddenTimer = null;
		}
		for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
		listeners.length = 0;
		if (stream !== null) {
			stopStream(stream);
			stream = null;
		}
		if (deps.video.srcObject) deps.video.srcObject = null;
		if (state !== 'found' && !ERROR_STATES.has(state)) setState('stopped');
	}

	const fail = (err: unknown, next: ScannerState) => {
		logOnce(err);
		if (stream !== null) {
			stopStream(stream);
			stream = null;
		}
		if (deps.video.srcObject) deps.video.srcObject = null;
		setState(next);
		stopped = true;
	};

	async function start() {
		if (started || stopped) return;
		started = true;
		if (!deps.isSecureContext) {
			setState('insecure');
			return;
		}
		const media = deps.mediaDevices;
		if (!media || typeof media.getUserMedia !== 'function') {
			setState('no-camera');
			return;
		}
		setState('asking');
		// The decoder chunk loads while the browser asks for the camera.
		const decoderReady = Promise.resolve()
			.then(() => deps.loadDecoder())
			.then(
				(d) => ({ ok: true as const, d }),
				(err: unknown) => ({ ok: false as const, err }),
			);
		let got: StreamLike | null = null;
		for (let i = 0; i < VIDEO_CONSTRAINT_LADDER.length; i++) {
			try {
				got = await media.getUserMedia(VIDEO_CONSTRAINT_LADDER[i]);
				break;
			} catch (err) {
				if (stopped) return;
				const overconstrained = errorName(err) === 'OverconstrainedError';
				if (overconstrained && i < VIDEO_CONSTRAINT_LADDER.length - 1) continue;
				fail(err, overconstrained ? 'unavailable' : mapCameraError(err));
				return;
			}
		}
		if (stopped) {
			// Closed while the browser was still asking: this stream is never shown.
			stopStream(got);
			return;
		}
		stream = got;
		const loaded = await decoderReady;
		if (stopped) return;
		if (!loaded.ok) {
			fail(loaded.err, 'unavailable');
			return;
		}
		decode = loaded.d;
		deps.video.srcObject = got;
		try {
			await deps.video.play?.();
		} catch (err) {
			if (stopped) return;
			fail(err, 'unavailable');
			return;
		}
		if (stopped || got === null) return;
		tryContinuousFocus(got);
		setState('scanning');
		listen(deps.doc, 'visibilitychange', onVisibility);
		listen(deps.win, 'popstate', onRoute);
		listen(deps.win, 'hashchange', onRoute);
		listen(deps.win, 'pagehide', onRoute);
		schedule();
	}

	return {
		start,
		stop,
		getState: () => state,
	};
}

/** The instruction line per state; every key is a literal. */
const STATE_LINE_KEYS: Readonly<Record<ScannerState, string | null>> = Object.freeze({
	asking: 'scanner.asking',
	denied: 'scanner.denied',
	'no-camera': 'scanner.noCamera',
	insecure: 'scanner.insecureContext',
	unavailable: 'scanner.unavailable',
	scanning: 'scanner.instruction',
	'not-pairing': 'scanner.instruction',
	found: 'scanner.found',
	stopped: null,
});

/** States in which the camera stage (video, frame, corners) is shown. */
const CAMERA_STATES: StateSet = new Set<ScannerState>(['asking', 'scanning', 'not-pairing']);

export interface ScannerStateViewProps {
	state: ScannerState;
	videoRef?: Ref<HTMLVideoElement>;
	closeRef?: Ref<HTMLButtonElement>;
	onClose?: () => void;
	onPasteInstead?: () => void;
}

/** The scanner dialog's content for one state. Hook-free. */
export function ScannerStateView(props: ScannerStateViewProps): ReactElement {
	const { state, videoRef, closeRef, onClose, onPasteInstead } = props;
	const lineKey = STATE_LINE_KEYS[state];
	const showStage = CAMERA_STATES.has(state);
	return (
		<div className="pr-scanner-body">
			<h2 id="pr-scanner-heading" className="pr-scanner-heading">
				{t('pairing.scanCta')}
			</h2>
			<p className="pr-scanner-line" aria-live="polite">
				{lineKey === null ? '' : t(lineKey)}
			</p>
			{state === 'not-pairing' ? <p className="pr-scanner-line">{t('scanner.notPairingCode')}</p> : null}
			<div className="pr-scanner-stage" hidden={!showStage}>
				<video className="pr-scanner-video" ref={videoRef} playsInline muted />
				<div className="pr-scanner-frame">
					<span className="pr-scanner-corner pr-scanner-corner--tl" />
					<span className="pr-scanner-corner pr-scanner-corner--tr" />
					<span className="pr-scanner-corner pr-scanner-corner--bl" />
					<span className="pr-scanner-corner pr-scanner-corner--br" />
				</div>
			</div>
			<div className="pr-scanner-actions">
				{state !== 'scanning' ? (
					<button type="button" className="pr-text-button" onClick={onPasteInstead}>
						{t('scanner.pasteInstead')}
					</button>
				) : null}
				<button type="button" className="pr-scanner-close" ref={closeRef} onClick={onClose}>
					{t('scanner.close')}
				</button>
			</div>
		</div>
	);
}

export interface QrScannerProps {
	open: boolean;
	onFound: (code: string) => void;
	onClose: () => void;
	onPasteInstead: () => void;
	deps?: Partial<ScannerDeps>;
}

/** The real browser objects the session uses, for a given video element. */
function browserDeps(video: VideoLike): Omit<ScannerDeps, 'onState' | 'onFound' | 'onClose'> {
	const g = globalThis as unknown as {
		navigator?: { mediaDevices?: ScannerDeps['mediaDevices'] };
		isSecureContext?: boolean;
		document: Document;
		window?: Window;
		performance?: { now(): number };
		requestAnimationFrame: (cb: () => void) => number;
		cancelAnimationFrame: (h: number) => void;
		setTimeout: (cb: () => void, ms: number) => unknown;
		clearTimeout: (h: unknown) => void;
	};
	return {
		video,
		mediaDevices: g.navigator?.mediaDevices ?? null,
		isSecureContext: g.isSecureContext === true,
		loadDecoder,
		createCanvas: (width, height) => {
			const c = g.document.createElement('canvas');
			c.width = width;
			c.height = height;
			return c as unknown as CanvasLike;
		},
		requestFrame: (cb) => g.requestAnimationFrame(cb),
		cancelFrame: (h) => g.cancelAnimationFrame(h as number),
		now: () => (g.performance ? g.performance.now() : Date.now()),
		setTimeout: (cb, ms) => g.setTimeout(cb, ms),
		clearTimeout: (h) => g.clearTimeout(h),
		doc: g.document as unknown as ScannerDeps['doc'],
		win: (g.window ?? globalThis) as unknown as ListenerTarget,
	};
}

/** The scanner as a native modal dialog. */
export function QrScanner(props: QrScannerProps): ReactElement {
	const { open, deps } = props;
	const dialogRef = useRef<HTMLDialogElement | null>(null);
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const closeRef = useRef<HTMLButtonElement | null>(null);
	const sessionRef = useRef<ScannerSession | null>(null);
	const callbacks = useRef(props);
	callbacks.current = props;
	const [state, setState] = useState<ScannerState>('asking');

	useEffect(() => {
		if (!open) return undefined;
		const dialog = dialogRef.current;
		const video = videoRef.current;
		if (dialog === null || video === null) return undefined;
		setState('asking');
		if (!dialog.open) {
			try {
				dialog.showModal();
			} catch {
				// Already modal elsewhere; the dialog still renders.
			}
		}
		closeRef.current?.focus();
		const session = createScannerSession({
			...browserDeps(video as unknown as VideoLike),
			...(deps ?? {}),
			onState: setState,
			onFound: (code) => callbacks.current.onFound(code),
			onClose: () => callbacks.current.onClose(),
		});
		sessionRef.current = session;
		void session.start();
		return () => {
			session.stop('unmount');
			sessionRef.current = null;
			if (dialog.open) dialog.close();
		};
		// One session per opening: `deps` (test injection) is read when the dialog opens.
	}, [open]);

	const dismiss = (reason: 'close' | 'cancel') => {
		sessionRef.current?.stop(reason);
		callbacks.current.onClose();
	};

	const pasteInstead = () => {
		sessionRef.current?.stop('paste');
		const dialog = dialogRef.current;
		if (dialog?.open) dialog.close();
		callbacks.current.onPasteInstead();
	};

	return (
		<dialog
			ref={dialogRef}
			className="pr-scanner"
			aria-labelledby="pr-scanner-heading"
			onCancel={(event) => {
				event.preventDefault();
				dismiss('cancel');
			}}
		>
			<ScannerStateView
				state={state}
				videoRef={videoRef}
				closeRef={closeRef}
				onClose={() => dismiss('close')}
				onPasteInstead={pasteInstead}
			/>
		</dialog>
	);
}

export default QrScanner;
