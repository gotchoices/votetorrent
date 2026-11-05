/**
 * scanner-teardown.test.mjs -- tier-1 rows for the webcam QR scanner
 * (`src/screens/QrScanner.tsx`).
 *
 * Behaviour runs the REAL scanner controller (`createScannerSession`) in this
 * process against fakes for every browser object: camera tracks whose
 * `stop()` flips `readyState` to 'ended', a deferred getUserMedia, a video
 * element, a canvas factory that records its calls, listener-counting event
 * targets for `document` and `window`, a manual clock with manual timers and
 * frames, and a scripted decoder. No real waits: time only moves when a row
 * moves it.
 *
 * The .tsx module is loaded through a small module hook registered below: it
 * transpiles .ts/.tsx with the dashboard's own TypeScript (`transpileModule`,
 * react-jsx), maps a missing relative `.js` import to its `.ts`/`.tsx`
 * sibling (the bundler's mapping) and turns `.css` imports into empty
 * modules. Rendering uses react-dom/server.
 *
 * Structure rows run over comment-stripped source, each matcher proven on a
 * planted fixture first.
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { COPY } from '@votetorrent/ui-web';
import { dashboardRoot, dashboardSrc, moduleUrl } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';
import { stripCssComments } from '../../../../scripts/lib/css-class-coverage.mjs';

// --- TSX harness ---------------------------------------------------------------

const tsUrl = pathToFileURL(createRequire(dashboardRoot('package.json')).resolve('typescript')).href;

const LOADER = [
	"import { readFileSync } from 'node:fs';",
	"import { fileURLToPath } from 'node:url';",
	'let ts;',
	'export async function initialize(data) {',
	'\tconst mod = await import(data.tsUrl);',
	'\tts = mod.default ?? mod;',
	'}',
	'const isTs = (url) => typeof url === "string" && /\\.tsx?$/.test(url.split("?")[0]);',
	'export async function resolve(specifier, context, next) {',
	'\ttry {',
	'\t\treturn await next(specifier, context);',
	'\t} catch (err) {',
	"\t\tconst relative = specifier.startsWith('./') || specifier.startsWith('../');",
	"\t\tif (!relative || !isTs(context.parentURL) || !err || err.code !== 'ERR_MODULE_NOT_FOUND') throw err;",
	"\t\tconst base = specifier.endsWith('.js') ? specifier.slice(0, -3) : specifier;",
	"\t\tfor (const candidate of [base + '.tsx', base + '.ts']) {",
	'\t\t\ttry {',
	'\t\t\t\treturn await next(candidate, context);',
	'\t\t\t} catch {',
	'\t\t\t\t// try the next candidate',
	'\t\t\t}',
	'\t\t}',
	'\t\tthrow err;',
	'\t}',
	'}',
	'export async function load(url, context, next) {',
	"\tconst bare = url.split('?')[0];",
	"\tif (bare.endsWith('.css')) return { format: 'module', source: 'export default undefined;', shortCircuit: true };",
	'\tif (isTs(bare)) {',
	'\t\tconst file = fileURLToPath(bare);',
	"\t\tconst out = ts.transpileModule(readFileSync(file, 'utf8'), {",
	'\t\t\tfileName: file,',
	'\t\t\tcompilerOptions: {',
	'\t\t\t\tjsx: ts.JsxEmit.ReactJSX,',
	'\t\t\t\tmodule: ts.ModuleKind.ESNext,',
	'\t\t\t\ttarget: ts.ScriptTarget.ES2022,',
	'\t\t\t},',
	'\t\t});',
	"\t\treturn { format: 'module', source: out.outputText, shortCircuit: true };",
	'\t}',
	'\treturn next(url, context);',
	'}',
].join('\n');

register('data:text/javascript,' + encodeURIComponent(LOADER), import.meta.url, { data: { tsUrl } });

const QR_SCANNER_PATH = dashboardSrc('screens', 'QrScanner.tsx');
/** @type {any} */
const Q = await import(moduleUrl(QR_SCANNER_PATH));
/** @type {any} */
const VE = await import('@votetorrent/vote-engine/browser');

// --- fakes ---------------------------------------------------------------------

function makeTrack() {
	/** @type {any} */
	const track = {
		readyState: 'live',
		stopCalls: 0,
		/** @type {any} */
		capabilities: null,
		/** @type {any[]} */
		applied: [],
		applyRejects: false,
		stop() {
			track.stopCalls += 1;
			track.readyState = 'ended';
		},
		getCapabilities() {
			return track.capabilities;
		},
		/** @param {any} c */
		applyConstraints(c) {
			track.applied.push(c);
			return track.applyRejects ? Promise.reject(Object.assign(new Error('x'), { name: 'OverconstrainedError' })) : Promise.resolve();
		},
	};
	return track;
}

/** @param {number} [n] */
function makeStream(n = 1) {
	const tracks = Array.from({ length: n }, () => makeTrack());
	return {
		tracks,
		getTracks: () => tracks,
		getVideoTracks: () => tracks,
		allEnded: () => tracks.every((tr) => tr.readyState === 'ended'),
		anyLive: () => tracks.some((tr) => tr.readyState === 'live'),
	};
}

function deferred() {
	/** @type {any} */
	let resolve;
	/** @type {any} */
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function makeTarget() {
	/** @type {Map<string, Set<Function>>} */
	const map = new Map();
	/** @type {any} */
	const target = {
		visibilityState: 'visible',
		/** @param {string} type @param {Function} fn */
		addEventListener(type, fn) {
			if (!map.has(type)) map.set(type, new Set());
			/** @type {Set<Function>} */ (map.get(type)).add(fn);
		},
		/** @param {string} type @param {Function} fn */
		removeEventListener(type, fn) {
			map.get(type)?.delete(fn);
		},
		count() {
			let n = 0;
			for (const set of map.values()) n += set.size;
			return n;
		},
		/** @param {string} type */
		dispatch(type) {
			for (const fn of [...(map.get(type) ?? [])]) fn();
		},
	};
	return target;
}

/**
 * Builds a full fake environment and a session over it.
 * @param {any} [opts]
 */
function setup(opts = {}) {
	const log = /** @type {any[]} */ ([]);
	const states = /** @type {string[]} */ ([]);
	let clock = 1_000;
	/** @type {Map<number, Function>} */
	const frames = new Map();
	let frameSeq = 0;
	const cancelled = /** @type {number[]} */ ([]);
	/** @type {Map<number, { at: number, fn: Function }>} */
	const timers = new Map();
	let timerSeq = 0;
	const gumCalls = /** @type {any[]} */ ([]);
	/** @type {any[]} */
	const gumQueue = opts.gum ?? [];
	/** @type {any} */
	const video = {
		srcSets: /** @type {any[]} */ ([]),
		_src: /** @type {any} */ (null),
		get srcObject() {
			return video._src;
		},
		set srcObject(v) {
			video.srcSets.push(v);
			video._src = v;
		},
		videoWidth: 1280,
		videoHeight: 720,
		playCalls: 0,
		play() {
			video.playCalls += 1;
			return Promise.resolve();
		},
	};
	const canvasCalls = /** @type {any[]} */ ([]);
	const decodeInputs = /** @type {any[]} */ ([]);
	/** @type {any[]} */
	const decodeScript = opts.decode ?? [];
	let decodeCalls = 0;
	const doc = makeTarget();
	const win = makeTarget();
	const found = /** @type {any[]} */ ([]);
	let closes = 0;
	/** @type {any} */
	const env = {
		video,
		doc,
		win,
		states,
		found,
		gumCalls,
		frames,
		cancelled,
		timers,
		canvasCalls,
		decodeInputs,
		log,
		get closes() {
			return closes;
		},
		get decodeCalls() {
			return decodeCalls;
		},
		/** @type {any} */
		atFound: null,
		/** @type {any} */
		stream: null,
		advance(/** @type {number} */ ms) {
			const target = clock + ms;
			for (;;) {
				const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at);
				if (due.length === 0) break;
				const [id, t] = due[0];
				timers.delete(id);
				clock = t.at;
				t.fn();
			}
			clock = target;
		},
		setNow(/** @type {number} */ v) {
			clock = v;
		},
		now: () => clock,
		runFrames() {
			const pending = [...frames.entries()];
			frames.clear();
			for (const [, fn] of pending) fn();
		},
	};
	const mediaDevices =
		opts.noMediaDevices === true
			? undefined
			: opts.noGetUserMedia === true
				? {}
				: {
						/** @param {any} c */
						getUserMedia(c) {
							gumCalls.push(c);
							const next = gumQueue.shift();
							if (next === undefined) {
								const s = makeStream();
								env.stream = s;
								return Promise.resolve(s);
							}
							if (next && next.reject) return Promise.reject(next.reject);
							if (next && next.deferred) return next.deferred.promise;
							env.stream = next;
							return Promise.resolve(next);
						},
					};
	const deps = {
		video,
		mediaDevices,
		isSecureContext: opts.insecure !== true,
		loadDecoder:
			opts.loadDecoder ??
			(async () =>
				/** @param {any} img */
				async (img) => {
					decodeCalls += 1;
					decodeInputs.push({ width: img.width, height: img.height });
					const step = decodeScript.shift();
					if (step && step.pending) return step.pending.promise;
					return step === undefined ? null : step;
				}),
		/** @param {number} w @param {number} h */
		createCanvas(w, h) {
			canvasCalls.push(['create', w, h]);
			return {
				width: w,
				height: h,
				/** @param {string} kind @param {any} options */
				getContext(kind, options) {
					canvasCalls.push(['getContext', kind, options]);
					return {
						/** @param {any} src @param {number} x @param {number} y @param {number} ww @param {number} hh */
						drawImage(src, x, y, ww, hh) {
							canvasCalls.push(['drawImage', src === video, x, y, ww, hh]);
						},
						/** @param {number} x @param {number} y @param {number} ww @param {number} hh */
						getImageData(x, y, ww, hh) {
							canvasCalls.push(['getImageData', x, y, ww, hh]);
							return { data: new Uint8ClampedArray(4), width: ww, height: hh };
						},
					};
				},
			};
		},
		/** @param {Function} fn */
		requestFrame(fn) {
			frameSeq += 1;
			frames.set(frameSeq, fn);
			return frameSeq;
		},
		/** @param {number} h */
		cancelFrame(h) {
			cancelled.push(h);
			frames.delete(h);
		},
		now: () => clock,
		/** @param {Function} fn @param {number} ms */
		setTimeout(fn, ms) {
			timerSeq += 1;
			timers.set(timerSeq, { at: clock + ms, fn });
			return timerSeq;
		},
		/** @param {number} h */
		clearTimeout(h) {
			timers.delete(h);
		},
		doc,
		win,
		/** @param {string} s */
		onState: (s) => states.push(s),
		/** @param {string} code */
		onFound: (code) => {
			env.atFound = { code, ended: env.stream ? env.stream.allEnded() : null, state: session.getState() };
			found.push(code);
		},
		onClose: () => {
			closes += 1;
		},
	};
	const session = Q.createScannerSession(deps);
	return { session, env, deps };
}

const flush = async () => {
	for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

/** Starts a session and settles it into `scanning`. @param {any} [opts] */
async function scanning(opts) {
	const ctx = setup(opts);
	await ctx.session.start();
	await flush();
	assert.equal(ctx.session.getState(), 'scanning');
	return ctx;
}

const CODE = 'vtpair1.' + 'A'.repeat(64);

// --- rows ----------------------------------------------------------------------

test('S1 found: every track is ended BEFORE onFound runs; onFound gets the whitespace-stripped code; no decode after', async () => {
	const { session, env } = await scanning({ decode: [' vtpair1.AB\n CD \t'] });
	env.runFrames();
	await flush();
	assert.equal(env.found.length, 1);
	assert.equal(env.found[0], 'vtpair1.ABCD');
	assert.equal(env.atFound.ended, true, 'tracks must be ended before onFound');
	assert.equal(session.getState(), 'found');
	const calls = env.decodeCalls;
	env.advance(1_000);
	env.runFrames();
	await flush();
	assert.equal(env.decodeCalls, calls, 'no decode after found');
	assert.equal(env.frames.size, 0);
});

for (const reason of ['close', 'cancel']) {
	test(`S${reason === 'close' ? 2 : 3} ${reason}: stop('${reason}') ends every track, clears srcObject, cancels the frame and removes every listener`, async () => {
		const stream = makeStream(2);
		const { session, env } = await scanning({ gum: [stream] });
		assert.ok(env.doc.count() > 0 && env.win.count() > 0, 'sanity: listeners were added');
		assert.equal(env.video.srcObject, stream);
		assert.equal(env.frames.size, 1, 'sanity: a frame is pending');
		const pendingHandle = [...env.frames.keys()][0];
		session.stop(reason);
		assert.equal(stream.allEnded(), true);
		assert.equal(env.video.srcObject, null);
		assert.ok(env.cancelled.includes(pendingHandle));
		assert.equal(env.frames.size, 0);
		assert.equal(env.doc.count(), 0);
		assert.equal(env.win.count(), 0);
		assert.equal(session.getState(), 'stopped');
	});
}

test('S4 route change: popstate, hashchange and pagehide each end every track and call onClose once', async () => {
	for (const type of ['popstate', 'hashchange', 'pagehide']) {
		const { env } = await scanning();
		const stream = env.stream;
		env.win.dispatch(type);
		assert.equal(stream.allEnded(), true, `${type} ends the tracks`);
		assert.equal(env.closes, 1, `${type} calls onClose once`);
		env.win.dispatch(type);
		assert.equal(env.closes, 1, `${type} a second time does nothing`);
		assert.equal(env.win.count(), 0);
	}
});

test('S5 hidden: tracks live at 59 999 ms, ended at 60 000 ms with one onClose; a return to visible cancels the countdown', async () => {
	assert.equal(Q.SCANNER_HIDDEN_STOP_MS, 60_000);
	{
		const { env } = await scanning();
		env.doc.visibilityState = 'hidden';
		env.doc.dispatch('visibilitychange');
		env.advance(59_999);
		assert.equal(env.stream.anyLive(), true);
		assert.equal(env.closes, 0);
		env.advance(1);
		assert.equal(env.stream.allEnded(), true);
		assert.equal(env.closes, 1);
	}
	{
		const { env } = await scanning();
		env.doc.visibilityState = 'hidden';
		env.doc.dispatch('visibilitychange');
		env.advance(30_000);
		env.doc.visibilityState = 'visible';
		env.doc.dispatch('visibilitychange');
		env.advance(60_000);
		assert.equal(env.stream.anyLive(), true);
		assert.equal(env.closes, 0);
	}
});

test('S6 late stream: a stream arriving after stop() is ended at once and never attached', async () => {
	const late = deferred();
	const { session, env } = setup({ gum: [{ deferred: late }] });
	const started = session.start();
	await flush();
	assert.equal(session.getState(), 'asking');
	session.stop('close');
	const stream = makeStream(2);
	late.resolve(stream);
	await started;
	await flush();
	assert.equal(stream.allEnded(), true);
	assert.deepEqual(env.video.srcSets, [], 'srcObject never set');
	assert.equal(env.doc.count() + env.win.count(), 0);
});

test('S7 errors: insecure, no camera, denied, no-camera, unavailable, decoder failure and the constraint ladder', async () => {
	{
		const { session, env } = setup({ insecure: true });
		await session.start();
		assert.equal(session.getState(), 'insecure');
		assert.equal(env.gumCalls.length, 0);
	}
	for (const flag of ['noMediaDevices', 'noGetUserMedia']) {
		const { session } = setup({ [flag]: true });
		await session.start();
		assert.equal(session.getState(), 'no-camera', flag);
	}
	const named = (/** @type {string} */ name) => Object.assign(new Error('camera'), { name });
	for (const [name, expected] of [
		['NotAllowedError', 'denied'],
		['SecurityError', 'denied'],
		['NotFoundError', 'no-camera'],
		['NotReadableError', 'unavailable'],
		['AbortError', 'unavailable'],
	]) {
		const { session } = setup({ gum: [{ reject: named(name) }] });
		await session.start();
		await flush();
		assert.equal(session.getState(), expected, name);
		assert.equal(Q.mapCameraError(named(name)), expected);
	}
	{
		const { session, env } = setup({
			loadDecoder: async () => {
				throw Object.assign(new Error('chunk'), { name: 'ChunkLoadError' });
			},
		});
		await session.start();
		await flush();
		assert.equal(session.getState(), 'unavailable');
		assert.equal(env.stream.allEnded(), true, 'a stream obtained before the decoder failed is stopped');
	}
	{
		const over = { reject: named('OverconstrainedError') };
		const { session, env } = setup({ gum: [over, { reject: named('OverconstrainedError') }, { reject: named('OverconstrainedError') }] });
		await session.start();
		await flush();
		assert.equal(env.gumCalls.length, 3);
		assert.equal(session.getState(), 'unavailable');
	}
	{
		const pending = deferred();
		const { session } = setup({ gum: [{ deferred: pending }] });
		const started = session.start();
		await flush();
		assert.equal(session.getState(), 'asking');
		pending.resolve(makeStream());
		await started;
		await flush();
		assert.equal(session.getState(), 'scanning');
		session.stop('close');
	}
});

test('S8 constraints: the three-step ladder, and continuous focus only where the track offers it', async () => {
	const named = (/** @type {string} */ name) => Object.assign(new Error('camera'), { name });
	const { env } = await scanning({ gum: [{ reject: named('OverconstrainedError') }, { reject: named('OverconstrainedError') }] });
	assert.deepEqual(JSON.parse(JSON.stringify(env.gumCalls)), [
		{ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } },
		{ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
		{ audio: false, video: true },
	]);
	assert.equal(Object.isFrozen(Q.VIDEO_CONSTRAINT_LADDER), true);
	assert.equal(Q.VIDEO_CONSTRAINT_LADDER.length, 3);
	assert.equal(env.stream.tracks[0].applied.length, 0, 'no capabilities -> no focus request');

	const withFocus = makeStream();
	withFocus.tracks[0].capabilities = { focusMode: ['manual', 'continuous'] };
	withFocus.tracks[0].applyRejects = true;
	const a = await scanning({ gum: [withFocus] });
	assert.deepEqual(withFocus.tracks[0].applied, [{ advanced: [{ focusMode: 'continuous' }] }]);
	assert.equal(a.session.getState(), 'scanning', 'an applyConstraints rejection is ignored');

	const noContinuous = makeStream();
	noContinuous.tracks[0].capabilities = { focusMode: ['manual'] };
	await scanning({ gum: [noContinuous] });
	assert.equal(noContinuous.tracks[0].applied.length, 0);
});

test('S9 payloads: a non-pairing QR keeps scanning; a later pairing code is found; oversized payloads are not pairing codes', async () => {
	const { session, env } = await scanning({ decode: ['https://example.com', CODE] });
	env.runFrames();
	await flush();
	assert.equal(session.getState(), 'not-pairing');
	assert.equal(env.stream.anyLive(), true);
	assert.equal(env.found.length, 0);
	env.advance(Q.SCAN_INTERVAL_MS);
	env.runFrames();
	await flush();
	assert.equal(session.getState(), 'found');
	assert.deepEqual(env.found, [CODE]);

	assert.deepEqual(Q.classifyScannedText(CODE), { kind: 'pairing', code: CODE });
	assert.deepEqual(Q.classifyScannedText('https://example.com'), { kind: 'other' });
	const overChars = VE.PAIRING_CODE_PREFIX + 'A'.repeat(VE.PAIRING_CODE_MAX_CHARS);
	assert.deepEqual(Q.classifyScannedText(overChars), { kind: 'other' });
	const overBytes = VE.PAIRING_CODE_PREFIX + 'A'.repeat(VE.PAIRING_QR_BYTE_BUDGET);
	assert.ok(overBytes.length <= VE.PAIRING_CODE_MAX_CHARS, 'sanity: under the char cap, over the byte budget');
	assert.deepEqual(Q.classifyScannedText(overBytes), { kind: 'other' });
	const atBudget = VE.PAIRING_CODE_PREFIX + 'A'.repeat(VE.PAIRING_QR_BYTE_BUDGET - VE.PAIRING_CODE_PREFIX.length);
	assert.equal(Q.classifyScannedText(atBudget).kind, 'pairing');
	const multiByte = VE.PAIRING_CODE_PREFIX + 'é'.repeat(1_500);
	assert.ok(multiByte.length <= VE.PAIRING_QR_BYTE_BUDGET, 'sanity: under the budget in chars');
	assert.deepEqual(Q.classifyScannedText(multiByte), { kind: 'other' }, 'the budget counts UTF-8 bytes');
});

test('S10 full frame: the canvas is the video size and the decoder sees the whole 1280 x 720 frame', async () => {
	const { env } = await scanning();
	env.runFrames();
	await flush();
	assert.deepEqual(env.canvasCalls, [
		['create', 1280, 720],
		['getContext', '2d', { willReadFrequently: true }],
		['drawImage', true, 0, 0, 1280, 720],
		['getImageData', 0, 0, 1280, 720],
	]);
	assert.deepEqual(env.decodeInputs, [{ width: 1280, height: 720 }]);
});

test('S11 throttle: one decode per SCAN_INTERVAL_MS, and a pending decode blocks the next', async () => {
	assert.equal(Q.SCAN_INTERVAL_MS, 200);
	const pending = deferred();
	const { env } = await scanning({ decode: [null, { pending }, null] });
	env.runFrames();
	await flush();
	assert.equal(env.decodeCalls, 1);
	env.advance(199);
	env.runFrames();
	await flush();
	assert.equal(env.decodeCalls, 1, 'under the interval: no decode');
	env.advance(1);
	env.runFrames();
	await flush();
	assert.equal(env.decodeCalls, 2);
	env.advance(1_000);
	env.runFrames();
	await flush();
	assert.equal(env.decodeCalls, 2, 'a pending decode blocks the next one');
	pending.resolve(null);
	await flush();
	env.runFrames();
	await flush();
	assert.equal(env.decodeCalls, 3);
});

test('S12 idempotent: a second stop() makes no calls', async () => {
	const { session, env } = await scanning();
	session.stop('close');
	const before = {
		stops: env.stream.tracks.map((/** @type {any} */ tr) => tr.stopCalls),
		cancelled: env.cancelled.length,
		srcSets: env.video.srcSets.length,
		states: env.states.length,
	};
	session.stop('close');
	session.stop('cancel');
	assert.deepEqual(
		{
			stops: env.stream.tracks.map((/** @type {any} */ tr) => tr.stopCalls),
			cancelled: env.cancelled.length,
			srcSets: env.video.srcSets.length,
			states: env.states.length,
		},
		before,
	);
});

test('S13 adapter: the jsqr-shaped module returns the text on a hit and null on a miss', async () => {
	/** @type {any[]} */
	const seen = [];
	/** @param {any} data @param {number} w @param {number} h @param {any} o */
	const fakeJsqr = (data, w, h, o) => {
		seen.push({ len: data.length, w, h, o });
		return data[0] === 1 ? { data: CODE } : null;
	};
	const img = (/** @type {number} */ first) => ({ data: new Uint8ClampedArray([first, 0, 0, 0]), width: 1, height: 1 });
	for (const shape of [{ default: fakeJsqr }, fakeJsqr, { default: { default: fakeJsqr } }]) {
		const decode = Q.adaptDecoderModule(shape);
		assert.equal(await decode(img(1)), CODE);
		assert.equal(await decode(img(0)), null);
	}
	assert.deepEqual(seen[0], { len: 4, w: 1, h: 1, o: { inversionAttempts: 'dontInvert' } });
	assert.throws(() => Q.adaptDecoderModule({}), TypeError);
	// The real package, in the shape Node hands it over.
	const real = Q.adaptDecoderModule(await import('jsqr'));
	assert.equal(await real({ data: new Uint8ClampedArray(16 * 16 * 4), width: 16, height: 16 }), null);
});

test('S14 render: every state shows its copy, the right buttons and (while scanning) the video and four corners', () => {
	/** @param {string} state */
	const html = (state) => renderToStaticMarkup(createElement(Q.ScannerStateView, { state }));
	const esc = (/** @type {string} */ s) => s.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');
	const has = (/** @type {string} */ h, /** @type {string} */ key) => h.includes(esc(COPY[key]));
	for (const [state, key] of [
		['asking', 'scanner.asking'],
		['denied', 'scanner.denied'],
		['no-camera', 'scanner.noCamera'],
		['insecure', 'scanner.insecureContext'],
		['unavailable', 'scanner.unavailable'],
	]) {
		const h = html(state);
		assert.ok(has(h, key), `${state} shows ${key}`);
		assert.ok(has(h, 'scanner.pasteInstead'), `${state} offers paste instead`);
		assert.ok(has(h, 'scanner.close'), `${state} has Close scanner`);
	}
	const scan = html('scanning');
	assert.match(scan, /<p[^>]*aria-live="polite"[^>]*>Hold the QR code inside the frame/);
	assert.match(scan, /<video[^>]*class="pr-scanner-video"/);
	assert.doesNotMatch(scan, /<div class="pr-scanner-stage" hidden/);
	for (const c of ['tl', 'tr', 'bl', 'br']) assert.ok(scan.includes(`pr-scanner-corner pr-scanner-corner--${c}`), c);
	assert.ok(has(scan, 'scanner.close'));
	assert.ok(!has(scan, 'scanner.pasteInstead'), 'scanning shows no paste button');
	const np = html('not-pairing');
	assert.ok(has(np, 'scanner.instruction'));
	assert.ok(has(np, 'scanner.notPairingCode'));
	assert.ok(has(np, 'scanner.close'));
	const found = html('found');
	assert.ok(has(found, 'scanner.found'));
	assert.ok(has(found, 'scanner.close'));
	assert.match(html('denied'), /<div class="pr-scanner-stage" hidden=""/, 'error states hide the camera stage');
});

test('S15 source scans: lazy decoder only, dialog wiring, no storage or payload echo, one console line, literal keys, unmirrored video', () => {
	const code = stripComments(readFileSync(QR_SCANNER_PATH, 'utf8'));
	const css = stripCssComments(readFileSync(dashboardSrc('screens', 'pairing.css'), 'utf8'));
	const STATIC_DECODER = /^\s*import\s[^(]*from\s*['"](jsqr|zxing-wasm)['"]/m;
	const LAZY_DECODER = /import\(\s*['"]jsqr['"]\s*\)/;
	const CONSOLE = /\bconsole\./g;
	const PAYLOAD_ATTR = /(title|aria-label)=\{[^}]*(code|text|payload)/i;
	// Positive controls: each matcher fires on a planted fixture.
	assert.match("import jsQR from 'jsqr';", STATIC_DECODER);
	assert.match("await import('jsqr')", LAZY_DECODER);
	assert.equal('console.warn(a); console.log(b)'.match(CONSOLE)?.length, 2);
	assert.match('<p title={code}>', PAYLOAD_ATTR);
	assert.match('localStorage.setItem()', /localStorage/);

	assert.doesNotMatch(code, STATIC_DECODER);
	assert.match(code, LAZY_DECODER);
	assert.doesNotMatch(code, /zxing/);
	assert.match(code, /showModal\(/);
	assert.match(code, /onCancel/);
	assert.doesNotMatch(code, /localStorage|sessionStorage/);
	assert.doesNotMatch(code, PAYLOAD_ATTR);
	assert.doesNotMatch(code, /\{\s*(code|text|verdict\.code)\s*\}/, 'the payload is never rendered');
	assert.equal(code.match(CONSOLE)?.length, 1, 'exactly one console call');
	assert.match(code, /console\.warn\('screens\/qr-scanner:', errorName\(err\)\)/);
	assert.doesNotMatch(code, /t\(`/, 'no template-literal copy key');
	for (const key of Object.keys(COPY).filter((k) => k.startsWith('scanner.'))) {
		assert.ok(code.includes(`'${key}'`), `${key} occurs as a string literal`);
	}
	// The video rule carries no transform, and nothing mirrors.
	assert.match('.x { transform: scaleX(-1); }', /scaleX\(-1\)/);
	assert.doesNotMatch(css, /scaleX\(-1\)|rotateY\(/);
	const videoRule = css.match(/\.pr-scanner-video\s*\{[^}]*\}/);
	assert.ok(videoRule, 'sanity: the video rule exists');
	assert.doesNotMatch(videoRule[0], /transform/);
});
