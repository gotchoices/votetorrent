/**
 * The confirm-age rule: a confirm card left open more than five minutes after the tap is stale, so
 * the screens recompute the effective time and show the card again instead of signing a time that
 * has already passed or nearly passed. Unreadable input fails closed (stale).
 */

import { readFileSync } from "fs";
import { join } from "path";

import { ADMIN_CHANGE_DELAY_MS, adminChangeEffectiveAt } from "@votetorrent/vote-core";

import { ADMIN_CHANGE_CONFIRM_MAX_AGE_MS, isAdminChangeConfirmStale } from "../displayUtils";

const T0 = Date.UTC(2026, 10, 5, 3, 57, 0);
const AT = adminChangeEffectiveAt(T0);
const SIX_MIN = T0 + 360_000;
const TWO_H = T0 + 7_200_000;
const NINETY_S = T0 + 90_000;
const BOUNDARY = T0 + ADMIN_CHANGE_CONFIRM_MAX_AGE_MS;
const LATER_AT = adminChangeEffectiveAt(TWO_H);

describe("isAdminChangeConfirmStale", () => {
	it("pins the five-minute age and the one-hour delay", () => {
		expect(ADMIN_CHANGE_CONFIRM_MAX_AGE_MS).toBe(300_000);
		expect(ADMIN_CHANGE_DELAY_MS).toBe(3_600_000);
		expect(AT).toBe("2026-11-05T04:57:00");
	});

	it("is fresh right after the tap and 90 seconds later", () => {
		expect(isAdminChangeConfirmStale(AT, T0)).toBe(false);
		expect(isAdminChangeConfirmStale(AT, NINETY_S)).toBe(false);
	});

	it("is still fresh at exactly five minutes and stale one millisecond later", () => {
		expect(isAdminChangeConfirmStale(AT, BOUNDARY)).toBe(false);
		expect(isAdminChangeConfirmStale(AT, BOUNDARY + 1)).toBe(true);
	});

	it("is stale six minutes and two hours after the tap", () => {
		expect(isAdminChangeConfirmStale(AT, SIX_MIN)).toBe(true);
		expect(isAdminChangeConfirmStale(AT, TWO_H)).toBe(true);
		// Control: two hours on, the shown time has already passed.
		expect(Date.parse(AT + "Z") < TWO_H).toBe(true);
	});

	it("a time recomputed at the later instant is fresh", () => {
		expect(isAdminChangeConfirmStale(LATER_AT, TWO_H)).toBe(false);
	});

	it("reads every accepted form as the same UTC instant, in any zone", () => {
		const forms = ["2026-11-05T04:57:00", "2026-11-05 04:57:00", "2026-11-05T04:57:00.123", "2026-11-05T04:57:00Z"];
		for (const form of forms) {
			expect(isAdminChangeConfirmStale(form, T0)).toBe(isAdminChangeConfirmStale(AT, T0));
			expect(isAdminChangeConfirmStale(form, SIX_MIN)).toBe(isAdminChangeConfirmStale(AT, SIX_MIN));
		}
	});

	it("fails closed on unreadable input without throwing", () => {
		for (const bad of ["", "nonsense", "2026-11-05"]) {
			expect(() => isAdminChangeConfirmStale(bad, T0)).not.toThrow();
			expect(isAdminChangeConfirmStale(bad, T0)).toBe(true);
		}
		expect(isAdminChangeConfirmStale(AT, NaN)).toBe(true);
		expect(isAdminChangeConfirmStale(AT, Infinity)).toBe(true);
		const notAString = 42 as unknown as string;
		expect(() => isAdminChangeConfirmStale(notAString, T0)).not.toThrow();
		expect(isAdminChangeConfirmStale(notAString, T0)).toBe(true);
	});
});

describe("displayUtils source", () => {
	const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
	const DELAY_ASSIGN = new RegExp("ADMIN_CHANGE_" + "DELAY_MS" + "\\s*=(?!=)");
	const HELPER = "adminChange" + "EffectiveAt";
	const LOCAL_PARSE = "Date" + ".parse";

	it("never assigns the delay, calls the effective-time helper or parses dates as local time", () => {
		const code = stripComments(readFileSync(join(__dirname, "..", "displayUtils.ts"), "utf8"));
		expect(DELAY_ASSIGN.test(code)).toBe(false);
		expect(code.includes(HELPER)).toBe(false);
		expect(code.includes(LOCAL_PARSE)).toBe(false);
	});

	it("control: a planted delay assignment is caught", () => {
		const planted = "const x = 1; " + "ADMIN_CHANGE_" + "DELAY_MS" + " = 5;";
		expect(DELAY_ASSIGN.test(planted)).toBe(true);
		expect(DELAY_ASSIGN.test("ADMIN_CHANGE_" + "DELAY_MS" + " === 5")).toBe(false);
	});
});
