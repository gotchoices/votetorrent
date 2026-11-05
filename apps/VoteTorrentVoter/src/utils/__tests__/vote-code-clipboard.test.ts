/**
 * @format
 *
 * copyVoteCode: the single lazy clipboard seam (D-17).
 */
import {copyVoteCode} from '../vote-code-clipboard';

const NONCE = 'a0b1c2d3'.repeat(8);

function mockedClipboard(): {setString: (s: string) => void} {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return require('@react-native-clipboard/clipboard').default;
}

describe('copyVoteCode', () => {
	let spies: jest.SpyInstance[] = [];
	beforeEach(() => {
		spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m =>
			jest.spyOn(console, m).mockImplementation(() => {}),
		);
	});
	afterEach(() => {
		spies.forEach(s => expect(s).not.toHaveBeenCalled());
		jest.restoreAllMocks();
		jest.resetModules();
		jest.dontMock('@react-native-clipboard/clipboard');
	});

	it('copies the ungrouped 64-hex string exactly once', () => {
		const set = jest.spyOn(mockedClipboard(), 'setString');
		expect(copyVoteCode(NONCE)).toBe('copied');
		expect(set).toHaveBeenCalledTimes(1);
		expect(set).toHaveBeenCalledWith(NONCE);
		expect(set.mock.calls[0][0]).toHaveLength(64);
	});

	const grouped = NONCE.match(/.{4}/g)!.join(' ');
	it.each([
		['grouped', grouped],
		['uppercase', NONCE.toUpperCase()],
		['63 chars', NONCE.slice(1)],
		['65 chars', NONCE + 'a'],
		['empty', ''],
		['non-hex', 'g' + NONCE.slice(1)],
	])('rejects %s and never copies', (_n, value) => {
		const set = jest.spyOn(mockedClipboard(), 'setString');
		expect(() => copyVoteCode(value)).toThrow(
			new TypeError('vote code must be 64 lowercase hex characters'),
		);
		expect(set).not.toHaveBeenCalled();
	});

	it('returns unavailable when setString throws', () => {
		jest.spyOn(mockedClipboard(), 'setString').mockImplementationOnce(() => {
			throw new Error('boom');
		});
		expect(copyVoteCode(NONCE)).toBe('unavailable');
	});

	it('returns unavailable when the module cannot load (stale binary)', () => {
		jest.isolateModules(() => {
			jest.doMock('@react-native-clipboard/clipboard', () => {
				throw new Error('RNCClipboard not found');
			});
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const isolated = require('../vote-code-clipboard');
			expect(isolated.copyVoteCode(NONCE)).toBe('unavailable');
		});
	});

	describe('WR-03: the sensitive native copy comes first', () => {
		function withNative(result: 'copied' | 'failed' | 'unsupported'): {
			copy: (n: string) => string;
			sensitive: jest.Mock;
			plain: jest.Mock;
		} {
			let out: {copy: (n: string) => string; sensitive: jest.Mock; plain: jest.Mock} | undefined;
			jest.isolateModules(() => {
				const sensitive = jest.fn(() => result);
				const plain = jest.fn();
				jest.doMock('@votetorrent/attestation-native', () => ({copySensitiveText: sensitive}));
				jest.doMock('@react-native-clipboard/clipboard', () => ({default: {setString: plain}}));
				// eslint-disable-next-line @typescript-eslint/no-require-imports
				const isolated = require('../vote-code-clipboard');
				out = {copy: isolated.copyVoteCode, sensitive, plain};
			});
			return out!;
		}
		afterEach(() => {
			jest.dontMock('@votetorrent/attestation-native');
		});

		it('copied by the native sensitive path: the plain clipboard is never touched', () => {
			const {copy, sensitive, plain} = withNative('copied');
			expect(copy(NONCE)).toBe('copied');
			expect(sensitive).toHaveBeenCalledTimes(1);
			expect(sensitive).toHaveBeenCalledWith(NONCE);
			expect(plain).not.toHaveBeenCalled();
		});

		it('a native failure reports unavailable and never falls back to the unmarked copy', () => {
			const {copy, plain} = withNative('failed');
			expect(copy(NONCE)).toBe('unavailable');
			expect(plain).not.toHaveBeenCalled();
		});

		it('a binary without the native method falls back to the plain copy', () => {
			const {copy, sensitive, plain} = withNative('unsupported');
			expect(copy(NONCE)).toBe('copied');
			expect(sensitive).toHaveBeenCalledTimes(1);
			expect(plain).toHaveBeenCalledWith(NONCE);
		});

		it('an invalid code reaches neither path', () => {
			const {copy, sensitive, plain} = withNative('copied');
			expect(() => copy('nope')).toThrow(TypeError);
			expect(sensitive).not.toHaveBeenCalled();
			expect(plain).not.toHaveBeenCalled();
		});
	});

	it('source: lazy require only, no console, no Share', () => {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const fs = require('fs') as {readFileSync(p: string, e: string): string};
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const path = require('path') as {join(...p: string[]): string};
		const src = fs
			.readFileSync(path.join(__dirname, '..', 'vote-code-clipboard.ts'), 'utf8')
			.split('\n')
			.filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
			.join('\n');
		expect(src).not.toMatch(/^\s*import[^;]*@react-native-clipboard\/clipboard/m);
		expect(src).toMatch(/require\('@react-native-clipboard\/clipboard'\)/);
		expect(src).not.toMatch(/console\./);
		expect(src).not.toMatch(/Share/);
	});
});
