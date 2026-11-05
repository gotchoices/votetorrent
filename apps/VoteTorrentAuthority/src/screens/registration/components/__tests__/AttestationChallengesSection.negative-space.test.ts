/**
 * AttestationChallengesSection.negative-space.test.ts — Phase 47 plan 47-16.
 *
 * Renderer-free, `fs`-reading, plain-jest suite (the `registration-policy-
 * keys.test.ts` shape): no react-test-renderer, no jest.mock, no component
 * import. It reads `AttestationChallengesSection.tsx`'s own SOURCE TEXT and
 * `i18n/index.ts`'s SOURCE TEXT and asserts structurally over both.
 *
 * This suite proves the COMPONENT cannot reach a create-challenge
 * affordance and renders only from a closed i18n allow-list — it does NOT
 * duplicate 47-02's own i18n negative-space gate, which proves no
 * `attestationChallenge*` KEY named for that action exists in the first
 * place.
 */

import fs from "fs";
import path from "path";

const COMPONENT_SOURCE_PATH = path.join(__dirname, "../AttestationChallengesSection.tsx");
const I18N_SOURCE_PATH = path.join(__dirname, "../../../../i18n/index.ts");
const LIFECYCLE_CARD_SOURCE_PATH = path.join(__dirname, "../LifecycleConfirmCard.tsx");

const componentSource = fs.readFileSync(COMPONENT_SOURCE_PATH, "utf8");
const i18nSource = fs.readFileSync(I18N_SOURCE_PATH, "utf8");
const lifecycleCardSource = fs.readFileSync(LIFECYCLE_CARD_SOURCE_PATH, "utf8");

// A direct `import { isBareDismissLabel } from "../LifecycleConfirmCard"`
// was tried first per this task's read_first note, but LifecycleConfirmCard
// transitively imports CustomButton, which imports
// `react-native-vector-icons/FontAwesome6` — an ESM module this
// renderer-free suite's plain-jest transform (no RN preset dependency in
// this file) cannot parse ("Cannot use import statement outside a
// module"). Falling back to the documented alternative: re-derive the
// BARE_DISMISS_LABELS deny-list from LifecycleConfirmCard.tsx's own SOURCE
// TEXT and re-implement the identical (trim + lowercase + includes)
// comparison locally, rather than importing the module.
const bareDismissLabelsMatch = lifecycleCardSource.match(/BARE_DISMISS_LABELS[\s\S]*?=\s*\[([^\]]*)\]/);
if (!bareDismissLabelsMatch) {
	throw new Error(
		"negative-space suite: could not locate BARE_DISMISS_LABELS in LifecycleConfirmCard.tsx",
	);
}
const BARE_DISMISS_LABELS = Array.from(bareDismissLabelsMatch[1].matchAll(/"([^"]*)"/g)).map((m) => m[1]);

function isBareDismissLabel(label: string): boolean {
	return BARE_DISMISS_LABELS.includes(label.trim().toLowerCase());
}

/**
 * executableLines — drops every comment-only line (leading-token match:
 * `//`, `*`, `/*`, or the JSX comment opener `{/*`). This is a LEADING-TOKEN
 * filter, not a parser: a trailing comment on a line of executable code is
 * NOT stripped, which is exactly why the component's own source discipline
 * requires every explanatory mention of the forbidden verb to sit on its
 * own dedicated comment line.
 */
function executableLines(src: string): string[] {
	return src.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line));
}

// The EN and ES slices of the shipped i18n resources map, sliced by the
// same `\ten: {` / `\tes: {` markers 47-02's own gates regex against.
const EN_MARKER = "\ten: {";
const ES_MARKER = "\tes: {";
const enStart = i18nSource.indexOf(EN_MARKER);
const esStart = i18nSource.indexOf(ES_MARKER);
if (enStart === -1 || esStart === -1 || esStart <= enStart) {
	throw new Error("negative-space suite: could not locate the en/es slice markers in i18n/index.ts");
}
const enSlice = i18nSource.slice(enStart, esStart);
const esSlice = i18nSource.slice(esStart);

const CLOSED_KEY_ALLOW_LIST = [
	"attestationChallengeSectionTitle",
	"attestationChallengeEmptyHeading",
	"attestationChallengeEmptyBody",
	"attestationChallengeDeviceKeyLabel",
	"attestationChallengeElectionLabel",
	"attestationChallengeExpiryLabel",
	"attestationChallengeExpireButton",
	"attestationChallengeExpireTitle",
	"attestationChallengeExpireBody",
	"attestationChallengeExpireConfirm",
	"attestationChallengeKeepChallenge",
	"attestationProvisioningInlineBannerBody",
	"attestationProvisioningInlineBannerLink",
	"loading",
];

describe("AttestationChallengesSection — D-11 negative space", () => {
	test("1: no issue-shaped identifier in executable source", () => {
		// D-11: challenges bind to a device key this app does not hold — an
		// operator-issued challenge would have no device able to answer it.
		const executable = executableLines(componentSource).join("\n");
		expect(executable).not.toMatch(/issue/i);
	});

	test("2: the engine's create-challenge method is never called (whole file, comments included)", () => {
		expect(componentSource).not.toContain("issueAttestationChallenge");
	});

	test("3: the read is always registrant-narrowed", () => {
		const matches = componentSource.match(/getAttestationChallenges\(registrantId\)/g) ?? [];
		expect(matches).toHaveLength(1);
		expect(componentSource).not.toMatch(/getAttestationChallenges\(\)/);
	});

	test("4: closed i18n allow-list, cross-validated against i18n/index.ts", () => {
		const executable = executableLines(componentSource).join("\n");
		const extracted = new Set<string>();
		const re = /\bt\(\s*"([^"]+)"/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(executable)) !== null) {
			extracted.add(m[1]);
		}

		// (a) non-empty extraction — a zero-key extraction would make this
		// test vacuous.
		expect(extracted.size).toBeGreaterThan(0);

		// (b) every extracted key is a member of the explicit allow-list.
		for (const key of extracted) {
			expect(CLOSED_KEY_ALLOW_LIST).toContain(key);
		}

		// (c) no extracted key matches the forbidden verb.
		for (const key of extracted) {
			expect(key).not.toMatch(/issue/i);
		}

		// (d) every extracted key exists in BOTH the EN and ES slices of the
		// real i18n/index.ts — the 47-02 drift tripwire.
		for (const key of extracted) {
			expect(enSlice).toMatch(new RegExp(`^\\t+${key}:`, "m"));
			expect(esSlice).toMatch(new RegExp(`^\\t+${key}:`, "m"));
		}
	});

	test("5: the dismiss label is not a bare acknowledgement (47-10 downstream contract)", () => {
		const enMatch = enSlice.match(/^\t+attestationChallengeKeepChallenge:\s*(['"])((?:(?!\1).)*)\1/m);
		const esMatch = esSlice.match(/^\t+attestationChallengeKeepChallenge:\s*(['"])((?:(?!\1).)*)\1/m);
		expect(enMatch).not.toBeNull();
		expect(esMatch).not.toBeNull();

		const enValue = enMatch![2];
		const esValue = esMatch![2];

		expect(enValue.trim().length).toBeGreaterThan(0);
		expect(esValue.trim().length).toBeGreaterThan(0);
		expect(isBareDismissLabel(enValue)).toBe(false);
		expect(isBareDismissLabel(esValue)).toBe(false);

		// A broken import cannot make the whole check silently pass — the
		// predicate must be demonstrably LIVE, not short-circuited to false.
		expect(isBareDismissLabel("Cancel")).toBe(true);
	});

	test("6: no forbidden construct in executable source", () => {
		const executable = executableLines(componentSource).join("\n");
		expect(executable).not.toMatch(/console\./);
		expect(executable).not.toMatch(/Alert/);
		expect(executable).not.toMatch(/FlatList/);
		expect(executable).not.toMatch(/SectionList/);
		expect(executable).not.toMatch(/useCurrentOfficerScopes/);
		expect(executable).not.toMatch(/attestationCid/);
		expect(executable).not.toMatch(/navigation\.navigate/);
		expect(executable).not.toMatch(/useNavigation/);
	});

	test("7: isAttestationVerifierProvisioned is consumed, not re-declared", () => {
		const matches = componentSource.match(/isAttestationVerifierProvisioned\(\)/g) ?? [];
		expect(matches).toHaveLength(1);
		expect(componentSource).not.toContain("AppContextType");
		expect(componentSource).not.toMatch(/\bAppContext\b/);
	});
});
