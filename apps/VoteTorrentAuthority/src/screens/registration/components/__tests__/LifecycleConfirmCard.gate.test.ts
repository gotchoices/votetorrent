/**
 * Renderer-free truth table for LifecycleConfirmCard's two exported pure
 * gate predicates: `matchesConfirmationName` (the D-10 typed-match gate,
 * the entire safeguard between a misclick and an irreversible signed
 * status change) and `isBareDismissLabel` (the D-10 "never a bare
 * acknowledgement" rule).
 *
 * Imports only the two pure exports — no test-renderer package, no rendering
 * of any kind. Structured like the plain-jest key-contract suites under
 * `src/i18n/__tests__/`.
 *
 * One `jest.mock` is unavoidable even in this renderer-free suite: the pure
 * exports live in the SAME module as the `LifecycleConfirmCard` component,
 * and that component's static import graph reaches
 * `react-native-vector-icons/FontAwesome6` (via `CustomTextInput` ->
 * `ChipButton`) — a package this workspace's jest config does not transform
 * (its own source uses ESM `import` syntax), so the bare `require` fails at
 * load time regardless of whether anything is ever rendered. This mock
 * unblocks the module graph only; no component render occurs anywhere in
 * this file.
 */

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

import { matchesConfirmationName, isBareDismissLabel, BARE_DISMISS_LABELS } from '../LifecycleConfirmCard';

type Case = [typed: string, expected: string | undefined, expectedResult: boolean, why: string];

// Two distinct Unicode representations of the same visible word "José":
// one precomposed (a single 'é' code point), one decomposed ('e' followed
// by a combining acute accent). No normalization means these must NOT be
// treated as equal by the gate.
const PRECOMPOSED_JOSE = 'Jos\u00e9'; // 'e' + U+00E9 (single precomposed code point)
const DECOMPOSED_JOSE = 'Jose\u0301'; // 'e' + U+0301 combining acute accent (decomposed)

const CASES: ReadonlyArray<Case> = [
	['Jane Doe', 'Jane Doe', true, 'exact match'],
	['jane doe', 'Jane Doe', true, 'differing case'],
	['  Jane Doe  ', 'Jane Doe', true, 'leading/trailing whitespace on typed side'],
	['Jane Doe', '  Jane Doe  ', true, 'leading/trailing whitespace on expected side'],
	['anything', undefined, false, 'expected undefined — fail closed'],
	['anything', '', false, 'expected empty string — fail closed'],
	['', '   ', false, 'expected whitespace-only AND typed also empty — the empty-gate bypass'],
	['', 'Jane Doe', false, 'typed empty'],
	['   ', 'Jane Doe', false, 'typed whitespace-only'],
	['Jane  Doe', 'Jane Doe', false, 'internal double space must not satisfy'],
	['Jane', 'Jane Doe', false, 'prefix must not satisfy'],
	['Jane Doe Jr', 'Jane Doe', false, 'superstring must not satisfy'],
	[PRECOMPOSED_JOSE, DECOMPOSED_JOSE, false, 'decomposed vs precomposed accent must not satisfy'],
	["OBrien", "O'Brien", false, 'punctuation-stripped match must not satisfy'],
];

describe('matchesConfirmationName (D-10 typed-match gate)', () => {
	test.each(CASES)('typed=%p expected=%p -> %p (%s)', (typed, expected, expectedResult) => {
		expect(matchesConfirmationName(typed, expected)).toBe(expectedResult);
	});

	test('the table covers at least 13 cases', () => {
		expect(CASES.length).toBeGreaterThanOrEqual(13);
	});
});

describe('isBareDismissLabel (D-10 never-a-bare-acknowledgement rule)', () => {
	test.each(BARE_DISMISS_LABELS)('"%s" (a BARE_DISMISS_LABELS member) is bare', (label) => {
		expect(isBareDismissLabel(label)).toBe(true);
	});

	test('whitespace/casing variants of a bare label are still bare', () => {
		expect(isBareDismissLabel(' Cancel ')).toBe(true);
		expect(isBareDismissLabel('CANCEL')).toBe(true);
	});

	const REAL_PHASE_47_DISMISS_LABELS = [
		'Keep Current Status',
		'Keep Current Expiration',
		'Keep Association',
		'Keep Challenge',
		'Keep Device',
		'Keep Peer',
		'Mantener Estado Actual',
		'Mantener Asociación',
	];

	test.each(REAL_PHASE_47_DISMISS_LABELS)('"%s" is NOT a bare dismiss label', (label) => {
		expect(isBareDismissLabel(label)).toBe(false);
	});
});
