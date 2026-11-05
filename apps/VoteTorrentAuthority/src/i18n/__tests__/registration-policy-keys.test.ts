/**
 * Phase 46 plan 46-03 (D-11) — registrationPolicy* i18n key-group proof.
 *
 * Renderer-free: imports only the exported `resources` object, no
 * react-test-renderer / @testing-library needed (neither is a dependency of
 * this app — see 46-03-PLAN.md's `read_first` note).
 *
 * A duplicate key inside a single object literal is silently collapsed by the
 * JS parser (the later entry wins, with no runtime trace) — this test alone
 * CANNOT detect that failure mode. The companion source-level `sort | uniq -d`
 * grep gate (see 46-03-PLAN.md's `<verify>`/acceptance criteria) is required
 * in addition to this test, not instead of it.
 */

import { resources } from '../index';

const enTranslation = resources.en.translation as Record<string, string>;
const esTranslation = resources.es.translation as Record<string, string>;

const REGISTRATION_POLICY_RE = /^registrationPolicy[A-Z]/;
const REGISTRATION_REQUEST_RE = /^registrationRequest[A-Z]/;
// Phase 48 widened this to also carve out the `registrationRequest*` group. 62-10 widened it
// again to carve out `registrationBridgeConfig*` (Group B) and `registrationContent*` (Group K) —
// both would otherwise fall through to this bare-registration catch-all. The guard's purpose is
// unchanged — catch a key that lands in no declared namespace — and each carve-out is paid for by
// its own key-group test (`multipeer-continuity-keys.test.ts` Groups B and K).
const BARE_REGISTRATION_RE = /^registration(?!Policy)(?!Request)(?!BridgeConfig)(?!Content)/;

describe('registrationPolicy* i18n key group (D-11)', () => {
	// 62-10 added 7 registrationPolicyReassociation* keys (5 SPEC + 2 amendment), moving the pin
	// from 55 to 62.
	test('EN has exactly 62 registrationPolicy* keys, ES key set is deeply equal', () => {
		const enKeys = Object.keys(enTranslation).filter(k => REGISTRATION_POLICY_RE.test(k));
		const esKeys = Object.keys(esTranslation).filter(k => REGISTRATION_POLICY_RE.test(k));

		expect(enKeys).toHaveLength(62);
		expect(new Set(esKeys)).toEqual(new Set(enKeys));
		expect(esKeys).toHaveLength(62);
	});

	test('no registrationPolicy* value is empty or whitespace-only, in either locale', () => {
		const enKeys = Object.keys(enTranslation).filter(k => REGISTRATION_POLICY_RE.test(k));
		for (const key of enKeys) {
			expect(enTranslation[key]?.trim().length).toBeGreaterThan(0);
			expect(esTranslation[key]?.trim().length).toBeGreaterThan(0);
		}
	});

	test('the four pre-existing election-timeline keys survive byte-identical', () => {
		expect(enTranslation.registrationEnds).toBe('Registration Ends');
		expect(enTranslation.registrationOpens).toBe('Registration Opens');
		expect(enTranslation.registrationCloses).toBe('Registration Closes');
		expect(enTranslation.registrationDeadline).toBe('Registration Deadline');

		expect(esTranslation.registrationEnds).toBe('Finaliza Registro');
		expect(esTranslation.registrationOpens).toBe('Abre el Registro');
		expect(esTranslation.registrationCloses).toBe('Cierra el Registro');
		expect(esTranslation.registrationDeadline).toBe('Fecha Límite de Registro');
	});

	test('EN has exactly 61 registrationRequest* keys, ES key set is deeply equal', () => {
		const enKeys = Object.keys(enTranslation).filter(k => REGISTRATION_REQUEST_RE.test(k));
		const esKeys = Object.keys(esTranslation).filter(k => REGISTRATION_REQUEST_RE.test(k));

		// 46 = 45 + registrationRequestUnverifiable (the requester-signature-unverifiable refusal copy).
		// 55 = 46 + the nine registrationRequestField* payload labels (request detail shows labels, never raw keys).
		// 61 = 55 + six chunk-B copy keys (NotFound, LoadFailed, ChecklistIncomplete, NoTask, ApproveFailed, VoteFailed).
		expect(enKeys).toHaveLength(61);
		expect(new Set(esKeys)).toEqual(new Set(enKeys));
		expect(esKeys).toHaveLength(61);
	});

	test('no registrationRequest* value is empty or whitespace-only, in either locale', () => {
		const enKeys = Object.keys(enTranslation).filter(k => REGISTRATION_REQUEST_RE.test(k));
		for (const key of enKeys) {
			expect(enTranslation[key]?.trim().length).toBeGreaterThan(0);
			expect(esTranslation[key]?.trim().length).toBeGreaterThan(0);
		}
	});

	test('no bare-registration* key exists outside the Policy and Request groups', () => {
		const allowed = new Set([
			'registrationEnds',
			'registrationOpens',
			'registrationCloses',
			'registrationDeadline',
		]);

		const enBareKeys = Object.keys(enTranslation).filter(k => BARE_REGISTRATION_RE.test(k));
		const esBareKeys = Object.keys(esTranslation).filter(k => BARE_REGISTRATION_RE.test(k));

		expect(new Set(enBareKeys)).toEqual(allowed);
		expect(new Set(esBareKeys)).toEqual(allowed);
	});

	test('registrationPolicyReadOnlyBanner carries the {{scope}} interpolation contract in both locales', () => {
		expect(enTranslation.registrationPolicyReadOnlyBanner).toContain('{{scope}}');
		expect(esTranslation.registrationPolicyReadOnlyBanner).toContain('{{scope}}');
	});
});
