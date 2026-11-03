/**
 * dashboard-pairing-keys.test.ts — the browser-pairing copy groups (`dashboardPairing*`,
 * `pairedBrowsers*`, `pairingMintLog*`) in both languages.
 *
 * What it guards:
 *  - parity: every key exists in EN and ES, the two key sets are identical, and each `{{param}}`
 *    placeholder set is the same in both languages and equal to the one the copy table lists;
 *  - exact English: every EN value equals the copy table verbatim (UI-SPEC copy plus the few added
 *    strings for states the spec gives no words for);
 *  - copy bans: no "snapshot", "as of", "refresh", "restore", "phase" or a decision marker in EN;
 *    no erasure promise in EN; no Spanish equivalent of those, and no Spanish erasure verb;
 *  - no engineering marker (a decision id or a plan/phase number) in either language;
 *  - the Spanish officer word is "funcionario" wherever the English names an officer;
 *  - the biometric prompt title stays the app's generic one this release, so no prompt-title key
 *    exists for pairing or removal (no dead copy).
 *
 * Every regex has a positive control built from fragments (so this file never spells a marker it
 * bans, and a future whole-tree scan does not trip on it) and a negative control taken from a real
 * value. Renderer-free: imports only the exported `resources` object.
 *
 * A duplicate key inside one object literal is collapsed silently by the parser (the later entry
 * wins); this test cannot see that, so the source-level duplicate check over `i18n/index.ts` stays
 * a separate gate.
 */

import { resources } from "../index";

const enTranslation = resources.en.translation as Record<string, string>;
const esTranslation = resources.es.translation as Record<string, string>;

const PREFIX_RE = /^(dashboardPairing|pairedBrowsers|pairingMintLog)[A-Z]/;

/** Every new key and its exact English value. */
const EXPECTED_EN: Readonly<Record<string, string>> = Object.freeze({
	dashboardPairingTitle: "Pair a browser",
	dashboardPairingChecking: "Checking whether this phone can pair a browser…",
	dashboardPairingIdleBody: "Pair a computer's browser so it follows this network live. The browser can read what you can see and can't change anything.",
	dashboardPairingRequestButton: "Request pairing code",
	dashboardPairingConfirmHeading: "Request a pairing code?",
	dashboardPairingConfirmBody: "The code lets one browser follow this network as you and read everything you can see. Anyone who has it can use it once until it expires.",
	dashboardPairingWaitingHeading: "Asking the network owner…",
	dashboardPairingWaitingBody: "An owner's Authority app must be open and online to make the code. Keep it open.",
	dashboardPairingCancelButton: "Cancel pairing request",
	dashboardPairingReadyHeading: "Pairing code ready",
	dashboardPairingReadyBody: "Scan this QR code with the browser's camera, or copy the code and paste it there. It works once and expires in {{minutes}} minutes.",
	dashboardPairingCountdown: "Expires in {{remaining}}",
	dashboardPairingQrHint: "Tap the QR code to enlarge it",
	dashboardPairingQrTileLabel: "Pairing QR code, tap to enlarge",
	dashboardPairingShowQrButton: "Show QR code",
	dashboardPairingCopyButton: "Copy code",
	dashboardPairingShareButton: "Share code",
	dashboardPairingFinishButton: "Finish pairing",
	dashboardPairingCopied: "Code copied",
	dashboardPairingCopyFailed: "Couldn't copy the code. Share it instead.",
	dashboardPairingShareFailed: "Couldn't open the share sheet. Copy the code instead.",
	dashboardPairingQrWarning: "Anyone with this code can pair a browser as you until it expires. Show it only to your own computer.",
	dashboardPairingQrTooLarge: "This code is too large to show as a QR code. Copy or share it instead.",
	dashboardPairingQrClose: "Close",
	dashboardPairingQrShareImage: "Share QR image",
	dashboardPairingQrShareFailed: "Couldn't share the image. Copy or share the code instead.",
	dashboardPairingQrRenderFailed: "Couldn't draw the QR code. Copy or share the code instead.",
	dashboardPairingUsed: "This code has been used.",
	dashboardPairingPairAnotherButton: "Pair another browser",
	dashboardPairingExpired: "This code has expired. Request a new one.",
	dashboardPairingOwnerUnreachableHeading: "No owner is reachable.",
	dashboardPairingOwnerUnreachableBody: "Keep the owner's Authority app open on their phone and try again.",
	dashboardPairingRetryButton: "Retry request",
	dashboardPairingSwitchedOff: "The owner has turned browser pairing off. Ask them to turn it on.",
	dashboardPairingNotAllowed: "The owner didn't accept this request. Make sure your officer key is current.",
	dashboardPairingUnavailable: "Pairing isn't available right now.",
	dashboardPairingUnavailableNoNetwork: "Join a network first.",
	dashboardPairingUnavailableNotOfficer: "Only officers can pair a browser.",
	dashboardPairingUnavailableNoKey: "Set up your signing key first.",
	dashboardPairingBuildFailed: "Couldn't make a pairing code. Try again.",
	pairedBrowsersTitle: "Paired browsers",
	pairedBrowsersIntro: "Browsers that follow this network as you. Each can read what you can see; none can change anything.",
	pairedBrowsersDefaultLabel: "Browser paired {{date}}",
	pairedBrowsersPairedAt: "Paired {{date}}",
	pairedBrowsersLastSeenFewMinutes: "Last seen a few minutes ago",
	pairedBrowsersLastSeenMinutes: "Last seen {{n}} min ago",
	pairedBrowsersLastSeenHours: "Last seen {{n}} h ago",
	pairedBrowsersLastSeenDays: "Last seen {{n}} days ago",
	pairedBrowsersNotSeenYet: "Not seen yet",
	pairedBrowsersLastSeenFootnote: "Last seen updates about every 8 minutes.",
	pairedBrowsersStateWaiting: "Waiting to pair",
	pairedBrowsersStatePaired: "Paired",
	pairedBrowsersStateRemovalPending: "Removal pending",
	pairedBrowsersStateRemoved: "Removed",
	pairedBrowsersRemoveButton: "Remove",
	pairedBrowsersRemoveConfirmHeading: "Remove this browser?",
	pairedBrowsersRemoveConfirmBody: "The browser will delete its local copy and go back to the pairing screen. It will also lose its way into the network. Data it has already received can't be taken back, so remove a browser as soon as you stop trusting it.",
	pairedBrowsersRemoveConfirmButton: "Remove browser",
	pairedBrowsersKeepButton: "Keep browser",
	pairedBrowsersRemovalPendingLine: "Removed here. Waiting for an owner to finish removing it from the network. This will retry automatically.",
	pairedBrowsersEmptyHeading: "No paired browsers",
	pairedBrowsersEmptyBody: "Pair a computer to follow this network live.",
	pairedBrowsersPairButton: "Pair a browser",
	pairedBrowsersLocalLabelsNote: "Names and pairing times are kept on this phone only.",
	pairedBrowsersLoadError: "Couldn't load paired browsers. Pull to retry.",
	pairedBrowsersRemoveFailed: "Couldn't remove this browser. Try again.",
	pairedBrowsersRemoveKeyNotCurrent: "Your signing key isn't current. Set it up again, then try removing this browser.",
	pairingMintLogSectionTitle: "Browser pairing",
	pairingMintLogSwitchLabel: "Allow officers to pair browsers",
	pairingMintLogSwitchHelpOn: "When an officer asks to pair a browser, this phone approves it automatically if their key checks out. Keep this app open for it to work.",
	pairingMintLogSwitchHelpOff: "Officers can't pair browsers until you turn this back on. Browsers already paired keep working.",
	pairingMintLogSwitchSaveFailed: "Couldn't save this setting. Try again.",
	pairingMintLogTitle: "Pairing requests",
	pairingMintLogRow: "{{officerName}} · {{date}}",
	pairingMintLogUnknownOfficer: "Unknown officer",
	pairingMintLogOutcomeApproved: "Approved",
	pairingMintLogOutcomeKeyNotValid: "Refused: key not valid",
	pairingMintLogOutcomeSwitchOff: "Refused: switch off",
	pairingMintLogOutcomeNotOfficer: "Refused: not an officer",
	pairingMintLogOutcomeRefused: "Refused",
	pairingMintLogOutcomeUnreachable: "Unreachable",
	pairingMintLogEmpty: "No pairing requests yet.",
	pairingMintLogFootnote: "Showing the last {{n}} requests on this phone.",
	pairingMintLogUnreadable: "Couldn't read the pairing requests on this phone.",
});

/** The placeholders each key carries (keys not listed carry none). */
const PLACEHOLDERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	dashboardPairingReadyBody: ["minutes"],
	dashboardPairingCountdown: ["remaining"],
	pairedBrowsersDefaultLabel: ["date"],
	pairedBrowsersPairedAt: ["date"],
	pairedBrowsersLastSeenMinutes: ["n"],
	pairedBrowsersLastSeenHours: ["n"],
	pairedBrowsersLastSeenDays: ["n"],
	pairingMintLogFootnote: ["n"],
	pairingMintLogRow: ["date", "officerName"],
});

const EXPECTED_COUNT = 84;

function groupKeys(table: Record<string, string>): string[] {
	return Object.keys(table)
		.filter((key) => PREFIX_RE.test(key))
		.sort();
}

/** The sorted multiset of `{{name}}` tokens in a value. */
function tokens(value: string): string[] {
	return [...value.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();
}

// Fragment-built so this file never spells what it bans.
const D_DASH = "D" + "-";
const EN_BANNED_WORDS = /snapshot|\bas of\b|refresh|restore|\bphase\b/i;
const DECISION_RE = /\bD-\d/;
const EN_ERASURE = /\berase|permanently deleted from the network|no longer has access to the data/i;
const ES_BANNED = /instant[aá]nea|restaur|borr|elimin|\bfase\b/i;
const ENGINEERING_MARKER_RE = /\bD-\d{2}\b|\b\d{2}-\d{2,3}\b/;
const OFFICER_EN = /\bofficers?\b/i;
const OFFICER_ES = /funcionari/i;

const enKeys = groupKeys(enTranslation);
const esKeys = groupKeys(esTranslation);

describe("browser-pairing copy keys: parity", () => {
	it("the EN and ES key sets are identical and equal the copy table", () => {
		const expected = Object.keys(EXPECTED_EN).sort();
		expect(expected).toHaveLength(EXPECTED_COUNT);
		expect(enKeys).toEqual(expected);
		expect(esKeys).toEqual(expected);
	});

	it("every EN value is the copy table's exact string", () => {
		const mismatched = Object.keys(EXPECTED_EN).filter((k) => enTranslation[k] !== EXPECTED_EN[k]);
		expect(mismatched).toEqual([]);
	});

	it("every ES value is a non-empty translation that differs from the English", () => {
		const bad = enKeys.filter((k) => {
			const v = esTranslation[k];
			return typeof v !== "string" || v.trim().length === 0 || v === enTranslation[k];
		});
		expect(bad).toEqual([]);
	});

	it("each key's placeholders are identical in EN and ES and equal the table's set", () => {
		const bad = enKeys.filter((k) => {
			const expected = [...(PLACEHOLDERS[k] ?? [])].sort();
			const en = tokens(enTranslation[k]);
			const es = tokens(esTranslation[k]);
			return JSON.stringify(en) !== JSON.stringify(es) || JSON.stringify(en) !== JSON.stringify(expected);
		});
		expect(bad).toEqual([]);
		// The table's placeholder keys all exist.
		for (const k of Object.keys(PLACEHOLDERS)) expect(enKeys).toContain(k);
	});

	it("the placeholder check catches a renamed placeholder (control)", () => {
		expect(tokens("expires in {{minutes}} minutes")).toEqual(["minutes"]);
		expect(JSON.stringify(tokens("vence en {{min}} minutos"))).not.toBe(JSON.stringify(tokens("expires in {{minutes}} minutes")));
	});
});

describe("browser-pairing copy keys: copy bans", () => {
	it("controls: each ban regex matches a fragment-built sample and passes a real value", () => {
		expect(EN_BANNED_WORDS.test("Re" + "fresh the snap" + "shot")).toBe(true);
		expect(EN_BANNED_WORDS.test("as " + "of 10:00")).toBe(true);
		expect(EN_BANNED_WORDS.test(EXPECTED_EN.dashboardPairingReadyBody)).toBe(false);

		expect(DECISION_RE.test(D_DASH + "23")).toBe(true);
		expect(DECISION_RE.test(EXPECTED_EN.dashboardPairingQrWarning)).toBe(false);

		expect(EN_ERASURE.test("we will er" + "ase it")).toBe(true);
		expect(EN_ERASURE.test(EXPECTED_EN.pairedBrowsersRemoveConfirmBody)).toBe(false);

		expect(ES_BANNED.test("bo" + "rrar los datos")).toBe(true);
		expect(ES_BANNED.test("eli" + "minar")).toBe(true);
		expect(ES_BANNED.test("instant" + "ánea")).toBe(true);
		expect(ES_BANNED.test(esTranslation.pairedBrowsersRemoveConfirmBody)).toBe(false);

		expect(ENGINEERING_MARKER_RE.test("see " + D_DASH + "09")).toBe(true);
		expect(ENGINEERING_MARKER_RE.test("plan " + "52" + "-" + "11")).toBe(true);
		expect(ENGINEERING_MARKER_RE.test("plan " + "66" + "-" + "101")).toBe(true);
		expect(ENGINEERING_MARKER_RE.test(EXPECTED_EN.pairedBrowsersLastSeenFootnote)).toBe(false);
	});

	it("no EN value carries a banned word, a decision marker or an erasure promise", () => {
		const bad = enKeys.filter(
			(k) => EN_BANNED_WORDS.test(enTranslation[k]) || DECISION_RE.test(enTranslation[k]) || EN_ERASURE.test(enTranslation[k]),
		);
		expect(bad).toEqual([]);
	});

	it("no ES value carries a banned word, an erasure verb or a decision marker", () => {
		const bad = esKeys.filter((k) => ES_BANNED.test(esTranslation[k]) || DECISION_RE.test(esTranslation[k]));
		expect(bad).toEqual([]);
	});

	it("no value in either language carries an engineering marker", () => {
		const bad = enKeys.filter((k) => ENGINEERING_MARKER_RE.test(enTranslation[k]) || ENGINEERING_MARKER_RE.test(esTranslation[k]));
		expect(bad).toEqual([]);
	});

	it("the Spanish officer word is funcionario wherever the English names an officer", () => {
		const officerKeys = enKeys.filter((k) => OFFICER_EN.test(enTranslation[k]));
		expect(officerKeys.length).toBeGreaterThanOrEqual(5);
		const bad = officerKeys.filter((k) => !OFFICER_ES.test(esTranslation[k]));
		expect(bad).toEqual([]);
		// Controls.
		expect(OFFICER_EN.test("Only officers can pair")).toBe(true);
		expect(OFFICER_ES.test("Agregar Ofi" + "cial")).toBe(false);
	});

	it("no prompt-title key exists: the biometric prompt keeps the app's generic title", () => {
		for (const key of ["dashboardPairingSigningPrompt", "pairedBrowsersRemovePrompt"]) {
			expect(Object.prototype.hasOwnProperty.call(enTranslation, key)).toBe(false);
			expect(Object.prototype.hasOwnProperty.call(esTranslation, key)).toBe(false);
		}
	});
});

/** The four upload-refusal keys that stay until the upload service that returns them is removed. */
const KEPT_UPLOAD_KEYS = [
	"dashboardSignInCodeUploadFailed",
	"dashboardSignInCodeUploadRefused",
	"dashboardSignInCodeUploadTooLarge",
	"dashboardSignInCodeUploadNotConfigured",
] as const;

describe("the kept upload-refusal keys", () => {
	// The sign-in code screen and its screen-only keys are gone. These four stay only because the
	// upload service still returns them; they go together with that service when it is removed.
	it("they are the ONLY remaining sign-in-code-prefixed keys, in both languages", () => {
		const prefix = /^dashboardSignInCode[A-Z]/;
		const expected = [...KEPT_UPLOAD_KEYS].sort();
		expect(Object.keys(enTranslation).filter((k) => prefix.test(k)).sort()).toEqual(expected);
		expect(Object.keys(esTranslation).filter((k) => prefix.test(k)).sort()).toEqual(expected);
	});

	it.each(KEPT_UPLOAD_KEYS)("%s is present in both languages, translated", (key) => {
		expect(typeof enTranslation[key]).toBe("string");
		expect(enTranslation[key].trim().length).toBeGreaterThan(0);
		expect(typeof esTranslation[key]).toBe("string");
		expect(esTranslation[key].trim().length).toBeGreaterThan(0);
		expect(esTranslation[key]).not.toBe(enTranslation[key]);
		expect(enTranslation[key]).not.toMatch(ENGINEERING_MARKER_RE);
		expect(esTranslation[key]).not.toMatch(ENGINEERING_MARKER_RE);
	});

	it("every upload refusal states plainly that no code was created", () => {
		for (const key of KEPT_UPLOAD_KEYS) {
			expect(enTranslation[key]).toMatch(/no (new )?code was created/);
			expect(esTranslation[key]).toMatch(/no se creó ningún código/);
		}
	});
});
