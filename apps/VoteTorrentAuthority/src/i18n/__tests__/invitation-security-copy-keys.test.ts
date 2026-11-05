/**
 * invitation-security-copy-keys.test.ts
 *
 * Renderer-free key-set proof for the invitation, security-warning, keyholder-invitation and
 * founding-file copy. Asserts only against the imported `resources`.
 */
import { resources } from "../index";

const en = resources.en.translation as Record<string, string>;
const es = resources.es.translation as Record<string, string>;

const KEYS: readonly string[] = [
	"keyholderDkgLoadError",
	"keyholderDkgError",
	"keyholderUnnamed",
	"officerIntakeKeyContestedWarning",
	"pendingInvitationsHeading",
	"pendingInvitationsEmpty",
	"pendingInvitationsLoadError",
	"pendingInvitationsRetry",
	"authorityDetailInviteeLabel",
	"authorityDetailNotAuthorized",
	"authorityDetailMissingInvitation",
	"invitationPastedSummary",
	"invitationPastedClear",
	"invitationRoleAdministrator",
	"invitationRoleAuthority",
	"invitationRoleKeyholder",
	"invitationAcceptSuperseded",
	"networkFoundingExportFingerprintLabel",
	"networkFoundingExportFingerprintHelp",
	"networkFoundingImportFingerprintHeading",
	"networkFoundingImportFingerprintBody",
	"networkFoundingImportFingerprintConfirmed",
	"networkFoundingImportFingerprintInputLabel",
	"networkFoundingImportFingerprintMismatch",
	"networkFoundingImportJoinButton",
	"networkFoundingImportAnchorRequired",
	"networkFoundingExportShareFailed",
	"networkFoundingExportSaveFailed",
	"keyholderAcceptSelfInvite",
	"keyholderAcceptSeatHeld",
	"keyholderInviteExpiryLabel",
	"keyholderInviteExpiryHour",
	"keyholderInviteExpiryHours",
	"keyholderInviteExpiryDays",
	"keyholderInviteExpiresAt",
	"keyholderInviteExpiryOutOfRange",
	"keyholderInviteSendFailed",
	"keyholderPolicyDuplicateName",
	"keyholderInvitePickInvitee",
	"keyholderInviteNoPendingInvitees",
];

const tokensOf = (v: string): string[] => [...v.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();

describe("invitation / security / keyholder-invitation / founding-file copy", () => {
	test("the catalog has 40 distinct keys", () => {
		expect(new Set(KEYS).size).toBe(40);
	});

	test.each(KEYS)("%s: non-empty in en and es, en !== es", (key) => {
		expect(typeof en[key]).toBe("string");
		expect(typeof es[key]).toBe("string");
		expect(en[key].trim().length).toBeGreaterThan(0);
		expect(es[key].trim().length).toBeGreaterThan(0);
		expect(en[key]).not.toBe(es[key]);
	});

	test.each(KEYS)("%s: no run of 2+ digits, no plan marker, no phase word", (key) => {
		for (const v of [en[key], es[key]]) {
			expect(v).not.toMatch(/\d{2,}/);
			expect(v).not.toMatch(/\b\d{2}-\d{2,3}\b/);
			expect(v).not.toMatch(/\b(phase|fase)\b/i);
		}
	});

	test.each(KEYS)("%s: interpolation tokens match between en and es", (key) => {
		expect(tokensOf(es[key])).toEqual(tokensOf(en[key]));
	});

	test("the marker regexes catch what they claim (paired control)", () => {
		expect("see 62-100 in phase 62").toMatch(/\d{2,}/);
		expect("Pending invitations").not.toMatch(/\d{2,}/);
	});
});
