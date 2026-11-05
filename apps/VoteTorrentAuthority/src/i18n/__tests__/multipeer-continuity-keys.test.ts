/**
 * multipeer-continuity-keys.test.ts — Phase 62 plan 62-10.
 *
 * The 91-key (12 prefix-group) Authority i18n catalog proof for D-31, D-36, D-41, D-43, D-45,
 * D-46, D-49 and D-51's copy. This is the machine-readable key-set contract later plans (62-12,
 * 62-21..62-23, 62-25..62-29, 62-32) rely on: the GROUPS key lists below ARE the catalog.
 *
 * Renderer-free: imports only the exported `resources` object and `isBareDismissLabel`, the same
 * convention as `dashboard-signin-code-keys.test.ts` and `registrant-keys.test.ts`. Asserts ONLY
 * against the imported `resources`, never by reading a source file, so the test's own comments and
 * regex literals can never satisfy it (project trap: self-tripping checker headers).
 *
 * A duplicate key inside a single object literal is silently collapsed by the JS parser (the later
 * entry wins, with no runtime trace) — this test alone CANNOT detect that failure mode. The
 * companion source-level `sort | uniq -d` grep gate over `i18n/index.ts` (see 62-10-PLAN.md's
 * `<verify>`/acceptance criteria) is required in addition to this test, not instead of it.
 *
 * One `jest.mock` is unavoidable even in this renderer-free suite, mirroring
 * `LifecycleConfirmCard.gate.test.ts`'s own documented workaround: `isBareDismissLabel` lives in
 * the same module as the `LifecycleConfirmCard` component, whose static import graph reaches
 * `react-native-vector-icons/FontAwesome6` (via `CustomTextInput` -> `ChipButton`), a package
 * this workspace's jest config does not transform. This mock unblocks the module graph only; no
 * component render occurs anywhere in this file.
 */

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

import { resources } from "../index";
import { isBareDismissLabel } from "../../screens/registration/components/LifecycleConfirmCard";

const enTranslation = resources.en.translation as Record<string, string>;
const esTranslation = resources.es.translation as Record<string, string>;

type Group = [name: string, re: RegExp, keys: readonly string[]];

const GROUPS: readonly Group[] = [
	[
		"A peerSyncCard*",
		/^peerSyncCard[A-Z]/,
		[
			"peerSyncCardHeading",
			"peerSyncCardCaveat",
			"peerSyncCardPendingLabel",
			"peerSyncCardSyncedLabel",
			"peerSyncCardFailedLabel",
			"peerSyncCardTryButton",
		],
	],
	[
		"B registrationBridgeConfig*",
		/^registrationBridgeConfig[A-Z]/,
		[
			"registrationBridgeConfigHeading",
			"registrationBridgeConfigUrlLabel",
			"registrationBridgeConfigUrlPlaceholder",
			"registrationBridgeConfigSaveButton",
			"registrationBridgeConfigInvalidUrl",
			"registrationBridgeConfigSavedConfirm",
			"registrationBridgeConfigUnsetHint",
			"registrationBridgeConfigSaveError",
			"registrationBridgeConfigCoSignRequired",
		],
	],
	[
		"C networkFounding*",
		/^networkFounding[A-Z]/,
		[
			"networkFoundingExportButton",
			"networkFoundingExportConfirmHeading",
			"networkFoundingExportConfirmBody",
			"networkFoundingExportShareButton",
			"networkFoundingExportError",
			"networkFoundingImportButton",
			"networkFoundingImportScreenTitle",
			"networkFoundingImportChooseFileButton",
			"networkFoundingImportValidating",
			"networkFoundingImportInvalidSignature",
			"networkFoundingImportAlreadyJoined",
			"networkFoundingImportSuccess",
			"networkFoundingImportGenericError",
			"networkFoundingExportCancelButton",
			"networkFoundingExportGenerating",
			"networkFoundingImportViewNetworkButton",
			"networkFoundingImportChooseAnotherFileButton",
			"networkFoundingExportReadyBody",
			"networkFoundingExportSaveButton",
			"networkFoundingExportSaved",
			"networkFoundingExportDoneButton",
			"networkFoundingExportTextFallback",
			// Founding-file fingerprint check and share/save failure copy (ImportFoundingBundleScreen, FoundingBundleExportCard).
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
		],
	],
	[
		"D possibleDuplicate*",
		/^possibleDuplicate[A-Z]/,
		[
			"possibleDuplicateHeading",
			"possibleDuplicateBody",
			"possibleDuplicateViewOtherButton",
			"possibleDuplicateClosedLabel",
			"possibleDuplicateCheckFailed",
		],
	],
	[
		"E associationApproval*",
		/^associationApproval[A-Z]/,
		[
			"associationApprovalScreenTitle",
			"associationApprovalNewDeviceLabel",
			"associationApprovalExistingDeviceLabel",
			"associationApprovalCodeMatchedBadge",
			"associationApprovalIdentityMatchedBanner",
			"associationApprovalApproveButton",
			"associationApprovalApproveConfirmHeading",
			"associationApprovalApproveConfirmBody",
			"associationApprovalRejectButton",
			"associationApprovalApproveConfirmButton",
			"associationApprovalKeepReviewingButton",
			"associationApprovalLoadError",
			"associationApprovalDecisionError",
			"associationApprovalQueueRowTitle",
			"associationApprovalCodeUnmatchedBanner",
			"associationApprovalCodeUnverifiableBanner",
			"associationApprovalNoEvidenceBanner",
			"associationApprovalCandidatesHeading",
			"associationApprovalEnteredFieldsHeading",
			"associationApprovalRegistrantRecordHeading",
			"associationApprovalCoSignRequired",
		],
	],
	[
		"F registrationPolicyReassociation*",
		/^registrationPolicyReassociation[A-Z]/,
		[
			"registrationPolicyReassociationHeading",
			"registrationPolicyReassociationManual",
			"registrationPolicyReassociationAutomatic",
			"registrationPolicyReassociationDefaultNote",
			"registrationPolicyReassociationSaveError",
			"registrationPolicyReassociationCoSignRequired",
			"registrationPolicyReassociationLoadError",
		],
	],
	[
		"G signatureTaskThreshold*",
		/^signatureTaskThreshold[A-Z]/,
		[
			"signatureTaskThresholdProgress",
			"signatureTaskThresholdReached",
			"signatureTaskThresholdVoteRecorded",
			"signatureTaskThresholdUnreachable",
		],
	],
	[
		"H keyholderDkg*",
		/^keyholderDkg[A-Z]/,
		[
			"keyholderDkgStatusPending",
			"keyholderDkgStatusInProgress",
			"keyholderDkgStatusComplete",
			"keyholderDkgStatusComplaint",
			"keyholderDkgStatusHeading",
			// UAT 62 M: a blocked DKG whose policy threshold is below 2 (1-of-1) can never start.
			"keyholderDkgStatusThresholdTooLow",
			// KeyholderScreen row: load failure and driver failure copy.
			"keyholderDkgLoadError",
			"keyholderDkgError",
			// Terminal DKG failed state: cause-agnostic copy.
			"keyholderDkgStatusFailed",
		],
	],
	[
		"I keyholderRelease[A-Z]*",
		/^keyholderRelease[A-Z]/,
		[
			"keyholderReleaseScreenTitle",
			"keyholderReleaseBody",
			"keyholderReleaseButton",
			"keyholderReleaseSuccess",
			"keyholderReleaseError",
			"keyholderReleaseInProgress",
		],
	],
	[
		"J officerIntakeKey*",
		/^officerIntakeKey[A-Z]/,
		[
			"officerIntakeKeyHeading",
			"officerIntakeKeyBody",
			"officerIntakeKeyEnableButton",
			"officerIntakeKeyEnabledConfirm",
			"officerIntakeKeyError",
			// OfficerIntakeKey screen: another officer published the same key.
			"officerIntakeKeyContestedWarning",
			// Another device of the same officer published a newer usable key.
			"officerIntakeKeySupersededBody",
		],
	],
	[
		"K registrationContent*",
		/^registrationContent[A-Z]/,
		[
			"registrationContentNotRecipient",
			"registrationContentNoKey",
			"registrationContentUnreadable",
			"registrationContentTampered",
		],
	],
	[
		"L registrantPrivate*",
		/^registrantPrivate[A-Z]/,
		[
			"registrantPrivateNotRecipient",
			"registrantPrivateUnreadable",
		],
	],
	[
		"M registrantSelective*",
		/^registrantSelective[A-Z]/,
		[
			"registrantSelectiveNotRecipient",
			"registrantSelectiveUnreadable",
			"registrantSelectiveTampered",
		],
	],
];

const ALL_CATALOG_KEYS: readonly string[] = GROUPS.flatMap(([, , keys]) => keys);

const TOKEN_EXPECTATIONS: Readonly<Record<string, readonly string[]>> = {
	peerSyncCardPendingLabel: ["count"],
	peerSyncCardSyncedLabel: ["count"],
	peerSyncCardFailedLabel: ["count"],
	possibleDuplicateBody: ["name"],
	associationApprovalApproveConfirmBody: ["registrantName"],
	associationApprovalQueueRowTitle: ["registrantName"],
	signatureTaskThresholdProgress: ["signed", "threshold"],
};

const ENGINEERING_MARKER_RE = /\bD-\d{2}\b|\b\d{2}-\d{2}\b|\bphase\s*\d+/i;
const QR_SCAN_RE = /\bQR\b|camera|c[aá]mara|\bscan|escane/i;
const PRIVATE_PLACEHOLDER_RE = /\{\{(ssn|dob|dateOfBirth|phone|value|privateValue)\}\}/i;
const NO_BLAME_RE = /tamper|signed|signature|applicant|manipul|firm|solicitante/i;
const RETRY_EN_RE = /try again/i;
const RETRY_ES_RE = /int[eé]ntalo/i;

function tokensOf(value: string): string[] {
	return [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
}

describe("multipeer-continuity-keys (62-10, D-31/D-36/D-41/D-43/D-45/D-46/D-49/D-51)", () => {
	describe.each(GROUPS)("Group %s", (_name, re, keys) => {
		test("EN key set (filtered by prefix) equals the catalog's exact key list", () => {
			const enKeysForGroup = Object.keys(enTranslation).filter((k) => re.test(k));
			expect(new Set(enKeysForGroup)).toEqual(new Set(keys));
			expect(enKeysForGroup).toHaveLength(keys.length);
		});

		test("ES key set equals the EN key set", () => {
			const esKeysForGroup = Object.keys(esTranslation).filter((k) => re.test(k));
			expect(new Set(esKeysForGroup)).toEqual(new Set(keys));
			expect(esKeysForGroup).toHaveLength(keys.length);
		});
	});

	test("the total catalog is 116 keys per locale (94 + keyholderDkgStatusThresholdTooLow, UAT 62, + 5 founding-export file-handoff keys, + 14 invitation/security keys, + keyholderDkgStatusFailed, + officerIntakeKeySupersededBody)", () => {
		expect(ALL_CATALOG_KEYS).toHaveLength(116);
	});

	test.each(ALL_CATALOG_KEYS)("%s: non-empty value in both locales, EN !== ES", (key) => {
		expect(typeof enTranslation[key]).toBe("string");
		expect(typeof esTranslation[key]).toBe("string");
		expect(enTranslation[key].trim().length).toBeGreaterThan(0);
		expect(esTranslation[key].trim().length).toBeGreaterThan(0);
		expect(enTranslation[key]).not.toBe(esTranslation[key]);
	});

	test("no engineering marker regex false-positives or false-negatives (paired control)", () => {
		expect(ENGINEERING_MARKER_RE.test("see D-09 in the 52-11 plan")).toBe(true);
		expect(ENGINEERING_MARKER_RE.test("Copy Code")).toBe(false);
	});

	test.each(ALL_CATALOG_KEYS)("%s: no GSD phase number or decision id in either locale", (key) => {
		expect(enTranslation[key]).not.toMatch(ENGINEERING_MARKER_RE);
		expect(esTranslation[key]).not.toMatch(ENGINEERING_MARKER_RE);
	});

	test("the QR/camera/scan regex false-positives or false-negatives (paired control)", () => {
		expect(QR_SCAN_RE.test("Scan this QR code with your camera")).toBe(true);
		expect(QR_SCAN_RE.test("Try Peer Sync (Unverified)")).toBe(false);
	});

	test.each(ALL_CATALOG_KEYS)("%s: no QR/camera/scan wording in either locale (D-36)", (key) => {
		expect(enTranslation[key]).not.toMatch(QR_SCAN_RE);
		expect(esTranslation[key]).not.toMatch(QR_SCAN_RE);
	});

	test.each(Object.keys(TOKEN_EXPECTATIONS))("%s: interpolation tokens match between EN and ES", (key) => {
		const expectedTokens = [...TOKEN_EXPECTATIONS[key]].sort();
		expect(tokensOf(enTranslation[key])).toEqual(expectedTokens);
		expect(tokensOf(esTranslation[key])).toEqual(expectedTokens);
	});

	test.each(ALL_CATALOG_KEYS)("%s: binds no private-tier placeholder token", (key) => {
		expect(enTranslation[key]).not.toMatch(PRIVATE_PLACEHOLDER_RE);
		expect(esTranslation[key]).not.toMatch(PRIVATE_PLACEHOLDER_RE);
	});

	// D-31: the peer card must never present peer sync as proven.
	test("D-31: peerSyncCardCaveat carries the verbatim caveat phrase, headings say Unverified, nothing says Experimental", () => {
		expect(enTranslation.peerSyncCardCaveat).toContain("peer delivery not yet proven on devices");
		expect(enTranslation.peerSyncCardHeading).toContain("Unverified");
		expect(enTranslation.peerSyncCardTryButton).toContain("Unverified");

		const groupA = GROUPS.find(([name]) => name.startsWith("A"))!;
		for (const key of groupA[2]) {
			expect(enTranslation[key]).not.toMatch(/experimental/i);
			expect(esTranslation[key]).not.toMatch(/experimental/i);
		}
	});

	// D-36: export/import copy speaks only of a file and the share sheet.
	test("D-36: networkFoundingExportConfirmBody mentions a file", () => {
		expect(enTranslation.networkFoundingExportConfirmBody).toContain("file");
	});

	// D-41: the approve-confirm body and retirement framing.
	test("D-41: associationApprovalApproveConfirmBody states the consequence, existingDeviceLabel says retired", () => {
		expect(enTranslation.associationApprovalApproveConfirmBody).toContain("no longer be able to vote");
		expect(enTranslation.associationApprovalApproveConfirmBody).toContain("cannot be undone");
		expect(enTranslation.associationApprovalExistingDeviceLabel).toContain("retired");
	});

	// D-41 timing deviation: never "immediately" — retirement follows the new device's attestation.
	test("D-41 timing: the confirm body never claims immediate retirement, in either locale", () => {
		expect(enTranslation.associationApprovalApproveConfirmBody).toContain(
			"as soon as the new device finishes setting up",
		);
		expect(enTranslation.associationApprovalApproveConfirmBody).not.toMatch(/immediately/i);
		expect(esTranslation.associationApprovalApproveConfirmBody).toContain(
			"en cuanto el nuevo dispositivo termine",
		);
		expect(esTranslation.associationApprovalApproveConfirmBody).not.toMatch(/de inmediato/i);
	});

	// Co-sign honesty: a threshold-above-1 refusal is never retryable.
	test.each([
		"registrationBridgeConfigCoSignRequired",
		"associationApprovalCoSignRequired",
		"registrationPolicyReassociationCoSignRequired",
	])("%s: states more than one officer is needed, offers no retry, in either locale", (key) => {
		expect(enTranslation[key]).toContain("more than one officer");
		expect(esTranslation[key]).toContain("más de un funcionario");
		expect(enTranslation[key]).not.toMatch(RETRY_EN_RE);
		expect(esTranslation[key]).not.toMatch(RETRY_ES_RE);
	});

	// D-45: code vs identity-fallback framing.
	test("D-45: identityMatchedBanner says instead of a code, codeMatchedBadge says registration code", () => {
		expect(enTranslation.associationApprovalIdentityMatchedBanner).toContain("instead of a code");
		expect(enTranslation.associationApprovalCodeMatchedBadge).toContain("registration code");
	});

	// D-46: manual review is the default.
	test("D-46: registrationPolicyReassociationDefaultNote names manual review as the default", () => {
		expect(enTranslation.registrationPolicyReassociationDefaultNote).toContain("Manual review");
		expect(enTranslation.registrationPolicyReassociationDefaultNote).toContain("default");
	});

	// D-49 / D-51: Groups K and L.
	test("D-49/D-51: tampered, not-a-recipient and no-key wording", () => {
		expect(enTranslation.registrationContentTampered).toContain("cannot be approved");
		expect(esTranslation.registrationContentTampered).toContain("No se puede aprobar");
		expect(enTranslation.registrationContentNotRecipient).toContain("Another officer");
		expect(enTranslation.registrationContentNoKey).toContain("encrypted intake");
		expect(enTranslation.registrantPrivateNotRecipient).toContain("before you became an officer");
		expect(enTranslation.registrantSelectiveNotRecipient).toContain("before you became an officer");
	});

	test("selective tampered copy is distinct from the unreadable copy and names the mismatch", () => {
		expect(enTranslation.registrantSelectiveTampered).toContain("do not match");
		expect(esTranslation.registrantSelectiveTampered).toContain("no coinciden");
		expect(enTranslation.registrantSelectiveTampered).not.toBe(enTranslation.registrantSelectiveUnreadable);
		expect(esTranslation.registrantSelectiveTampered).not.toBe(esTranslation.registrantSelectiveUnreadable);
	});

	test.each([
		"registrationContentNotRecipient",
		"registrationContentNoKey",
		"registrationContentUnreadable",
		"registrationContentTampered",
		"registrantPrivateNotRecipient",
		"registrantPrivateUnreadable",
		"registrantSelectiveNotRecipient",
		"registrantSelectiveUnreadable",
		"registrantSelectiveTampered",
	])("%s: no retry offered in either locale (D-49/D-51 — a sealed request cannot become readable by retrying)", (key) => {
		expect(enTranslation[key]).not.toMatch(RETRY_EN_RE);
		expect(esTranslation[key]).not.toMatch(RETRY_ES_RE);
	});

	// D-49/D-51 no-blame: the 'unreadable' state never attributes fault to the applicant.
	test("the no-blame regex false-positives or false-negatives (paired control)", () => {
		expect(NO_BLAME_RE.test("does not match what the applicant signed")).toBe(true);
		expect(NO_BLAME_RE.test("could not be read on this device")).toBe(false);
	});

	test("D-49/D-51 no-blame: registrationContentUnreadable and registrantPrivateUnreadable blame no one", () => {
		expect(enTranslation.registrationContentUnreadable).toContain("could not be read on this device");
		expect(enTranslation.registrantPrivateUnreadable).toContain("could not be read on this device");
		expect(esTranslation.registrationContentUnreadable).toContain("No se pudo leer");
		expect(esTranslation.registrantPrivateUnreadable).toContain("No se pudieron leer");

		expect(enTranslation.registrationContentUnreadable).not.toMatch(NO_BLAME_RE);
		expect(esTranslation.registrationContentUnreadable).not.toMatch(NO_BLAME_RE);
		expect(enTranslation.registrantPrivateUnreadable).not.toMatch(NO_BLAME_RE);
		expect(esTranslation.registrantPrivateUnreadable).not.toMatch(NO_BLAME_RE);

		expect(enTranslation.registrationContentUnreadable).not.toBe(enTranslation.registrationContentTampered);
		expect(esTranslation.registrationContentUnreadable).not.toBe(esTranslation.registrationContentTampered);
	});

	// LifecycleConfirmCard's dismiss-label discipline (D-10) applies to this catalog's two new
	// confirm-card dismiss labels.
	test.each(["associationApprovalKeepReviewingButton", "networkFoundingExportCancelButton"])(
		"%s: not a bare dismiss label, in either locale",
		(key) => {
			expect(isBareDismissLabel(enTranslation[key])).toBe(false);
			expect(isBareDismissLabel(esTranslation[key])).toBe(false);
		},
	);

	// The bare, pre-existing `keyholderRelease` key is NOT part of Group I and must survive
	// byte-identical.
	test("the pre-existing bare keyholderRelease key is untouched", () => {
		expect(enTranslation.keyholderRelease).toBe("Keyholder Release");
		expect(esTranslation.keyholderRelease).toBe("Liberación de Custodio");
	});
});
