/**
 * invite-leave-guard-copy-keys.test.ts
 *
 * Renderer-free key-set proof for the "leave without sharing" confirm copy.
 */
import { resources } from "../index";

const en = resources.en.translation as Record<string, string>;
const es = resources.es.translation as Record<string, string>;

const KEYS = [
	"inviteLeaveUnsharedTitle",
	"inviteLeaveUnsharedMessage",
	"inviteLeaveUnsharedStay",
	"inviteLeaveUnsharedLeave",
] as const;

describe("invite leave-guard copy", () => {
	it.each(KEYS)("%s exists as a non-empty string in en and es", (key) => {
		expect(typeof en[key]).toBe("string");
		expect(en[key].length).toBeGreaterThan(0);
		expect(typeof es[key]).toBe("string");
		expect(es[key].length).toBeGreaterThan(0);
	});

	it.each(["inviteLeaveUnsharedTitle", "inviteLeaveUnsharedMessage", "inviteLeaveUnsharedLeave"] as const)(
		"%s differs between es and en",
		(key) => {
			expect(es[key]).not.toBe(en[key]);
		},
	);

	it.each(KEYS)("%s carries no phase numbers or digits", (key) => {
		expect(en[key]).not.toMatch(/\bphase\b|fase|\d/i);
		expect(es[key]).not.toMatch(/\bphase\b|fase|\d/i);
	});
});
