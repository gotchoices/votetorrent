/**
 * Phase 47 plan 47-02 (D-01/D-03/D-04/D-05/D-07/D-08/D-09/D-10/D-11/D-12/D-13/D-14) —
 * registrant/attestation/device i18n key-group proof.
 *
 * Renderer-free: imports only the exported `resources` object. No renderer
 * package is a dependency of this app — see 47-02-PLAN.md's `read_first` note.
 *
 * A duplicate key inside a single object literal is silently collapsed by the
 * JS parser (the later entry wins, with no runtime trace) — this test alone
 * CANNOT detect that failure mode. The companion source-level `sort | uniq -d`
 * grep gate (see 47-02-PLAN.md's `<verify>`/acceptance criteria) is required
 * in addition to this test, not instead of it.
 */

import { resources } from '../index';

const enTranslation = resources.en.translation as Record<string, string>;
const esTranslation = resources.es.translation as Record<string, string>;

const REGISTRANT_LIST_RE = /^registrantList[A-Z]/;
const REGISTRANT_STATUS_RE = /^registrantStatus[A-Z]/;
const REGISTRANT_DETAIL_RE = /^registrantDetail[A-Z]/;
const REGISTRANT_LIFECYCLE_RE = /^registrantLifecycle[A-Z]/;
const REGISTRANT_ACCESS_TRAIL_RE = /^registrantAccessTrail[A-Z]/;
const REGISTRANT_SCOPE_RE = /^registrantScope[A-Z]/;
const ASSOCIATION_LIST_RE = /^associationList[A-Z]/;
const ATTESTATION_CHALLENGE_RE = /^attestationChallenge[A-Z]/;
const ATTESTATION_VERDICT_RE = /^attestationVerdict[A-Z]/;
const ATTESTATION_PROVISIONING_RE = /^attestationProvisioning[A-Z]/;
const POLLING_DEVICE_RE = /^pollingDevice[A-Z]/;
const AUTHORITY_PEER_RE = /^authorityPeer[A-Z]/;

const GROUPS: ReadonlyArray<[RegExp, number]> = [
	[REGISTRANT_LIST_RE, 15],
	[REGISTRANT_STATUS_RE, 3],
	[REGISTRANT_DETAIL_RE, 17],
	[REGISTRANT_LIFECYCLE_RE, 17],
	[REGISTRANT_ACCESS_TRAIL_RE, 5],
	[ASSOCIATION_LIST_RE, 10],
	[ATTESTATION_CHALLENGE_RE, 11],
	[ATTESTATION_VERDICT_RE, 5],
	[ATTESTATION_PROVISIONING_RE, 8],
	[POLLING_DEVICE_RE, 12],
	// 13, not 12: 47-REVIEW IN-06 added authorityPeerDuplicateError, replacing
	// the one hard-coded English string this group used to render.
	[AUTHORITY_PEER_RE, 13],
	[REGISTRANT_SCOPE_RE, 2],
];

const ALL_PHASE_47_RE = new RegExp(
	`^(${[
		'registrantList',
		'registrantStatus',
		'registrantDetail',
		'registrantLifecycle',
		'registrantAccessTrail',
		'registrantScope',
		'associationList',
		'attestationChallenge',
		'attestationVerdict',
		'attestationProvisioning',
		'pollingDevice',
		'authorityPeer',
	].join('|')})[A-Z]`
);

describe('Phase 47 registrant/attestation/device i18n key groups', () => {
	test('each Phase 47 prefix group has its exact key count in EN, and the ES key set is deeply equal', () => {
		let totalEn = 0;
		for (const [re, expectedCount] of GROUPS) {
			const enKeys = Object.keys(enTranslation).filter((k) => re.test(k));
			const esKeys = Object.keys(esTranslation).filter((k) => re.test(k));

			expect(enKeys).toHaveLength(expectedCount);
			expect(new Set(esKeys)).toEqual(new Set(enKeys));
			expect(esKeys).toHaveLength(expectedCount);

			totalEn += enKeys.length;
		}
		expect(totalEn).toBe(118);
	});

	test('no Phase 47 value is empty or whitespace-only, in either locale', () => {
		const enKeys = Object.keys(enTranslation).filter((k) => ALL_PHASE_47_RE.test(k));
		for (const key of enKeys) {
			expect(enTranslation[key]?.trim().length).toBeGreaterThan(0);
			expect(esTranslation[key]?.trim().length).toBeGreaterThan(0);
		}
	});

	test('every {{placeholder}} token matches between EN and ES', () => {
		const enKeys = Object.keys(enTranslation).filter((k) => ALL_PHASE_47_RE.test(k));
		for (const key of enKeys) {
			const enPlaceholders = [...(enTranslation[key]?.matchAll(/\{\{(\w+)\}\}/g) ?? [])]
				.map((m) => m[1])
				.sort();
			const esPlaceholders = [...(esTranslation[key]?.matchAll(/\{\{(\w+)\}\}/g) ?? [])]
				.map((m) => m[1])
				.sort();
			expect(esPlaceholders).toEqual(enPlaceholders);
		}
	});

	// D-01 / T-47-03: the trail is advisory and bypassable. This copy is the one
	// place that framing reaches the officer — it may never describe the trail as
	// preventing anything.
	test('registrantAccessTrailDisclaimer preserves the D-01 framing verbatim in both locales', () => {
		expect(enTranslation.registrantAccessTrailDisclaimer).toBe(
			'Records when an officer viewed private details for this registrant through this app, and which fields were revealed — for accountability and transparency, not as a security control. It only captures access made through this app; direct database access is not recorded here.'
		);
		expect(esTranslation.registrantAccessTrailDisclaimer).toBe(
			'Registra cuándo un funcionario vio los detalles privados de este registrante a través de esta aplicación, y qué campos fueron revelados — para rendición de cuentas y transparencia, no como control de seguridad. Solo captura el acceso realizado a través de esta aplicación; el acceso directo a la base de datos no queda registrado aquí.'
		);

		expect(enTranslation.registrantAccessTrailDisclaimer).toContain('not as a security control');
		expect(enTranslation.registrantAccessTrailDisclaimer).toContain(
			'accountability and transparency'
		);
		expect(enTranslation.registrantAccessTrailDisclaimer).toContain(
			'direct database access is not recorded here'
		);
		expect(enTranslation.registrantAccessTrailDisclaimer).not.toMatch(
			/\b(prevents?|blocks?|stops?|protects? against)\b/i
		);
	});

	test('no attestationChallenge* key offers an issue affordance (D-11)', () => {
		const enKeys = Object.keys(enTranslation).filter((k) => ATTESTATION_CHALLENGE_RE.test(k));

		const issueKeys = enKeys.filter((k) => /issue/i.test(k));
		expect(issueKeys).toEqual([]);

		const issueValues = enKeys.filter(
			(k) => k !== 'attestationChallengeExpireBody' && /\bissue\b/i.test(enTranslation[k] ?? '')
		);
		expect(issueValues).toEqual([]);

		expect(enKeys).toHaveLength(11);
	});

	test('the scope-gate banners carry the {{scope}} interpolation contract', () => {
		expect(enTranslation.registrantScopeReadOnlyBanner).toContain('{{scope}}');
		expect(esTranslation.registrantScopeReadOnlyBanner).toContain('{{scope}}');
		expect(enTranslation.authorityPeerScopeReadOnlyBanner).toContain('{{scope}}');
		expect(esTranslation.authorityPeerScopeReadOnlyBanner).toContain('{{scope}}');

		expect(enTranslation.registrantScopeReadOnlyNoOfficerBanner).not.toMatch(/\{\{/);
		expect(esTranslation.registrantScopeReadOnlyNoOfficerBanner).not.toMatch(/\{\{/);
	});

	test('no Phase 47 copy string binds a private-tier value placeholder (T-47-02)', () => {
		const enKeys = Object.keys(enTranslation).filter((k) => ALL_PHASE_47_RE.test(k));
		const privateValueRe = /\{\{(ssn|dob|dateOfBirth|phone|value|privateValue)\}\}/i;
		for (const key of enKeys) {
			expect(enTranslation[key]).not.toMatch(privateValueRe);
			expect(esTranslation[key]).not.toMatch(privateValueRe);
		}
	});

	test('Phase 46 key groups survive intact', () => {
		const REGISTRATION_POLICY_RE = /^registrationPolicy[A-Z]/;
		const enPolicyKeys = Object.keys(enTranslation).filter((k) => REGISTRATION_POLICY_RE.test(k));
		const esPolicyKeys = Object.keys(esTranslation).filter((k) => REGISTRATION_POLICY_RE.test(k));
		// 62-10 added 7 registrationPolicyReassociation* device-change review keys, moving the pin
		// from 55 to 62.
		expect(enPolicyKeys).toHaveLength(62);
		expect(esPolicyKeys).toHaveLength(62);

		expect(enTranslation.registrationEnds).toBe('Registration Ends');
		expect(enTranslation.registrationOpens).toBe('Registration Opens');
		expect(enTranslation.registrationCloses).toBe('Registration Closes');
		expect(enTranslation.registrationDeadline).toBe('Registration Deadline');

		expect(esTranslation.registrationEnds).toBe('Finaliza Registro');
		expect(esTranslation.registrationOpens).toBe('Abre el Registro');
		expect(esTranslation.registrationCloses).toBe('Cierra el Registro');
		expect(esTranslation.registrationDeadline).toBe('Fecha Límite de Registro');
	});
});
