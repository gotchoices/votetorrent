import {JOIN_CODE_FIXTURES} from '@votetorrent/vote-engine/test/fixtures/join-code-fixtures';
import {errorClassName} from '../errorClassName';

describe('errorClassName (D-06, D-26)', () => {
	test('returns the class name of an Error and never its message', () => {
		const secret = 'ABCD-EFGH-1234';
		expect(errorClassName(new Error(`code ${secret} rejected`))).toBe('Error');
		expect(errorClassName(new TypeError(secret))).toBe('TypeError');
	});

	test('returns the subclass name of a custom Error', () => {
		class AttestationRejected extends Error {
			constructor(message: string) {
				super(message);
				this.name = 'AttestationRejected';
			}
		}
		expect(errorClassName(new AttestationRejected('evidence: 1990-01-01'))).toBe('AttestationRejected');
	});

	test('returns only the typeof of a non-Error throw, never its value', () => {
		expect(errorClassName('ABCD-EFGH-1234')).toBe('string');
		expect(errorClassName({code: 'ABCD-EFGH-1234'})).toBe('object');
		expect(errorClassName(42)).toBe('number');
		expect(errorClassName(undefined)).toBe('undefined');
		expect(errorClassName(null)).toBe('object');
	});

	test('an Error carrying a real join code text gives exactly Error, with no 16-char window of the text', () => {
		const text: string = JOIN_CODE_FIXTURES['v2-1-member'].text;
		const out = errorClassName(new Error(text));
		expect(out).toBe('Error');
		let leaked = false;
		for (let i = 0; i + 16 <= text.length; i++) {
			if (out.includes(text.slice(i, i + 16))) leaked = true;
		}
		expect(leaked).toBe(false);
	});
});
