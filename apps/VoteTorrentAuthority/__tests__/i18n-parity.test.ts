/**
 * @format
 *
 * Phase 11 plan 11-01 (D-12) — COMUI-02 i18n parity gate.
 * Asserts that es.translation contains every en.translation key,
 * that there are no orphan es-only keys, and that no English-leftover
 * values remain in the es block (outside the D-08 tech-term allowlist).
 */

import { resources } from '../src/i18n/index';

const enTranslation = resources.en.translation as Record<string, string>;
const esTranslation = resources.es.translation as Record<string, string>;

const enKeys = Object.keys(enTranslation);
const esKeys = Object.keys(esTranslation);

// D-08 tech-term allowlist: these keys may have identical en/es values
const KNOWN_ENGLISH_OK = new Set([
	'sid',
	'cid',
	'id',
	'relays',
	'multiaddress',
	'yubico',
	'hosting',
	'token',
	'hash',
	'adhoc',
]);

describe('i18n parity (D-12)', () => {
	test('es contains every en key', () => {
		const missingInEs = enKeys.filter(k => !esKeys.includes(k));
		expect(missingInEs).toEqual([]);
	});

	test('en contains every es key (no orphans)', () => {
		const missingInEn = esKeys.filter(k => !enKeys.includes(k));
		expect(missingInEn).toEqual([]);
	});

	test('no English-leftover values in es block', () => {
		const leftoverEnglish = enKeys.filter(k => {
			if (KNOWN_ENGLISH_OK.has(k)) return false;
			const enVal = enTranslation[k];
			const esVal = esTranslation[k];
			return typeof enVal === 'string' && typeof esVal === 'string' && enVal === esVal;
		});
		expect(leftoverEnglish).toEqual([]);
	});
});
