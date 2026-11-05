/**
 * formatLocalTime: a canonical UTC datetime (as the shared effective-time helper writes it) shown
 * as the phone's local 24-hour HH:MM. The zone-specific cases run only in the zone they describe,
 * detected through getTimezoneOffset, so the suite is meaningful under any TZ and exact under
 * Asia/Kathmandu and UTC.
 */

import { adminChangeEffectiveAt } from "@votetorrent/vote-core";

import { formatLocalTime } from "../displayUtils";

const OFFSET = new Date(Date.UTC(2026, 10, 5, 4, 57, 0)).getTimezoneOffset();
const IN_KTM = OFFSET === -345;
const IN_UTC = OFFSET === 0;

const itKtm = IN_KTM ? it : it.skip;
const itUtc = IN_UTC ? it : it.skip;

const pad = (n: number): string => (n < 10 ? "0" + n : String(n));

describe("formatLocalTime (any zone)", () => {
	it("returns local HH:MM read from the UTC instant", () => {
		const out = formatLocalTime("2026-11-05T04:57:00");
		expect(out).toMatch(/^\d{2}:\d{2}$/);
		const d = new Date(Date.UTC(2026, 10, 5, 4, 57, 0));
		expect(out).toBe(pad(d.getHours()) + ":" + pad(d.getMinutes()));
	});

	it("reads the T, space, fractional-second and trailing Z forms as the same instant", () => {
		const base = formatLocalTime("2026-11-05T04:57:00");
		expect(formatLocalTime("2026-11-05 04:57:00")).toBe(base);
		expect(formatLocalTime("2026-11-05T04:57:00.123")).toBe(base);
		expect(formatLocalTime("2026-11-05T04:57:00Z")).toBe(base);
		expect(formatLocalTime("2026-11-05T04:57:00.123Z")).toBe(base);
	});

	it("returns malformed input unchanged without throwing", () => {
		for (const bad of ["", "nonsense", "2026-11-05", "2026-11-05T4:57"]) {
			expect(() => formatLocalTime(bad)).not.toThrow();
			expect(formatLocalTime(bad)).toBe(bad);
		}
	});

	it("round-trips the shared effective-time helper's canonical form", () => {
		const T0 = Date.UTC(2026, 10, 5, 3, 57, 0);
		const canonical = adminChangeEffectiveAt(T0);
		expect(canonical).toBe("2026-11-05T04:57:00");
		expect(formatLocalTime(canonical)).toBe(formatLocalTime("2026-11-05T04:57:00"));
	});
});

describe("formatLocalTime (exact zones)", () => {
	itKtm("Asia/Kathmandu: 04:57 UTC reads 10:42", () => {
		expect(formatLocalTime("2026-11-05T04:57:00")).toBe("10:42");
	});

	itKtm("Asia/Kathmandu: 18:20 UTC crosses midnight and reads 00:05, never 24:05", () => {
		expect(formatLocalTime("2026-11-05T18:20:00")).toBe("00:05");
	});

	itKtm("Asia/Kathmandu: 13:15 UTC reads 19:00 (the 45 minutes carry into the hour)", () => {
		expect(formatLocalTime("2026-11-05T13:15:00")).toBe("19:00");
	});

	itKtm("Asia/Kathmandu: 13:14 UTC reads 18:59", () => {
		expect(formatLocalTime("2026-11-05T13:14:00")).toBe("18:59");
	});

	itKtm("Asia/Kathmandu: a no-zone string is not read as local time (control)", () => {
		expect(formatLocalTime("2026-11-05T04:57:00")).not.toBe("04:57");
	});

	itUtc("UTC zone: 04:57 UTC reads 04:57", () => {
		expect(formatLocalTime("2026-11-05T04:57:00")).toBe("04:57");
	});

	itUtc("UTC zone: midnight reads 00:00", () => {
		expect(formatLocalTime("2026-11-05T00:00:00")).toBe("00:00");
	});
});
