/**
 * The confirm-age rule: a confirm card left open more than one minute after the tap is stale, so
 * the screens recompute the effective time and show the card again instead of signing a time that
 * has already passed or nearly passed. Unreadable input fails closed (stale).
 */

import { readFileSync } from "fs";
import { join } from "path";

import { ADMIN_CHANGE_DELAY_MS, adminChangeEffectiveAt } from "@votetorrent/vote-core";

import { ADMIN_CHANGE_CONFIRM_MAX_AGE_MS, isAdminChangeConfirmStale } from "../displayUtils";

const T0 = Date.UTC(2026, 10, 5, 3, 57, 0);
const AT = adminChangeEffectiveAt(T0);
const SIXTY_ONE_S = T0 + 61_000;
const TEN_MIN = T0 + 600_000;
const THIRTY_S = T0 + 30_000;
const BOUNDARY = T0 + ADMIN_CHANGE_CONFIRM_MAX_AGE_MS;
const LATER_AT = adminChangeEffectiveAt(TEN_MIN);

describe("isAdminChangeConfirmStale", () => {
	it("pins the one-minute age and the five-minute delay", () => {
		expect(ADMIN_CHANGE_CONFIRM_MAX_AGE_MS).toBe(60_000);
		expect(ADMIN_CHANGE_DELAY_MS).toBe(300_000);
		expect(AT).toBe("2026-11-05T04:02:00");
	});

	it("is fresh right after the tap and 30 seconds later", () => {
		expect(isAdminChangeConfirmStale(AT, T0)).toBe(false);
		expect(isAdminChangeConfirmStale(AT, THIRTY_S)).toBe(false);
	});

	it("is still fresh at exactly one minute and stale one millisecond later", () => {
		expect(isAdminChangeConfirmStale(AT, BOUNDARY)).toBe(false);
		expect(isAdminChangeConfirmStale(AT, BOUNDARY + 1)).toBe(true);
	});

	it("a card signed at the last fresh instant still leaves four minutes before the time", () => {
		expect(Date.parse(AT + "Z") - BOUNDARY).toBe(240_000);
	});

	it("is stale 61 seconds and ten minutes after the tap", () => {
		expect(isAdminChangeConfirmStale(AT, SIXTY_ONE_S)).toBe(true);
		expect(isAdminChangeConfirmStale(AT, TEN_MIN)).toBe(true);
		// Control: ten minutes on, the shown time has already passed.
		expect(Date.parse(AT + "Z") < TEN_MIN).toBe(true);
	});

	it("a time recomputed at the later instant is fresh", () => {
		expect(isAdminChangeConfirmStale(LATER_AT, TEN_MIN)).toBe(false);
	});

	it("reads every accepted form as the same UTC instant, in any zone", () => {
		const forms = ["2026-11-05T04:02:00", "2026-11-05 04:02:00", "2026-11-05T04:02:00.123", "2026-11-05T04:02:00Z"];
		for (const form of forms) {
			expect(isAdminChangeConfirmStale(form, T0)).toBe(isAdminChangeConfirmStale(AT, T0));
			expect(isAdminChangeConfirmStale(form, SIXTY_ONE_S)).toBe(isAdminChangeConfirmStale(AT, SIXTY_ONE_S));
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
