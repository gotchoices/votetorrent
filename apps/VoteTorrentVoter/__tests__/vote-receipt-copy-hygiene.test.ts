/**
 * vote-receipt-copy-hygiene.test.ts - Phase 63 plan 12 (D-11, D-17, D-21, D-22).
 *
 * Gates the receipt keys of the `ballot` i18n namespace: presence, real translation, the exact
 * required lines, and copy discipline (no digits, no GSD identifiers, no send promise, no false
 * "sent" claim). Asserts ONLY against the imported `resources`, never a source file, so it cannot
 * trip over its own comments.
 */
import {resources} from '../src/i18n/index';

const en = resources.en.ballot as unknown as Record<string, string>;
const es = resources.es.ballot as unknown as Record<string, string>;

const REQUIRED_RECEIPT_KEYS = [
	'receipt.title',
	'receipt.loading',
	'receipt.status',
	'receipt.loss',
	'receipt.stale',
	'receipt.revisionUnknown',
	'receipt.none',
	'receipt.unreadable',
	'receipt.revealCta',
	'receipt.revealHint',
	'receipt.revealCanceled',
	'receipt.revealBiometricUnavailable',
	'receipt.revealFailed',
	'receipt.choicesHeading',
	'receipt.leftBlank',
	'receipt.nonceLabel',
	'receipt.copyCta',
	'receipt.copyWarning',
	'receipt.copied',
	'receipt.copyFailed',
	'receipt.doneCta',
	'receipt.prompt.title',
	'receipt.prompt.subtitle',
	'receipt.prompt.negativeButton',
];

describe('receipt copy', () => {
	it('lists the 24 required keys', () => {
		expect(REQUIRED_RECEIPT_KEYS).toHaveLength(24);
	});

	it.each(REQUIRED_RECEIPT_KEYS)('%s exists, is non-empty and is translated', key => {
		expect(typeof en[key]).toBe('string');
		expect(en[key].trim().length).toBeGreaterThan(0);
		expect(typeof es[key]).toBe('string');
		expect(es[key].trim().length).toBeGreaterThan(0);
		expect(es[key]).not.toBe(en[key]);
	});

	it('uses the exact required English lines', () => {
		expect(en['receipt.status']).toBe(
			'Your vote is saved on this phone. It has not been sent to the election yet.',
		);
		expect(en['receipt.copyWarning']).toBe('Anyone with this code can find how you voted.');
		expect(en['receipt.stale']).toBe('The election changed after you voted. Please vote again.');
		expect(en['receipt.loss']).toBe(
			"Your vote exists only on this phone. Clearing this app's data or reinstalling the app deletes it.",
		);
	});

	const all = REQUIRED_RECEIPT_KEYS.flatMap(k => [
		[`en ${k}`, en[k]],
		[`es ${k}`, es[k]],
	]);

	it.each(all)('%s carries no digit, phase word or decision id', (_n, value) => {
		expect(value).not.toMatch(/\d/);
		expect(value).not.toMatch(/\b(phase|fase|plan)\b/i);
		expect(value).not.toMatch(/\bD-\d/);
	});

	it.each(all)('%s makes no false sent claim', (_n, value) => {
		expect(value).not.toMatch(/\b(was|has been|have been) (sent|submitted)\b/i);
		expect(value).not.toMatch(/(fue enviad|ha sido enviad)/i);
	});

	it('makes no send promise in the status line (D-11)', () => {
		expect(en['receipt.status']).not.toMatch(/\b(will|soon|automatically|later|when)\b/i);
		expect(es['receipt.status']).not.toMatch(/(se enviará|pronto|automáticamente|más tarde|cuando)/i);
	});
});
