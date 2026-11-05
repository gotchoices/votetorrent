import fs from 'fs';
import path from 'path';
import i18n from '../index';

const KEYS = ['code.retryButton', 'newDevice.checkBackLaterButton', 'newDevice.checkBackLaterBody', 'newDevice.backToRegistrationButton'];
const source = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');

describe('continuity round-2 keys (K-1)', () => {
	for (const key of KEYS) {
		test(`${key} exists in en and es, differs, appears once per locale, has no phase number`, () => {
			const en = i18n.getFixedT('en', 'continuity')(key);
			const es = i18n.getFixedT('es', 'continuity')(key);
			expect(en).not.toBe(key);
			expect(es).not.toBe(key);
			expect(en.length).toBeGreaterThan(0);
			expect(es).not.toBe(en);
			expect(source.split(`'${key}'`).length - 1).toBe(2);
			expect(en + es).not.toMatch(/phase\s*\d|\b\d{2}-\d{2}\b/i);
		});
	}
});
