/**
 * admin-change-keys.test.ts — the administration-change copy group (`adminChange*`) in both languages.
 *
 * What it guards:
 *  - parity: every key exists in EN and ES, the two key sets are identical, and each `{{param}}`
 *    placeholder set is the same in both languages and equal to the one the copy table lists;
 *  - exact copy: every EN and every ES value equals the copy table verbatim;
 *  - copy bans: none of the words the EN_BANNED_WORDS regex lists, and no decision marker, in EN;
 *    no Spanish equivalent of those; no engineering marker (a decision id, a plan number or a
 *    roadmap number) in either language; no engine vocabulary or scope code in either language;
 *  - the Spanish officer word is "funcionario" wherever the English names the administrator role,
 *    and the officer-role word the app retired never appears.
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

const PREFIX_RE = /^adminChange[A-Z]/;

/** Every key and its exact English value. */
const EXPECTED_EN: Readonly<Record<string, string>> = Object.freeze({
	adminChangeTakesEffectAt: "Takes effect at {{time}}",
	adminChangeConfirm: "Takes effect at {{time}}. Confirm to sign this change.",
	adminChangeConfirmButton: "Confirm and sign",
	adminChangeConfirmBack: "Go back",
	adminChangePending: "Change pending",
	adminChangeCancel: "Cancel change",
	adminChangeCancelled: "Change cancelled",
	adminChangePendingRefusal: "Another change is still waiting to take effect. Cancel it or wait until it does.",
	adminChangeNoRadRefusal:
		"This change would leave nobody able to revise the administration. Keep at least one administrator with that permission.",
	adminChangeNotApplied: "The change was saved but could not be applied.",
	adminChangeInviteNotAccepted: "This person has not accepted the invitation yet.",
	adminChangeChooseInvitee: "Choose who accepted your invitation",
	adminChangeNoAcceptedInvitees: "Nobody has accepted an administrator invitation yet.",
	adminChangeCancelNotAuthorized: "Only an administrator who can revise the administration can cancel this change.",
	adminChangeCancelNotPending: "This change has already taken effect or was cancelled.",
	adminChangeCancelRefused: "The change could not be cancelled.",
	adminChangeAcceptNeedsSigningKey: "Set up secure signing on this phone before accepting.",
	adminChangeConfirmTimeUpdated: "This took too long, so the time was updated. Check it and confirm again.",
});

/** Every key and its exact Spanish value (informal register, "funcionario" for the role). */
const EXPECTED_ES: Readonly<Record<string, string>> = Object.freeze({
	adminChangeTakesEffectAt: "Entra en vigor a las {{time}}",
	adminChangeConfirm: "Entra en vigor a las {{time}}. Confirma para firmar este cambio.",
	adminChangeConfirmButton: "Confirmar y firmar",
	adminChangeConfirmBack: "Volver",
	adminChangePending: "Cambio pendiente",
	adminChangeCancel: "Cancelar cambio",
	adminChangeCancelled: "Cambio cancelado",
	adminChangePendingRefusal: "Hay otro cambio esperando a entrar en vigor. Cancélalo o espera a que entre en vigor.",
	adminChangeNoRadRefusal:
		"Con este cambio nadie podría revisar la administración. Mantén al menos un funcionario con ese permiso.",
	adminChangeNotApplied: "El cambio se guardó, pero no se pudo aplicar.",
	adminChangeInviteNotAccepted: "Esta persona aún no ha aceptado la invitación.",
	adminChangeChooseInvitee: "Elige a quien aceptó tu invitación",
	adminChangeNoAcceptedInvitees: "Nadie ha aceptado todavía una invitación de administrador.",
	adminChangeCancelNotAuthorized: "Solo un funcionario que puede revisar la administración puede cancelar este cambio.",
	adminChangeCancelNotPending: "Este cambio ya entró en vigor o fue cancelado.",
	adminChangeCancelRefused: "No se pudo cancelar el cambio.",
	adminChangeAcceptNeedsSigningKey: "Configura la firma segura en este teléfono antes de aceptar.",
	adminChangeConfirmTimeUpdated: "Pasó demasiado tiempo, así que se actualizó la hora. Revísala y confirma de nuevo.",
});

/** The placeholders each key carries (keys not listed carry none). */
const PLACEHOLDERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	adminChangeTakesEffectAt: ["time"],
	adminChangeConfirm: ["time"],
});

const EXPECTED_COUNT = 18;

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
const ES_BANNED = /instant[aá]nea|restaur|\bfase\b/i;
const ENGINEERING_MARKER_RE = /\bD-\d{2}\b|\b\d{2}-\d{2,3}\b/;
const PHASE_NUMBER_RE = new RegExp("\\b\\d{2}" + "\\." + "\\d\\b");
const ENGINE_VOCAB_RE = new RegExp("\\b(" + ["Quer" + "eus", "S" + "QL", "CH" + "ECK", "r" + "ad"].join("|") + ")\\b");
const OFFICER_ROLE_ES = new RegExp("ofi" + "cial", "i");
const ADMIN_EN = /\badministrators?\b/i;
const FUNCIONARIO_ES = /funcionari/i;

const enKeys = groupKeys(enTranslation);
const esKeys = groupKeys(esTranslation);

function hasMarker(value: string): boolean {
	return ENGINEERING_MARKER_RE.test(value) || PHASE_NUMBER_RE.test(value);
}

describe("admin-change copy keys: parity", () => {
	it("the EN and ES key sets are identical and equal the copy table", () => {
		const expected = Object.keys(EXPECTED_EN).sort();
		expect(expected).toHaveLength(EXPECTED_COUNT);
		expect(Object.keys(EXPECTED_ES).sort()).toEqual(expected);
		expect(enKeys).toEqual(expected);
		expect(esKeys).toEqual(expected);
		expect(enKeys).toHaveLength(EXPECTED_COUNT);
		expect(esKeys).toHaveLength(EXPECTED_COUNT);
	});

	it("every EN value is the copy table's exact string", () => {
		const mismatched = Object.keys(EXPECTED_EN).filter((k) => enTranslation[k] !== EXPECTED_EN[k]);
		expect(mismatched).toEqual([]);
	});

	it("every ES value is the copy table's exact string", () => {
		const mismatched = Object.keys(EXPECTED_ES).filter((k) => esTranslation[k] !== EXPECTED_ES[k]);
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
		expect(tokens("Takes effect at {{time}}")).toEqual(["time"]);
		expect(JSON.stringify(tokens("Entra en vigor a las {{hora}}"))).not.toBe(JSON.stringify(tokens("Takes effect at {{time}}")));
	});
});

describe("admin-change copy keys: copy bans", () => {
	it("controls: each ban regex matches a fragment-built sample and passes a real value", () => {
		expect(EN_BANNED_WORDS.test("Re" + "fresh the screen")).toBe(true);
		expect(EN_BANNED_WORDS.test("snap" + "shot")).toBe(true);
		expect(EN_BANNED_WORDS.test("as " + "of 10:00")).toBe(true);
		expect(EN_BANNED_WORDS.test("next " + "pha" + "se")).toBe(true);
		expect(EN_BANNED_WORDS.test(EXPECTED_EN.adminChangeConfirmTimeUpdated)).toBe(false);

		expect(DECISION_RE.test(D_DASH + "07")).toBe(true);
		expect(DECISION_RE.test(EXPECTED_EN.adminChangeNoRadRefusal)).toBe(false);

		expect(ES_BANNED.test("fa" + "se 3")).toBe(true);
		expect(ES_BANNED.test("instant" + "ánea")).toBe(true);
		expect(ES_BANNED.test("restau" + "rar")).toBe(true);
		expect(ES_BANNED.test(EXPECTED_ES.adminChangeConfirmTimeUpdated)).toBe(false);

		expect(ENGINEERING_MARKER_RE.test("see " + D_DASH + "08")).toBe(true);
		expect(ENGINEERING_MARKER_RE.test("plan " + "66" + "-" + "03")).toBe(true);
		expect(ENGINEERING_MARKER_RE.test(EXPECTED_EN.adminChangePendingRefusal)).toBe(false);

		expect(PHASE_NUMBER_RE.test("plan " + "66" + "." + "1")).toBe(true);
		expect(PHASE_NUMBER_RE.test(EXPECTED_EN.adminChangeConfirm)).toBe(false);
		expect(PHASE_NUMBER_RE.test(EXPECTED_ES.adminChangeConfirm)).toBe(false);
	});

	it("no EN value carries a banned word, a decision marker or an engineering marker", () => {
		const bad = enKeys.filter(
			(k) => EN_BANNED_WORDS.test(enTranslation[k]) || DECISION_RE.test(enTranslation[k]) || hasMarker(enTranslation[k]),
		);
		expect(bad).toEqual([]);
	});

	it("no ES value carries a banned word, a decision marker or an engineering marker", () => {
		const bad = esKeys.filter(
			(k) => ES_BANNED.test(esTranslation[k]) || DECISION_RE.test(esTranslation[k]) || hasMarker(esTranslation[k]),
		);
		expect(bad).toEqual([]);
	});

	it("no value in either language shows engine vocabulary or the scope code", () => {
		// Positive controls (fragment-built), including the upper-case check-constraint form.
		expect(ENGINE_VOCAB_RE.test("a " + "CH" + "ECK failed")).toBe(true);
		expect(ENGINE_VOCAB_RE.test("Quer" + "eus error")).toBe(true);
		expect(ENGINE_VOCAB_RE.test("S" + "QL text")).toBe(true);
		expect(ENGINE_VOCAB_RE.test("needs " + "r" + "ad scope")).toBe(true);
		// Case-sensitive on purpose: "Check it and confirm again." is plain copy.
		expect(ENGINE_VOCAB_RE.test(EXPECTED_EN.adminChangeConfirmTimeUpdated)).toBe(false);

		const bad = enKeys.filter((k) => ENGINE_VOCAB_RE.test(enTranslation[k]) || ENGINE_VOCAB_RE.test(esTranslation[k]));
		expect(bad).toEqual([]);
	});
});

describe("admin-change copy keys: officer term", () => {
	const ROLE_KEYS = ["adminChangeNoRadRefusal", "adminChangeCancelNotAuthorized"];

	it("the role keys name the administrator in EN and say funcionario in ES", () => {
		for (const k of ROLE_KEYS) {
			expect(ADMIN_EN.test(enTranslation[k])).toBe(true);
			expect(FUNCIONARIO_ES.test(esTranslation[k])).toBe(true);
		}
	});

	it("no ES value uses the retired officer-role word", () => {
		const bad = esKeys.filter((k) => OFFICER_ROLE_ES.test(esTranslation[k]));
		expect(bad).toEqual([]);
	});

	it("control: the officer-role check catches the retired word and passes a real value", () => {
		expect(OFFICER_ROLE_ES.test("Agregar Ofi" + "cial")).toBe(true);
		expect(OFFICER_ROLE_ES.test(EXPECTED_ES.adminChangeNoRadRefusal)).toBe(false);
	});
});
