/**
 * access-trail-seam.test.ts — the D-14 access-trail SEAM lock (CR-01).
 *
 * Every other test around this pipeline covers exactly one half of it:
 * `registrant-detail-model.test.ts` asserts the UI flattener produces
 * `"Address.Street"`, and `registrant-access-trail.spec.ts` asserts the engine
 * sanitizer keeps whatever intersects its allowlist. Both passed while the
 * pipeline was broken end-to-end, because the two halves used incompatible
 * name vocabularies (qualified vs. bare segment) and a failed intersection is
 * dropped SILENTLY by design — no error, no log, no row.
 *
 * This file is the only test that joins them. It imports the REAL app-side
 * flattener and the REAL engine-side sanitizer (from vote-engine SOURCE, not
 * its built `dist`, so a stale build cannot mask a regression) and asserts
 * that what the reveal UI emits is exactly what the trail is willing to store.
 *
 * Deliberately uses non-private placeholder values: this test never needs a
 * realistic SSN/DOB to prove a name-vocabulary property.
 */
import type { PrivateDetail } from '@votetorrent/vote-core';
import { flattenPrivateDetails } from '../registrant-detail-model';
import {
	collectPrivateFieldNames,
	sanitizeAccessTrailFields,
} from '../../../../../../packages/vote-engine/src/registration/access-trail-fields';

/** A nested fixture: two scalar leaves at the root, one group, one group-in-group. */
const DETAILS: PrivateDetail[] = [
	{ name: 'Ssn', value: 'placeholder-a' },
	{ name: 'Dob', value: 'placeholder-b' },
	{
		name: 'Address',
		value: [
			{ name: 'Street', value: 'placeholder-c' },
			{ name: 'Zip', value: 'placeholder-d' },
			{ name: 'Geo', value: [{ name: 'Lat', value: 'placeholder-e' }] },
		],
	},
];

describe('D-14 access-trail seam: UI reveal names vs. engine allowlist', () => {
	it('every name the flattener renders is accepted by the engine allowlist', () => {
		const revealed = flattenPrivateDetails(DETAILS).map((row) => row.name);
		const stored = sanitizeAccessTrailFields(revealed, collectPrivateFieldNames(DETAILS));
		expect([...stored].sort()).toEqual([...revealed].sort());
	});

	it('no revealed name is dropped — the intersection loses nothing', () => {
		const revealed = flattenPrivateDetails(DETAILS).map((row) => row.name);
		const stored = new Set(sanitizeAccessTrailFields(revealed, collectPrivateFieldNames(DETAILS)));
		const dropped = revealed.filter((name) => !stored.has(name));
		expect(dropped).toEqual([]);
	});

	it('a NESTED reveal in particular survives — the exact CR-01 regression', () => {
		// The pre-fix bug: the UI emitted "Address.Street" while the allowlist
		// held only {"Address","Street"}, so this single-name call sanitized to
		// [] and recordRegistrantAccessEvent returned without writing a row.
		const stored = sanitizeAccessTrailFields(['Address.Street'], collectPrivateFieldNames(DETAILS));
		expect(stored).toEqual(['Address.Street']);
	});

	it('a doubly-nested reveal survives too', () => {
		const stored = sanitizeAccessTrailFields(
			['Address.Geo.Lat'],
			collectPrivateFieldNames(DETAILS)
		);
		expect(stored).toEqual(['Address.Geo.Lat']);
	});

	it('the flattener emits leaves only, so no group name is ever revealed', () => {
		const revealed = flattenPrivateDetails(DETAILS).map((row) => row.name);
		expect(revealed).not.toContain('Address');
		expect(revealed).not.toContain('Address.Geo');
	});

	it('the value-rejection lock still holds across the seam: values are not names', () => {
		const revealed = flattenPrivateDetails(DETAILS);
		const values = revealed.map((row) => row.value);
		const stored = sanitizeAccessTrailFields(values, collectPrivateFieldNames(DETAILS));
		expect(stored).toEqual([]);
	});
});
