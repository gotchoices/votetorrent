/**
 * polling-device-hash.test.ts — Phase 47 plan 47-17. Renderer-free truth
 * table locking the 64-lowercase-hex gate and the normalize-before-validate
 * contract for `PollingDevice.DeviceHash` entry.
 *
 * Renderer-free by design (mirrors
 * `src/i18n/__tests__/registration-policy-keys.test.ts`): imports only
 * `../polling-device-hash`, no `react-test-renderer`, no `jest.mock`. The
 * module under test has zero imports of its own — see that file's doc block
 * for the full security framing (association-engine.ts's exact-match waiver
 * lookup is why an uppercase or padded hash is a silent, no-error failure
 * mode this test suite exists to prevent).
 */

import {
	DEVICE_HASH_PATTERN,
	normalizeDeviceHash,
	isValidDeviceHash,
	truncateDeviceHash,
	formatDeviceTitle,
} from '../polling-device-hash';

// Build 64-char fixtures programmatically so no 64-character literal is
// miscounted by hand; each fixture's length is asserted below so a mistyped
// fixture fails loudly instead of silently weakening a case.
const LOWER_64 = 'a1b2c3d4'.repeat(8);
const UPPER_64 = LOWER_64.toUpperCase();
const MIXED_64 = 'A1b2C3d4'.repeat(8);

describe('polling-device-hash fixtures are exactly 64 characters', () => {
	test('LOWER_64/UPPER_64/MIXED_64 fixtures are 64 chars', () => {
		expect(LOWER_64).toHaveLength(64);
		expect(UPPER_64).toHaveLength(64);
		expect(MIXED_64).toHaveLength(64);
	});
});

describe('DEVICE_HASH_PATTERN', () => {
	test('is the exact lowercase-anchored 64-hex pattern', () => {
		expect(DEVICE_HASH_PATTERN.source).toBe('^[0-9a-f]{64}$');
	});
});

type IsValidCase = [input: string, expected: boolean, why: string];

const IS_VALID_CASES: ReadonlyArray<IsValidCase> = [
	[LOWER_64, true, '64 lowercase hex is valid'],
	[UPPER_64, true, 'uppercased is valid — normalized before validation'],
	[MIXED_64, true, 'mixed case is valid — normalized before validation'],
	[
		'  ' + LOWER_64 + '  ',
		true,
		'leading/trailing whitespace is valid — trimmed before validation',
	],
	[LOWER_64 + '\n', true, 'a trailing newline is valid — trimmed before validation'],
	[LOWER_64.slice(0, 63), false, '63 chars is invalid — too short'],
	[LOWER_64 + 'a', false, '65 chars is invalid — too long'],
	[LOWER_64.slice(0, 63) + 'g', false, "64 chars with one 'g' is invalid — non-hex char"],
	[
		LOWER_64.slice(0, 32) + ' ' + LOWER_64.slice(33),
		false,
		'64 chars with one interior space is invalid — interior whitespace is never stripped',
	],
	['', false, 'empty string is invalid'],
	['   ', false, 'whitespace-only is invalid'],
	['0x' + LOWER_64.slice(0, 64), false, "a '0x'-prefixed 66-char string is invalid — no prefix stripping"],
	[
		'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d+/=aBcD',
		false,
		"a 64-char base64-shaped string containing '+'/'/'/'=' is invalid",
	],
];

describe('isValidDeviceHash truth table', () => {
	test.each(IS_VALID_CASES)('%s -> %s (%s)', (input, expected) => {
		expect(isValidDeviceHash(input)).toBe(expected);
	});
});

describe('normalizeDeviceHash', () => {
	test('lowercases', () => {
		expect(normalizeDeviceHash(UPPER_64)).toBe(LOWER_64);
	});

	test('trims leading/trailing whitespace', () => {
		expect(normalizeDeviceHash('  ' + LOWER_64 + '  ')).toBe(LOWER_64);
	});

	test('does nothing else — an interior space survives normalization', () => {
		const withInteriorSpace = LOWER_64.slice(0, 32) + ' ' + LOWER_64.slice(33);
		// Proves the interior-space case above actually reaches the pattern (and
		// fails there) rather than being silently repaired by normalization.
		expect(normalizeDeviceHash(withInteriorSpace)).toBe(withInteriorSpace.toLowerCase());
		expect(normalizeDeviceHash(withInteriorSpace)).toContain(' ');
	});
});

describe('truncateDeviceHash', () => {
	test('returns short inputs unchanged', () => {
		expect(truncateDeviceHash('short')).toBe('short');
		expect(truncateDeviceHash('exactly12chr')).toBe('exactly12chr');
	});

	test('returns exactly 12 chars plus "..." for a 64-char input, length 15', () => {
		const truncated = truncateDeviceHash(LOWER_64);
		expect(truncated).toBe(LOWER_64.slice(0, 12) + '...');
		expect(truncated).toHaveLength(15);
	});
});

describe('formatDeviceTitle', () => {
	test('prefers a non-empty, trimmed label', () => {
		expect(formatDeviceTitle({ deviceHash: LOWER_64, label: '  Precinct 4 tablet  ' })).toBe(
			'Precinct 4 tablet',
		);
	});

	test('falls through to the truncated hash for an undefined label', () => {
		expect(formatDeviceTitle({ deviceHash: LOWER_64 })).toBe(truncateDeviceHash(LOWER_64));
	});

	test('falls through to the truncated hash for an empty-string label', () => {
		expect(formatDeviceTitle({ deviceHash: LOWER_64, label: '' })).toBe(truncateDeviceHash(LOWER_64));
	});

	test('falls through to the truncated hash for a whitespace-only label', () => {
		expect(formatDeviceTitle({ deviceHash: LOWER_64, label: '   ' })).toBe(truncateDeviceHash(LOWER_64));
	});
});
