/**
 * registration-request-display.test.ts — pure unit spec for the
 * registration-request display vocabulary (D-03/D-06). No `react-test-renderer`,
 * no RN module mocks — nothing in the module under test touches React Native.
 */

import { resources } from "../../../i18n";
import {
	REGISTRATION_REQUEST_STATUS_META,
	registrationRequestDisplayName,
	resolveBridgeLabel,
	formatRequestTimestamp,
	resolveRowTimestamps,
	resolveRequestRowStatusMeta,
	KNOWN_REQUEST_FIELD_LABEL_KEYS,
	humanizeFieldName,
} from "../registration-request-display";

describe("REGISTRATION_REQUEST_STATUS_META", () => {
	it("has exactly three entries with the correct label/color mapping", () => {
		expect(Object.keys(REGISTRATION_REQUEST_STATUS_META).sort()).toEqual(["a", "p", "r"]);
		expect(REGISTRATION_REQUEST_STATUS_META.p).toEqual({
			labelKey: "registrationRequestStatusPending",
			colorKey: "warning",
		});
		expect(REGISTRATION_REQUEST_STATUS_META.a).toEqual({
			labelKey: "registrationRequestStatusApproved",
			colorKey: "success",
		});
		expect(REGISTRATION_REQUEST_STATUS_META.r).toEqual({
			labelKey: "registrationRequestStatusRejected",
			colorKey: "error",
		});
	});
});

describe("registrationRequestDisplayName", () => {
	it("last + first -> 'Last, First'", () => {
		expect(registrationRequestDisplayName({ requestId: "x", lastName: "Doe", firstName: "Jane" })).toBe(
			"Doe, Jane",
		);
	});

	it("last only", () => {
		expect(registrationRequestDisplayName({ requestId: "x", lastName: "Doe" })).toBe("Doe");
	});

	it("first only", () => {
		expect(registrationRequestDisplayName({ requestId: "x", firstName: "Jane" })).toBe("Jane");
	});

	it("whitespace-only last, first present -> first wins (whitespace-only treated as absent)", () => {
		expect(registrationRequestDisplayName({ requestId: "x", lastName: "  ", firstName: "Jane" })).toBe("Jane");
	});

	it("no name, no requesterKey -> truncated requestId", () => {
		expect(registrationRequestDisplayName({ requestId: "req-abcdefgh" })).toBe("req-a...");
	});

	it("no name, requesterKey present -> truncated requesterKey takes priority over requestId", () => {
		expect(
			registrationRequestDisplayName({ requestId: "req-abcdefgh", requesterKey: "keyABCDEFGH" }),
		).toBe("keyAB...");
	});

	it("whitespace-only requesterKey falls through to truncated requestId", () => {
		expect(registrationRequestDisplayName({ requestId: "req-abcdefgh", requesterKey: "   " })).toBe(
			"req-a...",
		);
	});
});

describe("resolveBridgeLabel", () => {
	it("neither bridgeLabel nor bridgeId -> undefined", () => {
		expect(resolveBridgeLabel({})).toBeUndefined();
	});

	it("bridgeLabel present -> trimmed label", () => {
		expect(resolveBridgeLabel({ bridgeLabel: " County Clerk " })).toBe("County Clerk");
	});

	it("whitespace-only bridgeLabel with bridgeId -> falls back to truncated bridgeId", () => {
		expect(resolveBridgeLabel({ bridgeLabel: "  ", bridgeId: "bridge-1234567" })).toBe("bridg...");
	});

	it("no bridgeLabel, bridgeId only -> truncated bridgeId", () => {
		expect(resolveBridgeLabel({ bridgeId: "bridge-1234567" })).toBe("bridg...");
	});
});

describe("formatRequestTimestamp", () => {
	it("formats an ISO-Z string to YYYY-MM-DD", () => {
		expect(formatRequestTimestamp("2026-08-05T10:00:00Z")).toBe("2026-08-05");
	});

	it("returns an unparseable string unchanged and never throws", () => {
		expect(() => formatRequestTimestamp("not-a-date")).not.toThrow();
		expect(formatRequestTimestamp("not-a-date")).toBe("not-a-date");
	});
});

describe("resolveRowTimestamps", () => {
	it("identical instants -> claimed is undefined, received is the formatted value", () => {
		const result = resolveRowTimestamps({
			receivedAt: "2026-08-05T10:00:00Z",
			submittedAt: "2026-08-05T10:00:00Z",
		});
		expect(result).toEqual({ received: "2026-08-05" });
		expect(result.claimed).toBeUndefined();
	});

	it("same calendar date, different clock times -> claimed is undefined (equal at rendered precision)", () => {
		const result = resolveRowTimestamps({
			receivedAt: "2026-08-05T10:00:00Z",
			submittedAt: "2026-08-05T02:00:00Z",
		});
		expect(result.received).toBe("2026-08-05");
		expect(result.claimed).toBeUndefined();
	});

	it("different calendar dates -> claimed is defined, not equal to received, each derived from its own field", () => {
		const result = resolveRowTimestamps({
			receivedAt: "2026-08-05T10:00:00Z",
			submittedAt: "2026-07-01T09:00:00Z",
		});
		expect(result.received).toBe("2026-08-05");
		expect(result.claimed).toBe("2026-07-01");
		expect(result.claimed).not.toBe(result.received);
	});

	it("backdated claim (30 days before, 48-07's extreme) -> older value in claimed, newer in received, never swapped", () => {
		const result = resolveRowTimestamps({
			receivedAt: "2026-08-05T10:00:00Z",
			submittedAt: "2026-07-06T10:00:00Z",
		});
		expect(result.received).toBe("2026-08-05");
		expect(result.claimed).toBe("2026-07-06");
	});
});

describe("resolveRequestRowStatusMeta (UAT 62 test 12)", () => {
	const closed = { labelKey: "registrationRequestStatusClosedDuplicate", colorKey: "textSecondary" };

	it("closed and closing duplicate closure override status p with the neutral closed pill", () => {
		expect(resolveRequestRowStatusMeta({ status: "p", duplicateClosure: "closed" })).toEqual(closed);
		expect(resolveRequestRowStatusMeta({ status: "p", duplicateClosure: "closing" })).toEqual(closed);
	});

	it("without closure it falls through to the status ladder, undefined for an unknown code", () => {
		expect(resolveRequestRowStatusMeta({ status: "p" })).toEqual(REGISTRATION_REQUEST_STATUS_META.p);
		expect(resolveRequestRowStatusMeta({ status: "a" })).toEqual(REGISTRATION_REQUEST_STATUS_META.a);
		expect(resolveRequestRowStatusMeta({ status: "r" })).toEqual(REGISTRATION_REQUEST_STATUS_META.r);
		expect(resolveRequestRowStatusMeta({ status: "z" as never })).toBeUndefined();
	});

	// Clipping PROXY only: jest cannot measure layout. The closed label is no longer than a
	// label the pill already renders in that locale.
	it.each(["en", "es"] as const)("%s closed label is no longer than the longest existing pill label (clipping proxy)", (lng) => {
		const tr = (resources as Record<string, { translation: Record<string, string> }>)[lng].translation;
		expect(tr.registrationRequestStatusClosedDuplicate).toBeTruthy();
		const longest = Math.max(
			tr.registrationRequestStatusPending.length,
			tr.registrationRequestStatusApproved.length,
			tr.registrationRequestStatusRejected.length,
		);
		expect(tr.registrationRequestStatusClosedDuplicate.length).toBeLessThanOrEqual(longest);
	});
});

describe("KNOWN_REQUEST_FIELD_LABEL_KEYS", () => {
	it("covers exactly the field names the Voter app submits — no invented label table", () => {
		expect(Object.keys(KNOWN_REQUEST_FIELD_LABEL_KEYS).sort()).toEqual(
			["addressLine1", "addressLine2", "addressLine3", "dob", "email", "firstName", "lastName", "party", "phone"].sort()
		);
	});

	it("every key resolves in both EN and ES, with a Spanish value that is not the English one", () => {
		const en = resources.en.translation as Record<string, string>;
		const es = resources.es.translation as Record<string, string>;
		for (const key of Object.values(KNOWN_REQUEST_FIELD_LABEL_KEYS)) {
			expect(typeof en[key]).toBe("string");
			expect(typeof es[key]).toBe("string");
			expect(es[key]).not.toBe(en[key]);
		}
		expect(en[KNOWN_REQUEST_FIELD_LABEL_KEYS.lastName]).toBe("Last name");
		expect(es[KNOWN_REQUEST_FIELD_LABEL_KEYS.lastName]).toBe("Apellido");
		expect(en[KNOWN_REQUEST_FIELD_LABEL_KEYS.firstName]).toBe("First name");
		expect(es[KNOWN_REQUEST_FIELD_LABEL_KEYS.firstName]).toBe("Nombre");
		expect(en[KNOWN_REQUEST_FIELD_LABEL_KEYS.dob]).toBe("Date of birth");
		expect(es[KNOWN_REQUEST_FIELD_LABEL_KEYS.dob]).toBe("Fecha de nacimiento");
	});
});

describe("humanizeFieldName — fallback for unknown/custom field names", () => {
	it.each([
		["district", "District"],
		["ssn", "Ssn"],
		["homeCounty", "Home county"],
		["home_county", "Home county"],
		["home-county", "Home county"],
		["precinctId2", "Precinct id 2"],
		["homeCounty_code2", "Home county code 2"],
		["voterIDNumber", "Voter id number"],
		["address.lineTwo", "Address / Line two"],
	])("%s -> %s", (raw, expected) => {
		expect(humanizeFieldName(raw)).toBe(expected);
	});
});
