/**
 * vt-debug.test.ts - the privacy-safe debug logger is silent by default, switches on at runtime
 * through `globalThis.__VT_DEBUG__`, and sanitises what it logs.
 */
import {idPrefix, sanitiseDetail, vtDebug, vtDebugEnabled} from '../vt-debug';
import {VT_DEBUG_LOGS} from '../proof-flags.generated';

const g = globalThis as {__VT_DEBUG__?: unknown};

describe('vtDebug', () => {
	let spies: jest.SpyInstance[];
	beforeEach(() => {
		spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m => jest.spyOn(console, m).mockImplementation(() => undefined));
	});
	afterEach(() => {
		delete g.__VT_DEBUG__;
		for (const s of spies) s.mockRestore();
	});

	it('the committed flag is off', () => {
		expect(VT_DEBUG_LOGS).toBe(false);
	});

	it('is silent by default: no console call of any kind', () => {
		expect(vtDebugEnabled()).toBe(false);
		vtDebug('send', 'status', {phase: 'sent'});
		vtDebug('send', 'no-detail');
		for (const s of spies) expect(s).not.toHaveBeenCalled();
	});

	it('only an exact true switches it on', () => {
		g.__VT_DEBUG__ = 'true';
		vtDebug('send', 'status', {phase: 'sent'});
		g.__VT_DEBUG__ = 1;
		vtDebug('send', 'status', {phase: 'sent'});
		for (const s of spies) expect(s).not.toHaveBeenCalled();
	});

	it('writes one console.log line with the tag prefix when the global is on', () => {
		g.__VT_DEBUG__ = true;
		expect(vtDebugEnabled()).toBe(true);
		vtDebug('send', 'status', {phase: 'not-sent', reason: 'stopped', ms: 1234, ok: false, none: null});
		const log = spies[0]!;
		expect(log).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith('[vt-send] status', {phase: 'not-sent', reason: 'stopped', ms: 1234, ok: false, none: null});
		vtDebug('home', 'focus-start');
		expect(log).toHaveBeenLastCalledWith('[vt-home] focus-start');
		for (const s of spies.slice(1)) expect(s).not.toHaveBeenCalled();
	});

	it('never throws, even when the detail throws on read', () => {
		g.__VT_DEBUG__ = true;
		const hostile = Object.defineProperty({}, 'boom', {enumerable: true, get: () => { throw new Error('read'); }});
		expect(() => vtDebug('send', 'x', hostile as Record<string, unknown>)).not.toThrow();
		spies[0]!.mockImplementation(() => { throw new Error('console'); });
		expect(() => vtDebug('send', 'x', {a: 1})).not.toThrow();
	});
});

describe('sanitiseDetail', () => {
	it('cuts a 64-char hex digest to its first 8 chars', () => {
		const digest = 'ab12'.repeat(16);
		expect(sanitiseDetail({digest})).toEqual({digest: 'ab12ab12…'});
	});

	it('cuts a base64url digest and a cid inside a sentence, keeps the words', () => {
		const out = sanitiseDetail({d: 'sig Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5 end', cid: 'bafyreigdmqpykrgxyaxtlafqpqhzrb7qy2rh75nldvfd4tucqyx'});
		expect(out).toEqual({d: 'sig Zm9vYmFy… end', cid: 'bafyreig…'});
	});

	it('keeps state names, codes and class names whole', () => {
		expect(sanitiseDetail({a: 'voting-closed', b: 'own-consent-timeout', c: 'BIOMETRIC_ERROR', d: 'ConsentAbandonedError'}))
			.toEqual({a: 'voting-closed', b: 'own-consent-timeout', c: 'BIOMETRIC_ERROR', d: 'ConsentAbandonedError'});
	});

	it('drops nested objects, arrays and functions', () => {
		expect(sanitiseDetail({o: {secret: 'x'}, a: [1, 2], f: () => 1, n: BigInt(1) as unknown, keep: 7}))
			.toEqual({o: '<dropped>', a: '<dropped>', f: '<dropped>', n: '<dropped>', keep: 7});
	});

	it('cuts a long sentence to 48 chars', () => {
		const s = 'the quick brown fox jumps over the lazy dog and keeps on running far away';
		const out = sanitiseDetail({s}).s as string;
		expect(out).toBe(s.slice(0, 48) + '…');
	});

	it('redacts message and stack, leaves undefined out', () => {
		expect(sanitiseDetail({message: 'P2pStagingError: the strand refused', stack: 'at x', u: undefined, code: 'PROMPT_BUSY'}))
			.toEqual({message: '<redacted>', stack: '<redacted>', code: 'PROMPT_BUSY'});
	});

	it('idPrefix gives 8 chars of an id and only the type of anything else', () => {
		expect(idPrefix('ballot-0123456789')).toBe('ballot-0');
		expect(idPrefix(undefined)).toBe('undefined');
		expect(idPrefix({id: 'x'})).toBe('object');
	});
});
