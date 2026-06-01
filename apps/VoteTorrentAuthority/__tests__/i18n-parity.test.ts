/**
 * @format
 *
 * Phase 11 plan 11-01 (D-12) — COMUI-02 i18n parity gate.
 * Asserts that es.translation contains every en.translation key,
 * that there are no orphan es-only keys, and that no English-leftover
 * values remain in the es block (outside the D-08 tech-term allowlist).
 *
 * v1.1 milestone-audit follow-up (2026-06-01) — adds source-key coverage:
 * EN<->ES symmetry alone let `enterName`, `enterImageUrl`, `connect`, and
 * `unknownUser` ship missing from BOTH locales (rendered the raw key at
 * runtime). The third test below scans the source tree for literal t("key")
 * calls and fails if any key is absent from the bundle.
 */

import * as fs from 'fs';
import * as path from 'path';
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

	test('every literal t("key") used in source exists in the bundle', () => {
		const srcDir = path.resolve(__dirname, '../src');

		// Match t('key') / t("key") where the `t` is NOT part of a longer
		// identifier or a member call (e.g. excludes `.split('T')`,
		// `formatDate('x')`). Only single string-literal arguments are checked;
		// dynamic keys like t(route.name) or t(getKeyTypeDisplayName(x)) are
		// intentionally skipped — they can't be statically resolved.
		const callRe = /(?<![\w.])t\(\s*['"]([A-Za-z][\w]*)['"]\s*\)/g;

		const walk = (dir: string): string[] =>
			fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (entry.name === 'node_modules' || entry.name === '__tests__') return [];
					return walk(full);
				}
				return /\.(ts|tsx)$/.test(entry.name) && full !== path.join(srcDir, 'i18n', 'index.ts')
					? [full]
					: [];
			});

		const missing = new Map<string, string>(); // key -> first file it appears in
		for (const file of walk(srcDir)) {
			const text = fs.readFileSync(file, 'utf8');
			let m: RegExpExecArray | null;
			while ((m = callRe.exec(text)) !== null) {
				const key = m[1];
				if (!enKeys.includes(key) && !missing.has(key)) {
					missing.set(key, path.relative(srcDir, file));
				}
			}
		}

		const report = Array.from(missing, ([key, file]) => `${key} (${file})`);
		expect(report).toEqual([]);
	});
});
