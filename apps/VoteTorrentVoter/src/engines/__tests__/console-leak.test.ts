/**
 * console-leak.test.ts - Phase 64 Plan 18 (D-06, notes 4.3). The Voter copy of 64-10's self-test:
 * proves the Voter console-leak helper catches a planted join code, any 16-char slice of it, a leak
 * split across calls and binary data, and never prints code text in its own failure messages. The
 * last block is the drift guard that pins the Voter helper to the Authority helper.
 *
 * Every secret is a real-encoder fixture (random keys, fake addresses). Matchers never receive code
 * text: a failing matcher prints both operands, so comparisons here are boolean or count-based.
 */

import * as fs from 'fs';
import * as path from 'path';
import { JOIN_CODE_FIXTURES, type JoinCodeFixtureName } from '@votetorrent/vote-engine/test/fixtures/join-code-fixtures';
import { captureConsole, expectNoSecretInConsole, type ConsoleCapture } from '../__fixtures__/console-leak';

type Method = 'log' | 'info' | 'warn' | 'error' | 'debug';

const METHODS: Method[] = ['log', 'info', 'warn', 'error', 'debug'];
const NAMES = Object.keys(JOIN_CODE_FIXTURES) as JoinCodeFixtureName[];
const WINDOW = 16;

/** Number of WINDOW-char windows of `secret` that appear in `message`. Never prints either operand. */
function windowHits(message: string, secret: string, w = WINDOW): number {
	let hits = 0;
	for (let o = 0; o + w <= secret.length; o++) {
		if (message.includes(secret.slice(o, o + w))) hits++;
	}
	return hits;
}

/** Run `fn` with a live capture, always restoring. Returns what `expectNoSecretInConsole` threw, if anything. */
function leakError(
	emit: (c: ConsoleCapture) => void,
	secrets: string[],
	opts?: { windowChars?: number; allowBinary?: boolean },
): Error | undefined {
	const c = captureConsole();
	try {
		emit(c);
		try {
			expectNoSecretInConsole(c, secrets, opts);
			return undefined;
		} catch (e) {
			return e as Error;
		}
	} finally {
		c.restore();
	}
}

function expectLeak(
	emit: (c: ConsoleCapture) => void,
	secret: string,
	opts?: { windowChars?: number; allowBinary?: boolean },
): void {
	const err = leakError(emit, [secret], opts);
	expect(err instanceof Error).toBe(true);
	// the failure message carries offsets and lengths only
	expect(windowHits(String(err), secret)).toBe(0);
}

const sample = JOIN_CODE_FIXTURES['v2-1-member'];
const mid = Math.floor(sample.text.length / 2);

describe('console-leak helper', () => {
	describe('planted full code', () => {
		it.each(NAMES)('fails when the full %s text is warned', (name) => {
			const text = JOIN_CODE_FIXTURES[name].text;
			expectLeak(() => void console.warn('x', text), text);
		});
	});

	describe('planted 16-char slices', () => {
		const offsets: Array<[string, number]> = [
			['start', 0],
			['middle', mid],
			['end', sample.text.length - WINDOW],
		];
		for (const method of METHODS) {
			it.each(offsets)(`fails on a %s slice via console.${method}`, (_label, off) => {
				const slice = sample.text.slice(off, off + WINDOW);
				expectLeak(() => void console[method](slice), sample.text);
			});
		}

		it('fails on a slice embedded mid-string', () => {
			const slice = sample.text.slice(mid, mid + WINDOW);
			expectLeak(() => void console.log(`before ${slice} after`), sample.text);
		});
		it('fails on a slice in a nested object', () => {
			const slice = sample.text.slice(mid, mid + WINDOW);
			expectLeak(() => void console.info({ a: { b: [{ c: slice }] } }), sample.text);
		});
		it('fails on a slice in an array', () => {
			const slice = sample.text.slice(mid, mid + WINDOW);
			expectLeak(() => void console.info(['x', [slice]]), sample.text);
		});
		it('fails on a slice in an object key', () => {
			const slice = sample.text.slice(mid, mid + WINDOW);
			expectLeak(() => void console.info({ [slice]: 1 }), sample.text);
		});
		it('fails on a slice in a Map and a Set', () => {
			const slice = sample.text.slice(mid, mid + WINDOW);
			expectLeak(() => void console.info(new Map([[1, slice]])), sample.text);
			expectLeak(() => void console.info(new Set([slice])), sample.text);
		});
		it('fails on a slice in an Error message', () => {
			const slice = sample.text.slice(mid, mid + WINDOW);
			expectLeak(() => void console.error(new Error(`boom ${slice}`)), sample.text);
		});
		it('fails on a slice in an Error cause', () => {
			const slice = sample.text.slice(mid, mid + WINDOW);
			expectLeak(() => void console.error(Object.assign(new Error('boom'), { cause: slice })), sample.text);
		});
		it('fails on a slice in an Error own property', () => {
			const slice = sample.text.slice(mid, mid + WINDOW);
			expectLeak(() => void console.error(Object.assign(new Error('boom'), { detail: { deep: slice } })), sample.text);
		});
		it('fails on a slice returned by toJSON', () => {
			const slice = sample.text.slice(mid, mid + WINDOW);
			expectLeak(() => void console.log({ toJSON: () => slice }), sample.text);
		});
		it('fails on a code split across consecutive calls', () => {
			const a = sample.text.slice(mid, mid + 8);
			const b = sample.text.slice(mid + 8, mid + 16);
			expectLeak(
				() => {
					console.log(a);
					console.log(b);
				},
				sample.text,
			);
		});
		it('survives a circular object and still finds the slice', () => {
			const slice = sample.text.slice(mid, mid + WINDOW);
			const o: Record<string, unknown> = { slice };
			o.self = o;
			expectLeak(() => void console.log(o), sample.text);
		});
		it('does not crash on a circular object that holds no secret', () => {
			const o: Record<string, unknown> = { fine: 'ok' };
			o.self = o;
			expect(leakError(() => void console.log(o), [sample.text])).toBeUndefined();
		});
	});

	describe('window size', () => {
		it('does not trip on a 15-char slice at the default window', () => {
			const slice = sample.text.slice(mid, mid + 15);
			expect(leakError(() => void console.log(slice), [sample.text])).toBeUndefined();
		});
		it('trips on the same 15-char slice with windowChars 15', () => {
			const slice = sample.text.slice(mid, mid + 15);
			expectLeak(() => void console.log(slice), sample.text, { windowChars: 15 });
		});
	});

	describe('secret shorter than the window', () => {
		const secret = sample.name.length < WINDOW ? sample.name : sample.name.slice(0, 10);
		it('trips when it appears whole', () => {
			expectLeak(() => void console.log(`x ${secret} y`), secret);
		});
		it('does not trip on a partial', () => {
			expect(leakError(() => void console.log(secret.slice(1)), [secret])).toBeUndefined();
		});
	});

	describe('clean output', () => {
		const TOKENS = [
			'[join] scan: accepted',
			'[join] scan: rejected-not-join-code',
			'[join] scan: permission-denied',
			'[join] scan: permission-blocked',
			'[join] scan: permission-request-failed',
			'[join] scan: no-camera',
			'[join] scan: camera-failed',
			'[join] scan: scanner-failed',
			'[join] scan: open-settings-failed',
		];
		it.each(NAMES)('closed tokens and unrelated text pass for %s', (name) => {
			const f = JOIN_CODE_FIXTURES[name];
			const err = leakError(
				() => {
					for (const t of TOKENS) console.info(t);
					console.warn('JoinNetworkScreen: join refused:', 'no-peers');
					console.log('unrelated text', 42, true, { a: 1 });
				},
				[f.text, f.name, f.fingerprint],
			);
			expect(err).toBeUndefined();
		});
	});

	describe('binary arguments', () => {
		it('fails on a Uint8Array', () => {
			expect(leakError(() => void console.log(new Uint8Array(3)), [sample.text]) instanceof Error).toBe(true);
		});
		it('fails on an ArrayBuffer nested deep', () => {
			expect(leakError(() => void console.log({ a: [{ b: new ArrayBuffer(4) }] }), [sample.text]) instanceof Error).toBe(true);
		});
		it('passes with allowBinary', () => {
			expect(leakError(() => void console.log(new Uint8Array(3)), [sample.text], { allowBinary: true })).toBeUndefined();
		});
		it('names the constructor and byte length', () => {
			const err = leakError(() => void console.log(new Uint8Array(3)), [sample.text]);
			expect(/binary argument \(Uint8Array, 3 bytes\)/.test(String(err))).toBe(true);
		});
	});

	describe('failure messages', () => {
		it('carry the secret index, length, window offset and method and call number', () => {
			const slice = sample.text.slice(mid, mid + WINDOW);
			const err = leakError(
				() => {
					console.log('first');
					console.warn(slice);
				},
				['unrelated-secret-value', sample.text],
			);
			const msg = String(err);
			expect(msg.includes('secret #1')).toBe(true);
			expect(msg.includes(`(${sample.text.length} chars)`)).toBe(true);
			expect(msg.includes('16-char window at offset')).toBe(true);
			expect(msg.includes('console.warn call #2')).toBe(true);
			expect(windowHits(msg, sample.text)).toBe(0);
		});
		it('says the full secret when the whole secret matched', () => {
			const err = leakError(() => void console.log(sample.text), [sample.text]);
			expect(String(err).includes('the full secret')).toBe(true);
		});
		it('says across calls for a split leak', () => {
			const err = leakError(
				() => {
					console.log(sample.text.slice(mid, mid + 8));
					console.log(sample.text.slice(mid + 8, mid + 16));
				},
				[sample.text],
			);
			expect(String(err).includes('appears across console calls')).toBe(true);
		});
	});

	describe('usage errors', () => {
		it('throws on an empty secrets array', () => {
			const c = captureConsole();
			try {
				expect(() => expectNoSecretInConsole(c, [])).toThrow();
			} finally {
				c.restore();
			}
		});
		it('throws on an empty or non-string secret', () => {
			const c = captureConsole();
			try {
				expect(() => expectNoSecretInConsole(c, [''])).toThrow();
				expect(() => expectNoSecretInConsole(c, [5 as unknown as string])).toThrow();
			} finally {
				c.restore();
			}
		});
		it('throws on a bad windowChars', () => {
			const c = captureConsole();
			try {
				expect(() => expectNoSecretInConsole(c, ['abc'], { windowChars: 0 })).toThrow();
				expect(() => expectNoSecretInConsole(c, ['abc'], { windowChars: 1.5 })).toThrow();
			} finally {
				c.restore();
			}
		});
		it('throws on a second capture while one is active', () => {
			const c = captureConsole();
			try {
				expect(() => captureConsole()).toThrow();
			} finally {
				c.restore();
			}
		});
	});

	describe('capture mechanics', () => {
		it('swallows output: the original function is never invoked', () => {
			const sink = jest.fn();
			const original = console.warn;
			console.warn = sink as unknown as typeof console.warn;
			try {
				const c = captureConsole();
				try {
					console.warn('hello');
					expect(c.calls().length).toBe(1);
				} finally {
					c.restore();
				}
				expect(sink).not.toHaveBeenCalled();
				expect(console.warn === (sink as unknown as typeof console.warn)).toBe(true);
			} finally {
				console.warn = original;
			}
		});
		it('returns calls in chronological order across the five methods', () => {
			const c = captureConsole();
			try {
				console.debug('1');
				console.error('2');
				console.log('3');
				console.warn('4');
				console.info('5');
				expect(c.calls().map((a) => String(a[0])).join(',')).toBe('1,2,3,4,5');
			} finally {
				c.restore();
			}
		});
		it('restores the originals and is idempotent', () => {
			const before = METHODS.map((m) => console[m]);
			const c = captureConsole();
			expect(console.log === before[0]).toBe(false);
			c.restore();
			c.restore();
			METHODS.forEach((m, i) => expect(console[m] === before[i]).toBe(true));
			// a fresh capture is possible again
			const c2 = captureConsole();
			c2.restore();
		});
	});

	describe('drift guard', () => {
		const strip = (text: string): string =>
			text
				.replace(/\/\*[\s\S]*?\*\//g, '')
				.replace(/\/\/.*$/gm, '')
				.split('\n')
				.map((l) => l.trimEnd())
				.filter((l) => l.trim().length > 0)
				.join('\n');
		it('keeps the Voter helper code-identical to the Authority helper', () => {
			const voter = fs.readFileSync(path.resolve(__dirname, '../__fixtures__/console-leak.ts'), 'utf8');
			const authority = fs.readFileSync(
				path.resolve(__dirname, '../../../../VoteTorrentAuthority/src/engines/__fixtures__/console-leak.ts'),
				'utf8',
			);
			expect(strip(voter).length).toBeGreaterThan(1000);
			expect(strip(voter) === strip(authority)).toBe(true);
		});
	});
});
