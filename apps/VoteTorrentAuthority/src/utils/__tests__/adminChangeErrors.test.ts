/**
 * adminChangeErrors: a coded administration-change refusal maps to copy by its code alone, and the
 * promotion probe reports only a refused outcome. The error's message is never read.
 */

import { readFileSync } from "fs";
import { join } from "path";

import { ADMIN_CHANGE_ERROR_CODES } from "@votetorrent/vote-core";

import { resources } from "../../i18n";
import { adminChangeErrorKey, promotionWasRefused } from "../adminChangeErrors";

const en = resources.en.translation as Record<string, string>;
const es = resources.es.translation as Record<string, string>;

const coded = (code: unknown) => Object.assign(new Error("x"), { code });

const EXPECTED: ReadonlyArray<[string, string]> = [
	["admin-change-pending", "adminChangePendingRefusal"],
	["admin-no-rad-holder", "adminChangeNoRadRefusal"],
	["admin-invitee-not-accepted", "adminChangeInviteNotAccepted"],
	["admin-cancel-not-authorized", "adminChangeCancelNotAuthorized"],
	["admin-cancel-not-pending", "adminChangeCancelNotPending"],
	["admin-cancel-refused", "adminChangeCancelRefused"],
	["officer-provisioning-required", "adminChangeAcceptNeedsSigningKey"],
];

describe("adminChangeErrorKey", () => {
	it("maps each of the seven codes to its copy key", () => {
		for (const [code, key] of EXPECTED) {
			expect(adminChangeErrorKey(coded(code))).toBe(key);
		}
	});

	it("maps every shared administration-change code (a new code without a mapping fails here)", () => {
		const unmapped = Object.values(ADMIN_CHANGE_ERROR_CODES).filter((code) => adminChangeErrorKey(coded(code)) === undefined);
		expect(unmapped).toEqual([]);
		expect(Object.values(ADMIN_CHANGE_ERROR_CODES)).toHaveLength(6);
	});

	it("every key it can return exists in English and Spanish", () => {
		for (const [code] of EXPECTED) {
			const key = adminChangeErrorKey(coded(code)) as string;
			expect(typeof en[key]).toBe("string");
			expect(en[key].trim().length).toBeGreaterThan(0);
			expect(typeof es[key]).toBe("string");
			expect(es[key].trim().length).toBeGreaterThan(0);
		}
	});

	it("never reads the message", () => {
		expect(adminChangeErrorKey(new Error("admin-change-pending"))).toBeUndefined();
		expect(adminChangeErrorKey({ message: "admin-no-rad-holder" })).toBeUndefined();
	});

	it("gives undefined for unknown codes, non-string codes, non-objects and prototype names", () => {
		const inputs: unknown[] = [
			coded("admin-something-else"),
			coded(42),
			null,
			undefined,
			"admin-change-pending",
			coded("constructor"),
			coded("toString"),
			coded("__proto__"),
		];
		for (const input of inputs) {
			expect(adminChangeErrorKey(input)).toBeUndefined();
		}
	});
});

describe("promotionWasRefused", () => {
	it("is true for a refused outcome", () => {
		expect(
			promotionWasRefused({ lastPromotionOutcome: { status: "refused", nonce: "n", reason: "unresolvable-officer" } }),
		).toBe(true);
	});

	it("is false for every other status, a missing or null outcome, and non-objects", () => {
		for (const status of ["promoted", "skipped-non-callback-signature", "awaiting-co-signers"]) {
			expect(promotionWasRefused({ lastPromotionOutcome: { status } })).toBe(false);
		}
		expect(promotionWasRefused({})).toBe(false);
		expect(promotionWasRefused({ lastPromotionOutcome: null })).toBe(false);
		expect(promotionWasRefused(null)).toBe(false);
		expect(promotionWasRefused(undefined)).toBe(false);
		expect(promotionWasRefused("refused")).toBe(false);
	});
});

describe("adminChangeErrors source", () => {
	const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
	const DELAY = "ADMIN_CHANGE_" + "DELAY_MS";
	const HELPER = "adminChange" + "EffectiveAt";
	const MESSAGE_READ = /\.message\b/;
	const offending = (src: string): boolean => {
		const code = stripComments(src);
		return MESSAGE_READ.test(code) || code.includes(DELAY) || code.includes(HELPER);
	};

	it("reads no message and names neither the delay nor the effective-time helper", () => {
		const src = readFileSync(join(__dirname, "..", "adminChangeErrors.ts"), "utf8");
		expect(offending(src)).toBe(false);
	});

	it("control: a planted message read is caught", () => {
		const planted = "const text = (err as Error)" + ".mes" + "sage;";
		expect(offending(planted)).toBe(true);
		expect(offending("// " + ".mes" + "sage in a comment only")).toBe(false);
	});
});
