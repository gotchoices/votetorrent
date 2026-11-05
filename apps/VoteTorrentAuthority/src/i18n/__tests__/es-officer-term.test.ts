import { resources } from "../index";

type Tree = { [k: string]: string | Tree };
const OFFICER_WORD = new RegExp("(?<!\\p{L})" + "ofi" + "cial(?:es)?" + "(?!\\p{L})", "iu");
const EN_ADJECTIVE = new RegExp("\\b" + "offi" + "cial\\b", "i");
const EN_OFFICER = new RegExp("\\b" + "offi" + "cers?\\b", "i");
// Keys where the Spanish word is the adjective, not the officer role.
const ADJECTIVE_SENSE: string[] = ["verificationChecklistItemId"];

function flatten(t: Tree, prefix = "", out: Record<string, string> = {}): Record<string, string> {
	for (const [k, v] of Object.entries(t)) {
		if (typeof v === "string") out[prefix + k] = v;
		else flatten(v, prefix + k + ".", out);
	}
	return out;
}

function offenders(es: Record<string, string>, en: Record<string, string>, allow: string[]): string[] {
	const bad: string[] = [];
	for (const [key, value] of Object.entries(es)) {
		if (!OFFICER_WORD.test(value)) continue;
		const e = en[key] ?? "";
		if (EN_ADJECTIVE.test(e) && !EN_OFFICER.test(e)) continue;
		if (allow.includes(key)) continue;
		bad.push(key + ": " + value);
	}
	return bad;
}

const es = flatten(resources.es.translation as unknown as Tree);
const en = flatten(resources.en.translation as unknown as Tree);

describe("Spanish officer term", () => {
	it("no es value uses the officer-role word outside the adjective sense", () => {
		expect(offenders(es, en, ADJECTIVE_SENSE)).toEqual([]);
	});

	it("the officer labels read funcionario; the adjective is unchanged", () => {
		expect(es.officer).toBe("Funcionario");
		expect(es.addOfficer).toBe("Agregar Funcionario");
		expect(es.initialOfficer).toBe("Funcionario Inicial");
		expect(es.applyRevisionNeedsCoSigners).toContain("más de un funcionario");
		expect(es.official).toBe("Oficial");
		expect(es.officialTitle).toBe("Título oficial");
	});

	it("the allowlist is not stale", () => {
		for (const k of ADJECTIVE_SENSE) {
			expect(es[k]).toBeDefined();
			expect(OFFICER_WORD.test(es[k])).toBe(true);
		}
	});

	it("negative controls", () => {
		const flagged = (esV: string, enV: string) => offenders({ k: esV }, { k: enV }, []).length === 1;
		expect(flagged("Agregar Oficial", "Add officer")).toBe(true);
		expect(flagged("Los oficiales revisan", "Officers review")).toBe(true);
		expect(flagged("Se publicó oficialmente", "Published")).toBe(false);
		expect(flagged("Elección oficial", "Official election")).toBe(false);
		expect(flagged("la oficialía", "the office")).toBe(false);
	});
});
