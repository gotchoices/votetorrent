import { resources } from "../index";

const en = resources.en.translation as Record<string, string>;
const es = resources.es.translation as Record<string, string>;
const KEYS = ["errorLoadFailedGeneric", "errorActionFailedGeneric", "validationRequired", "validationInvalid"];

describe("raw-error sweep copy keys", () => {
	it.each(KEYS)("%s is present, non-empty, translated, and free of internal ids", (key) => {
		expect(typeof en[key]).toBe("string");
		expect(en[key].length).toBeGreaterThan(0);
		expect(typeof es[key]).toBe("string");
		expect(es[key].length).toBeGreaterThan(0);
		expect(es[key]).not.toBe(en[key]);
		for (const v of [en[key], es[key]]) {
			expect(v).not.toMatch(/\b\d{2}-\d{2,3}\b|\bphase\b|\bplan\b|\bD-\d/i);
		}
	});
});
