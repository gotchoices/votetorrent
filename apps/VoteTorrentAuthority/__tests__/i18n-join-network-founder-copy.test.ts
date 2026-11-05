/**
 * @format
 *
 * D-26 / OQ1: the `joinNetwork` copy for the founder decision.
 *
 * Branch B. The decision was read from `64-GATE-REVIEW.md` (`COPY-DECISION: NEW-KEY`), so the
 * Authority catalogue holds the 26 `joinNetwork*` keys of the A4 copy table plus exactly one more,
 * the founder-refusal sentence the user approved. The set is pinned here and not in 64-03's
 * `i18n-join-qr-owner-trust-copy.test.ts` because the new key is added by the screen plan, after
 * 64-03's pins were written (notes 12 "From 64-03").
 */

import * as fs from 'fs';
import * as path from 'path';
import { resources } from '../src/i18n/index';

const en = resources.en.translation as Record<string, string>;
const es = resources.es.translation as Record<string, string>;

const COPY_KEY = 'joinNetworkErrorFounderCannotJoin';
const SENTENCE_EN = "This phone founded its own network, so it can't join a different network with a code.";
const SENTENCE_ES = 'Este teléfono creó su propia red, así que no puede unirse a otra red con un código.';

const BASE_KEYS = [
	'joinNetworkButton',
	'joinNetworkTitle',
	'joinNetworkIntro',
	'joinNetworkCodeLabel',
	'joinNetworkCodePlaceholder',
	'joinNetworkPaste',
	'joinNetworkPreviewCheck',
	'joinNetworkSubmit',
	'joinNetworkStepAdmitting',
	'joinNetworkStepSyncing',
	'joinNetworkStepVerifying',
	'joinNetworkJoinedTitle',
	'joinNetworkTrustNotSaved',
	'joinNetworkDone',
	'joinNetworkErrorInvalidCode',
	'joinNetworkErrorNewerCode',
	'joinNetworkErrorOlderCode',
	'joinNetworkErrorNotJoinCode',
	'joinNetworkErrorExpired',
	'joinNetworkErrorUsedUp',
	'joinNetworkErrorNotAdmitted',
	'joinNetworkErrorNoPeers',
	'joinNetworkErrorNotSynced',
	'joinNetworkErrorDigestMismatch',
	'joinNetworkErrorOpenFailed',
	'joinNetworkErrorGeneric',
];
const EXPECTED = [...BASE_KEYS, COPY_KEY].sort();

const joinKeys = (r: Record<string, string>) => Object.keys(r).filter((k) => /^joinNetwork/.test(k)).sort();

describe('joinNetwork copy for the OQ1 founder decision (D-26)', () => {
	it('FC-1: en and es hold exactly the 26 A4 keys plus the founder key', () => {
		expect(BASE_KEYS).toHaveLength(26);
		expect(joinKeys(en)).toEqual(EXPECTED);
		expect(joinKeys(es)).toEqual(EXPECTED);
	});

	it('FC-2: every joinNetwork key is a non-empty string in both locales', () => {
		for (const k of EXPECTED) {
			expect(typeof en[k]).toBe('string');
			expect(en[k].length).toBeGreaterThan(0);
			expect(typeof es[k]).toBe('string');
			expect(es[k].length).toBeGreaterThan(0);
		}
	});

	it('FC-3: the founder key carries the approved sentences verbatim', () => {
		expect(en[COPY_KEY]).toBe(SENTENCE_EN);
		expect(es[COPY_KEY]).toBe(SENTENCE_ES);
		expect(en[COPY_KEY]).not.toBe(es[COPY_KEY]);
		for (const s of [en[COPY_KEY], es[COPY_KEY]]) {
			expect(s).not.toMatch(/phase\s*\d+|fase\s*\d+|64-\d/i);
			expect(s).not.toContain('{{');
			expect(s).not.toContain('vtjoin');
			expect(s).not.toContain('sereus-invite');
		}
		expect(COPY_KEY).toMatch(/^joinNetwork[A-Z][A-Za-z0-9]*$/);
		expect(COPY_KEY).not.toMatch(/^(voterInviteQr|ownerTrust|settingsRequireOwnerTrust)/);
		const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'index.ts'), 'utf8');
		const lines = source.split('\n').filter((l) => new RegExp('^\\s+' + COPY_KEY + ':').test(l));
		expect(lines).toHaveLength(2);
	});
});
