import { resources } from "../index";

const en = resources.en.translation as Record<string, string>;
const es = resources.es.translation as Record<string, string>;

const KEYS = [
	"dkgOverdueNotice",
	"dkgOverdueHelp",
	"dkgOverdueUnnamed",
	"keyholderStatusAcceptAgain",
	"keyholderReacceptOfficerNote",
	"keyholderReacceptAcceptNote",
	"reassociationReviewAuthorityWide",
	"reassociationReviewNoteCurrent",
	"reassociationReviewNoteWhere",
	"sealedBeforeOfficerExplanation",
];
const PLACEHOLDERS: Record<string, string[]> = {
	dkgOverdueNotice: ["hours", "names"],
	reassociationReviewNoteCurrent: ["value"],
	reassociationReviewNoteWhere: ["screen"],
};
const PINNED_PREFIXES = [
	"peerSyncCard", "registrationBridgeConfig", "networkFounding", "possibleDuplicate", "associationApproval",
	"registrationPolicyReassociation", "signatureTaskThreshold", "keyholderDkg", "keyholderRelease",
	"officerIntakeKey", "registrationContent", "registrantPrivate", "registrantSelective", "registrationPolicy",
	"registrationRequest", "registration", "registrantList", "registrantStatus", "registrantDetail",
	"registrantLifecycle", "registrantAccessTrail", "registrantScope", "associationList", "attestationChallenge",
	"attestationVerdict", "attestationProvisioning", "pollingDevice", "authorityPeer", "dashboardSignInCode",
];
const tokensOf = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();
const PHASE_RE = new RegExp(["\\bD-\\d{2}\\b", "\\b\\d{2}-\\d{2,3}\\b", "\\bphase\\s*\\d+", "\\bfase\\s*\\d+"].join("|"), "i");
const OFFICER_ES_RE = new RegExp("(?<!\\p{L})" + "ofi" + "cial(?:es)?" + "(?!\\p{L})", "iu");
const ACTION_RE = new RegExp(["edit", "change (its|the) keyholders", "edita", "cambiar sus custodios"].join("|"), "i");

describe("product-ruling copy keys", () => {
	it.each(KEYS)("%s exists in en and es, differs, no phase numbers, matching placeholders", (key) => {
		expect(typeof en[key]).toBe("string");
		expect(en[key].length).toBeGreaterThan(0);
		expect(typeof es[key]).toBe("string");
		expect(es[key].length).toBeGreaterThan(0);
		expect(es[key]).not.toBe(en[key]);
		expect(tokensOf(es[key])).toEqual(tokensOf(en[key]));
		expect(tokensOf(en[key])).toEqual((PLACEHOLDERS[key] ?? []).slice().sort());
		expect(en[key]).not.toMatch(PHASE_RE);
		expect(es[key]).not.toMatch(PHASE_RE);
		expect(es[key]).not.toMatch(OFFICER_ES_RE);
		expect(PINNED_PREFIXES.some((p) => key.startsWith(p))).toBe(false);
	});

	it("officer-mentioning es values say funcionario", () => {
		expect(es.keyholderReacceptAcceptNote).toMatch(/funcionario/i);
		expect(es.sealedBeforeOfficerExplanation).toMatch(/funcionario/i);
	});

	it("dkgOverdueHelp names no action the app lacks", () => {
		expect(en.dkgOverdueHelp).toBeTruthy();
		expect(en.dkgOverdueHelp).not.toMatch(ACTION_RE);
		expect(es.dkgOverdueHelp).not.toMatch(ACTION_RE);
	});
});
