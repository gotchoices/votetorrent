/**
 * round2-intake-dkg-copy-keys.test.ts: the Authority copy for the terminal DKG failed state and the
 * encrypted-intake superseded / renewal-failed messages (en + es). Renderer-free.
 */
import { resources } from "../index";

const en = resources.en.translation as Record<string, string>;
const es = resources.es.translation as Record<string, string>;

const KEYS = [
	"keyholderDkgStatusFailed",
	"officerIntakeKeySupersededBody",
	"officerIntakeRenewalFailedBody",
];

const ENGINEERING_MARKER_RE = /\b(D-\d+|62-\d+|phase \d+|fase \d+)\b/i;

describe("round2 intake / DKG copy keys", () => {
	test.each(KEYS)("%s: present, non-empty, es differs from en, no internal ids", (key) => {
		expect(en[key]?.trim().length).toBeGreaterThan(0);
		expect(es[key]?.trim().length).toBeGreaterThan(0);
		expect(es[key]).not.toBe(en[key]);
		expect(ENGINEERING_MARKER_RE.test(en[key])).toBe(false);
		expect(ENGINEERING_MARKER_RE.test(es[key])).toBe(false);
	});

	test("intake copy uses the catalog's name for the feature in es", () => {
		for (const key of ["officerIntakeKeySupersededBody", "officerIntakeRenewalFailedBody"]) {
			expect(es[key]).toContain("recepción cifrada");
			expect(es[key]).not.toContain("ingreso cifrado");
		}
	});

	test("the failed copy is cause-agnostic (names no failure, loss or restart)", () => {
		expect(/fail|restart|again|lost/i.test(en.keyholderDkgStatusFailed)).toBe(false);
		expect(/fall|reinici|de nuevo|perd/i.test(es.keyholderDkgStatusFailed)).toBe(false);
		expect(es.keyholderDkgStatusFailed).toContain("funcionario");
	});

	test("no new es value says oficial/oficiales", () => {
		for (const key of KEYS) expect(/\boficial(es)?\b/i.test(es[key])).toBe(false);
	});

	test("renewal-failed copy names the real Bulk Import / Sync screen titles", () => {
		expect(en.officerIntakeRenewalFailedBody).toContain(en.bulkImportSyncScreenTitle);
		expect(es.officerIntakeRenewalFailedBody).toContain(es.bulkImportSyncScreenTitle);
	});
});
