/**
 * Election Details' keyholder policy value ("2 of 3") comes from the catalogs, in English and Spanish, not from
 * an English string built in code (todo 2026-11-23-authority-hardcoded-english-threshold-loading).
 */
import fs from "fs";
import path from "path";
import { resources } from "../../../i18n";

const en = resources.en.translation as Record<string, string>;
const es = resources.es.translation as Record<string, string>;

describe("keyholder policy value copy", () => {
	it("has English and Spanish copy with both placeholders", () => {
		expect(en.keyholderPolicyValue).toBe("{{threshold}} of {{count}}");
		expect(es.keyholderPolicyValue).toBe("{{threshold}} de {{count}}");
	});

	it("ElectionDetailsScreen builds no '<n> of <n>' string in code", () => {
		const src = fs.readFileSync(path.resolve(__dirname, "../ElectionDetailsScreen.tsx"), "utf8");
		expect(src).not.toMatch(/\}\s+of\s+\{/);
		expect(src.match(/t\("keyholderPolicyValue"/g)).toHaveLength(2);
	});

	it("CreateElectionScreen has no literal Loading... fallback", () => {
		const src = fs.readFileSync(path.resolve(__dirname, "../CreateElectionScreen.tsx"), "utf8");
		expect(src).not.toContain('"Loading..."');
	});
});
