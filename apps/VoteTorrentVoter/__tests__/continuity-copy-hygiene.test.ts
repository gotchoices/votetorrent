/**
 * continuity-copy-hygiene.test.ts — Phase 62 plan 62-10.
 *
 * Gates the new `continuity` i18n namespace for exact key-set presence (this namespace is NEW and
 * fully owned by this plan — no later plan may add a key here), non-emptiness, actual translation
 * (EN != ES, no identical-by-design exceptions in this namespace), and copy discipline (no GSD
 * phase numbers, no decision IDs, no QR/camera/scan wording per D-36, no interpolation tokens).
 * Modeled on `timeline-copy-hygiene.test.ts`. Asserts ONLY against the imported `resources` object
 * — never reads a source file — so it can never trip over its own comments (a known project trap:
 * a checker whose own text quotes the pattern it greps for is permanently green).
 */
import {resources} from '../src/i18n/index';

type ContinuityNamespace = Record<string, string>;

const enContinuity = resources.en.continuity as unknown as ContinuityNamespace;
const esContinuity = resources.es.continuity as unknown as ContinuityNamespace;

// The 36 catalog keys from 62-10-PLAN.md's copy_catalog (code.* 7, plus code.checking from 62-51, newDevice.* 19,
// plus code.retryButton and newDevice.checkBackLater{Button,Body} / backToRegistrationButton from 62-118,
// deviceRetired.* 2, restart.* 3), in catalog order. This namespace is new and fully owned by this
// plan, so the key set is checked EXACTLY (not presence-only like timeline-copy-hygiene.test.ts).
const REQUIRED_CONTINUITY_KEYS = [
	'code.heading',
	'code.body',
	'code.copyButton',
	'code.copiedConfirm',
	'code.showAgainLink',
	'code.unavailable',
	'code.notAvailableOnDevice',
	'code.checking',
	'newDevice.screenTitle',
	'newDevice.codeFieldLabel',
	'newDevice.codeFieldPlaceholder',
	'newDevice.submitButton',
	'newDevice.lostCodeLink',
	'newDevice.identityFallbackHeading',
	'newDevice.identityFallbackBody',
	'newDevice.identityFallbackSubmitButton',
	'newDevice.pendingHeading',
	'newDevice.pendingBody',
	'newDevice.approvedHeading',
	'newDevice.rejectedHeading',
	'newDevice.rejectedBody',
	'newDevice.entryLink',
	'newDevice.codeRequired',
	'newDevice.submitError',
	'newDevice.backToCodeLink',
	'newDevice.restartLink',
	'newDevice.retryButton',
	'code.retryButton',
	'newDevice.checkBackLaterButton',
	'newDevice.checkBackLaterBody',
	'newDevice.backToRegistrationButton',
	'deviceRetired.heading',
	'deviceRetired.body',
	'restart.heading',
	'restart.body',
	'restart.confirmButton',
];

// Case-insensitive "phase" + digits, or "D-" + two digits (a GSD decision id) — the standing
// project rule: never a GSD phase number or decision ID in user-facing copy.
const PHASE_OR_DECISION_ID_PATTERN = /phase\s*\d+|D-\d{2}/i;

// D-36: no value in this catalog may mention QR, a camera, or scanning.
const QR_SCAN_PATTERN = /\bQR\b|camera|c[aá]mara|\bscan|escane/i;

describe('continuity i18n copy hygiene (62-10)', () => {
	test('the namespace exists with exactly the 36 required keys, in both locales', () => {
		expect(new Set(Object.keys(enContinuity))).toEqual(new Set(REQUIRED_CONTINUITY_KEYS));
		expect(Object.keys(enContinuity)).toHaveLength(36);
		expect(new Set(Object.keys(esContinuity))).toEqual(new Set(REQUIRED_CONTINUITY_KEYS));
		expect(Object.keys(esContinuity)).toHaveLength(36);
	});

	test.each(REQUIRED_CONTINUITY_KEYS)('en.continuity[%s] is a non-empty, non-whitespace string', key => {
		const value = enContinuity[key];
		expect(typeof value).toBe('string');
		expect(value!.trim().length).toBeGreaterThan(0);
	});

	test.each(REQUIRED_CONTINUITY_KEYS)('es.continuity[%s] is a non-empty, non-whitespace string', key => {
		const value = esContinuity[key];
		expect(typeof value).toBe('string');
		expect(value!.trim().length).toBeGreaterThan(0);
	});

	test.each(REQUIRED_CONTINUITY_KEYS)('en.continuity[%s] differs from es.continuity[%s] (actually translated)', key => {
		expect(enContinuity[key]).not.toBe(esContinuity[key]);
	});

	test.each(REQUIRED_CONTINUITY_KEYS)('en.continuity[%s] contains no phase number or decision id', key => {
		expect(enContinuity[key]).not.toMatch(PHASE_OR_DECISION_ID_PATTERN);
	});

	test.each(REQUIRED_CONTINUITY_KEYS)('es.continuity[%s] contains no phase number or decision id', key => {
		expect(esContinuity[key]).not.toMatch(PHASE_OR_DECISION_ID_PATTERN);
	});

	test.each(REQUIRED_CONTINUITY_KEYS)('en.continuity[%s] contains no QR/camera/scan wording (D-36)', key => {
		expect(enContinuity[key]).not.toMatch(QR_SCAN_PATTERN);
	});

	test.each(REQUIRED_CONTINUITY_KEYS)('es.continuity[%s] contains no QR/camera/scan wording (D-36)', key => {
		expect(esContinuity[key]).not.toMatch(QR_SCAN_PATTERN);
	});

	test.each(REQUIRED_CONTINUITY_KEYS)('en.continuity[%s] carries no interpolation token', key => {
		expect(enContinuity[key]).not.toMatch(/\{\{/);
	});

	test.each(REQUIRED_CONTINUITY_KEYS)('es.continuity[%s] carries no interpolation token', key => {
		expect(esContinuity[key]).not.toMatch(/\{\{/);
	});

	// D-43: restarting a pending registration is explicitly "from scratch", never a resume/merge.
	test('D-43: restart.body says "from scratch", newDevice.restartLink names the pending state', () => {
		expect(enContinuity['restart.body']).toContain('from scratch');
		expect(enContinuity['newDevice.restartLink']).toContain('pending');
	});

	// D-41: the retired device's notice says plainly it can no longer vote.
	test('D-41: deviceRetired.body says the device can no longer be used to vote', () => {
		expect(enContinuity['deviceRetired.body']).toContain('can no longer be used to vote');
	});

	// D-45: the code path and the identity-fallback path.
	test('D-45: identityFallbackBody names an officer, code.body mentions another device, code.notAvailableOnDevice offers the identity fallback', () => {
		expect(enContinuity['newDevice.identityFallbackBody']).toContain('officer');
		expect(enContinuity['code.body']).toContain('another device');
		expect(enContinuity['code.notAvailableOnDevice']).toContain('confirm your identity');
	});

	test('the pre-existing namespaces are still present in both resources.en and resources.es', () => {
		for (const ns of ['common', 'home', 'ballot', 'registration', 'scan', 'settings', 'timeline']) {
			expect(typeof (resources.en as Record<string, unknown>)[ns]).toBe('object');
			expect(typeof (resources.es as Record<string, unknown>)[ns]).toBe('object');
		}
	});
});
