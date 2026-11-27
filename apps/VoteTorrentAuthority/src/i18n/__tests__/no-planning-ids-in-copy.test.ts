/**
 * No planning or phase IDs in UI copy: the officer reads every value in this catalog, and a
 * decision tag ("D-12"), a plan id ("08-07") or "phase 8" means nothing to them (2026-11-23 todo:
 * the Onboarding Debug intro said "Temporary dev route per D-12; replaced by real callers in
 * phases 8-10"). Comments in the catalog may carry them; values may not.
 */
import { resources } from "../index";

type Tree = { [k: string]: string | Tree };

function flatten(t: Tree, prefix = "", out: Record<string, string> = {}): Record<string, string> {
	for (const [k, v] of Object.entries(t)) {
		if (typeof v === "string") out[prefix + k] = v;
		else flatten(v, prefix + k + ".", out);
	}
	return out;
}

// A decision tag (D-12, R-G12), a plan or wave id (08-07, 62-27), "phase 8" / "phases 8–10" and
// the Spanish "fase 8" / "fases 8–10".
const PLANNING_ID = [
	/\b[A-Z]{1,2}-\d{1,3}\b/,
	/\b\d{2}-\d{2,3}\b/,
	/\bphases?\s+\d/i,
	/\bfases?\s+\d/i,
];

function offenders(values: Record<string, string>): string[] {
	return Object.entries(values)
		.filter(([, v]) => PLANNING_ID.some((re) => re.test(v)))
		.map(([k, v]) => `${k}: ${v}`);
}

describe("UI copy carries no planning ids", () => {
	it("negative controls: each pattern fires on a planted value", () => {
		expect(offenders({ a: "Temporary dev route per D-12" })).toHaveLength(1);
		expect(offenders({ a: "see 08-07" })).toHaveLength(1);
		expect(offenders({ a: "replaced in phases 8–10" })).toHaveLength(1);
		expect(offenders({ a: "reemplazada en las fases 8–10" })).toHaveLength(1);
		expect(offenders({ a: "Expires in 13:59" })).toHaveLength(0);
	});

	it("en", () => {
		expect(offenders(flatten(resources.en.translation as unknown as Tree))).toEqual([]);
	});

	it("es", () => {
		expect(offenders(flatten(resources.es.translation as unknown as Tree))).toEqual([]);
	});
});
