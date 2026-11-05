/**
 * RegistrantRow.test.tsx — co-located coverage for the roster list row and
 * its `registrant-display.ts` pure helpers (D-04/D-08). `react-test-renderer`
 * only, file-scope module mocks — mirrors
 * `RegistrationFieldsSection.test.tsx`'s screen-local component test shape
 * and `RegistrationPolicyScreen.test.tsx`'s sentinel-color idiom (distinct
 * per-token colors so a color assertion can never pass by accidental token
 * equality).
 */

import React from "react";
import renderer from "react-test-renderer";
import type { RegistrantListRow } from "@votetorrent/vote-core";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({
		colors: {
			success: "sentinel-success",
			warning: "sentinel-warning",
			error: "sentinel-error",
			accent: "sentinel-accent",
			card: "sentinel-card",
			textSecondary: "sentinel-textSecondary",
			text: "sentinel-text",
			border: "sentinel-border",
			dark: "sentinel-dark",
			light: "sentinel-light",
		},
	}),
}));

// Required AFTER the jest.mock() calls above — a static top-level `import` of
// a sibling module that transitively renders `TouchableOpacity` resolves
// against react-native's real module BEFORE the mocks above are wired,
// producing a "type is invalid" render crash (matches the established
// convention in `RegistrationFieldsSection.test.tsx`/`VerdictBadge.test.tsx`).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { RegistrantRow } = require("../RegistrantRow");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { registrantDisplayName, formatExpirationDate, truncateId } = require("../../registrant-display");

/**
 * Renders `RegistrantRow` inside `renderer.act(...)` — required under React
 * 19's stricter act semantics; an unwrapped `renderer.create(...)` call does
 * not synchronously flush and produces a `null` tree with no other signal
 * (matches `VerdictBadge.test.tsx`/`RegistrationPolicyScreen.test.tsx`'s
 * render helpers).
 */
function renderRow(row: RegistrantListRow, onPress: () => void = () => {}): renderer.ReactTestRenderer {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(<RegistrantRow row={row} onPress={onPress} />);
	});
	return tr;
}

function makeRow(overrides: Partial<RegistrantListRow> = {}): RegistrantListRow {
	return {
		registrantId: "reg-001",
		authorityId: "auth-1",
		status: "a",
		expiration: "2027-01-02T03:04:05.000Z",
		privateCid: "very-secret-private-cid",
		publicCid: "pub-cid",
		selectiveCid: "very-secret-selective-cid",
		lastName: "Doe",
		firstName: "Jane",
		district: "D1",
		...overrides,
	};
}

describe("registrant-display pure helpers", () => {
	it("registrantDisplayName: last + first -> 'Last, First'", () => {
		expect(registrantDisplayName({ registrantId: "x", lastName: "Doe", firstName: "Jane" })).toBe("Doe, Jane");
	});

	it("registrantDisplayName: last only", () => {
		expect(registrantDisplayName({ registrantId: "x", lastName: "Doe", firstName: undefined })).toBe("Doe");
	});

	it("registrantDisplayName: first only", () => {
		expect(registrantDisplayName({ registrantId: "x", lastName: undefined, firstName: "Jane" })).toBe("Jane");
	});

	it("registrantDisplayName: neither present -> truncated id", () => {
		expect(
			registrantDisplayName({ registrantId: "abcdefghij", lastName: undefined, firstName: undefined }),
		).toBe("abcde...");
	});

	it("registrantDisplayName: whitespace-only lastName is treated as absent", () => {
		expect(registrantDisplayName({ registrantId: "abcdefghij", lastName: "   ", firstName: undefined })).toBe(
			"abcde...",
		);
	});

	it("formatExpirationDate: ISO-Z -> YYYY-MM-DD", () => {
		expect(formatExpirationDate("2027-01-02T03:04:05.000Z")).toBe("2027-01-02");
	});

	it("formatExpirationDate: an unparseable string is returned unchanged and never throws", () => {
		expect(() => formatExpirationDate("not-a-date")).not.toThrow();
		expect(formatExpirationDate("not-a-date")).toBe("not-a-date");
	});

	it("truncateId: a 4-char id (shorter than keep) is returned unchanged", () => {
		expect(truncateId("abcd")).toBe("abcd");
	});
});

describe("RegistrantRow", () => {
	it("each of the three statuses renders its own registrantStatus* key AND its own sentinel color on the label", () => {
		const cases: Array<{ status: RegistrantListRow["status"]; key: string; color: string }> = [
			{ status: "a", key: "registrantStatusActive", color: "sentinel-success" },
			{ status: "s", key: "registrantStatusSuspended", color: "sentinel-warning" },
			{ status: "r", key: "registrantStatusRevoked", color: "sentinel-error" },
		];

		for (const { status, key, color } of cases) {
			const row = makeRow({ status });
			const tr = renderRow(row);
			const pill = tr.root.findByProps({ testID: "registrant-row-status-" + row.registrantId });
			const label = pill.findByProps({ children: key });
			expect((label.props.style as { color: string }).color).toBe(color);
			tr.unmount();
		}
	});

	it("the district line is absent when row.district is undefined and present when set", () => {
		// `{ deep: false }` — ThemedText spreads `testID` onto its inner `Text`,
		// so a `deep` search would double-count one logical district line as
		// two matching test instances (the composite ThemedText + its host Text).
		const withoutDistrict = makeRow({ district: undefined });
		const trWithout = renderRow(withoutDistrict);
		expect(
			trWithout.root.findAllByProps(
				{ testID: "registrant-row-district-" + withoutDistrict.registrantId },
				{ deep: false },
			).length,
		).toBe(0);
		trWithout.unmount();

		const withDistrict = makeRow({ district: "D9" });
		const trWith = renderRow(withDistrict);
		expect(
			trWith.root.findAllByProps(
				{ testID: "registrant-row-district-" + withDistrict.registrantId },
				{ deep: false },
			).length,
		).toBe(1);
		trWith.unmount();
	});

	it("renders the truncated id as the name when no public tier is present", () => {
		const row = makeRow({ lastName: undefined, firstName: undefined, registrantId: "zzzzzzzzzzzz" });
		const tr = renderRow(row);
		expect(JSON.stringify(tr.toJSON())).toContain("zzzzz...");
		tr.unmount();
	});

	it("onPress fires exactly once when the row is pressed", () => {
		const onPress = jest.fn();
		const row = makeRow();
		const tr = renderRow(row, onPress);
		const touchable = tr.root.findByProps({ testID: "registrant-row-" + row.registrantId });
		touchable.props.onPress();
		expect(onPress).toHaveBeenCalledTimes(1);
		tr.unmount();
	});

	it("negative space: renders identifiers and public-tier data only — no private/selective substring reaches the tree", () => {
		const row = makeRow();
		const tr = renderRow(row);
		const json = JSON.stringify(tr.toJSON());
		expect(json).not.toContain("privateCid");
		expect(json).not.toContain("selectiveCid");
		expect(json).not.toContain("ssn");
		expect(json).not.toContain("SSN");
		tr.unmount();
	});
});
