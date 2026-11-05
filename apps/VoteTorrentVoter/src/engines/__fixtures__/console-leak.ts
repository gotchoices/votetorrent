/**
 * console-leak.ts - TEST ONLY - Phase 64 Plan 18 (notes 4.3, D-06). JEST-ONLY test fixture, never
 * imported by non-test code, so Metro never bundles it.
 *
 * Lives under `__fixtures__`, not `__tests__`, because this app's jest `testMatch` only collects
 * `__tests__/**` and `*.test.ts(x)`: a file here is importable by tests but never itself a test.
 *
 * The join code is a bearer credential. This helper captures every console call made while a test
 * runs and fails if the code, or any `windowChars`-long slice of it (default 16), shows up in any
 * argument at any depth. It is the Voter copy of 64-10's Authority helper: same API, same
 * semantics, and `console-leak.test.ts` pins the two files to each other (comment-stripped, they
 * must be identical), so a change to one must be made in both.
 *
 * Failure messages carry offsets, lengths, the console method and the call number only. They never
 * interpolate a secret, a window of it, or the captured text.
 */

type Method = 'log' | 'info' | 'warn' | 'error' | 'debug';

const METHODS: readonly Method[] = ['log', 'info', 'warn', 'error', 'debug'];
const MAX_DEPTH = 32;
const MAX_NODES = 100000;

export interface ConsoleCapture {
	calls(): unknown[][];
	restore(): void;
}

interface Entry {
	method: Method;
	order: number;
	args: unknown[];
}

interface Internal {
	spies: Array<{ method: Method; spy: jest.SpyInstance }>;
	restored: boolean;
}

const internals = new WeakMap<ConsoleCapture, Internal>();
let active = false;

export function captureConsole(): ConsoleCapture {
	if (active) throw new Error('console-leak: a capture is already active');
	active = true;
	const state: Internal = { spies: [], restored: false };
	try {
		for (const method of METHODS) {
			state.spies.push({ method, spy: jest.spyOn(console, method).mockImplementation(() => {}) });
		}
	} catch (e) {
		for (const s of state.spies) s.spy.mockRestore();
		active = false;
		throw e;
	}
	const capture: ConsoleCapture = {
		calls(): unknown[][] {
			return entriesOf(state).map((e) => e.args);
		},
		restore(): void {
			if (state.restored) return;
			state.restored = true;
			for (const s of state.spies) s.spy.mockRestore();
			active = false;
		},
	};
	internals.set(capture, state);
	return capture;
}

function entriesOf(state: Internal): Entry[] {
	const out: Entry[] = [];
	for (const { method, spy } of state.spies) {
		spy.mock.calls.forEach((args, i) => {
			out.push({ method, order: spy.mock.invocationCallOrder[i] ?? 0, args: args as unknown[] });
		});
	}
	out.sort((a, b) => a.order - b.order);
	return out;
}

class Uninspectable extends Error {}

interface Walk {
	parts: string[];
	seen: WeakSet<object>;
	nodes: number;
	binary: { ctor: string; bytes: number } | undefined;
	allowBinary: boolean;
}

function walk(value: unknown, w: Walk, depth: number): void {
	if (depth > MAX_DEPTH || ++w.nodes > MAX_NODES) throw new Uninspectable();
	switch (typeof value) {
		case 'string':
			w.parts.push(value);
			return;
		case 'number':
		case 'boolean':
		case 'bigint':
		case 'symbol':
			w.parts.push(String(value));
			return;
		case 'undefined':
			return;
		case 'function':
			w.parts.push((value as { name?: string }).name ?? '');
			return;
		default:
			break;
	}
	if (value === null) return;
	const obj = value as object;
	if (w.seen.has(obj)) return;
	w.seen.add(obj);

	if (obj instanceof ArrayBuffer || ArrayBuffer.isView(obj)) {
		if (!w.allowBinary && !w.binary) {
			w.binary = {
				ctor: (obj as { constructor?: { name?: string } }).constructor?.name ?? 'binary',
				bytes: (obj as { byteLength: number }).byteLength,
			};
		}
		return;
	}
	if (obj instanceof Error) {
		w.parts.push(String(obj.name), String(obj.message), String(obj.stack ?? ''));
		walk((obj as { cause?: unknown }).cause, w, depth + 1);
	}
	if (Array.isArray(obj)) {
		for (const item of obj) walk(item, w, depth + 1);
		return;
	}
	if (obj instanceof Map) {
		for (const [k, v] of obj) {
			walk(k, w, depth + 1);
			walk(v, w, depth + 1);
		}
		return;
	}
	if (obj instanceof Set) {
		for (const v of obj) walk(v, w, depth + 1);
		return;
	}
	for (const key of Object.keys(obj)) {
		w.parts.push(key);
		walk((obj as Record<string, unknown>)[key], w, depth + 1);
	}
}

function safeJson(value: unknown): string {
	const seen = new WeakSet<object>();
	try {
		return (
			JSON.stringify(value, (_k, v: unknown) => {
				if (typeof v === 'object' && v !== null) {
					if (seen.has(v)) return undefined;
					seen.add(v);
				}
				return v;
			}) ?? ''
		);
	} catch {
		return '';
	}
}

function haystackOf(entry: Entry, k: number, allowBinary: boolean): { full: string; raw: string } {
	const w: Walk = { parts: [], seen: new WeakSet(), nodes: 0, binary: undefined, allowBinary };
	try {
		for (const arg of entry.args) walk(arg, w, 0);
	} catch {
		throw new Error(`console-leak: console.${entry.method} call #${k} could not be fully inspected`);
	}
	if (w.binary) {
		throw new Error(
			`console-leak: console.${entry.method} call #${k} carries a binary argument (${w.binary.ctor}, ${w.binary.bytes} bytes)`,
		);
	}
	const raw = w.parts.join('');
	for (const arg of entry.args) w.parts.push(safeJson(arg));
	return { full: w.parts.join('\n'), raw };
}

function windowsOf(text: string, width: number): Set<string> {
	const set = new Set<string>();
	for (let o = 0; o + width <= text.length; o++) set.add(text.slice(o, o + width));
	return set;
}

/** Offset of the first secret window that appears in the haystack, or -1; `whole` when the secret itself matched. */
function firstHit(secret: string, haystack: string, width: number): { offset: number; whole: boolean } | undefined {
	if (secret.length < width) {
		return haystack.includes(secret) ? { offset: 0, whole: true } : undefined;
	}
	if (haystack.includes(secret)) return { offset: 0, whole: true };
	const set = windowsOf(haystack, width);
	for (let o = 0; o + width <= secret.length; o++) {
		if (set.has(secret.slice(o, o + width))) return { offset: o, whole: false };
	}
	return undefined;
}

export function expectNoSecretInConsole(
	c: ConsoleCapture,
	secrets: readonly string[],
	opts?: { windowChars?: number; allowBinary?: boolean },
): void {
	const width = opts?.windowChars ?? 16;
	if (!Array.isArray(secrets) || secrets.length === 0) throw new Error('console-leak: no secrets given');
	for (const s of secrets) {
		if (typeof s !== 'string' || s.length === 0) throw new Error('console-leak: every secret must be a non-empty string');
	}
	if (!Number.isInteger(width) || width < 1) throw new Error('console-leak: windowChars must be a positive integer');
	const state = internals.get(c);
	if (!state) throw new Error('console-leak: unknown capture');

	const entries = entriesOf(state);
	const hays = entries.map((e, i) => haystackOf(e, i + 1, opts?.allowBinary === true));

	for (let i = 0; i < secrets.length; i++) {
		const secret = secrets[i];
		for (let j = 0; j < hays.length; j++) {
			const hit = firstHit(secret, hays[j].full, width);
			if (hit) throw new Error(leakMessage(i, secret.length, hit, width, `console.${entries[j].method} call #${j + 1}`));
		}
		const hit = firstHit(secret, hays.map((h) => h.raw).join(''), width);
		if (hit) throw new Error(leakMessage(i, secret.length, hit, width, 'across console calls'));
	}
}

function leakMessage(
	index: number,
	length: number,
	hit: { offset: number; whole: boolean },
	width: number,
	where: string,
): string {
	const what = hit.whole ? 'the full secret' : `a ${width}-char window at offset ${hit.offset}`;
	return `console-leak: secret #${index} (${length} chars) leaked: ${what} appears ${where.startsWith('across') ? where : `in ${where}`}`;
}
