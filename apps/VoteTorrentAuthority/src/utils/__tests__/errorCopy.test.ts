import i18n from "../../i18n";
import { errorCopy, errorToken } from "../errorCopy";

const t = (key: string) => `T:${key}`;
const unavailable = { name: "BlockUnavailableError", reason: "cohort-unreachable" };
const CONSOLE_METHODS = ["log", "warn", "error", "info", "debug"] as const;

function builderError(codes: string[]) {
	return {
		name: "BuilderValidationError",
		errors: codes.map((code, i) => ({
			path: `a.p${i}`,
			code,
			message: `English builder text for ${code}`,
		})),
	};
}

describe("errorCopy", () => {
	let warn: jest.SpyInstance;
	beforeEach(() => {
		warn = jest.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => jest.restoreAllMocks());

	it("E-1: peer-unavailable copy per kind, no log", () => {
		expect(errorCopy(unavailable, t, "read")).toBe("T:peerReadUnavailableBody");
		expect(errorCopy(unavailable, t, "write")).toBe("T:peerWriteUnavailable");
		expect(warn).not.toHaveBeenCalled();
	});

	it("E-2: generic copy, optional screen key, never the message", () => {
		const e = new Error("Engine X requestId=abc cid=bafy1");
		expect(errorCopy(e, t, "read")).toBe("T:errorLoadFailedGeneric");
		expect(errorCopy(e, t, "write")).toBe("T:errorActionFailedGeneric");
		expect(errorCopy(e, t, "write", { fallbackKey: "ballotSubmitFailed" })).toBe("T:ballotSubmitFailed");
		const out = errorCopy(e, t, "read");
		expect(out).not.toMatch(/Engine X|requestId|bafy/);
	});

	it("E-3: builder validation errors map by code", () => {
		expect(errorCopy(builderError(["MISSING", "EMPTY"]), t, "write")).toBe("T:validationRequired");
		expect(errorCopy(builderError(["INVALID_KEY_HEX"]), t, "write")).toBe("T:validationInvalid");
		expect(errorCopy(builderError(["INVALID"]), t, "write")).toBe("T:validationInvalid");
		expect(errorCopy(builderError(["THRESHOLD_EXCEEDS_KEYHOLDERS"]), t, "write")).toBe(
			"T:errThresholdExceedsKeyholders",
		);
		expect(errorCopy(builderError(["TIMELINE_ORDER"]), t, "write")).toBe("T:errTimelineOrder");
		expect(errorCopy(builderError(["NO_RELAYS"]), t, "write")).toBe("T:errRelayRequired");
		expect(errorCopy(builderError(["DUPLICATE"]), t, "write")).toBe("T:validationFailed");
		expect(errorCopy(builderError([]), t, "write")).toBe("T:validationFailed");
		expect(errorCopy(builderError(["MISSING", "DUPLICATE"]), t, "write")).toBe(
			"T:validationRequired\nT:validationFailed",
		);
		expect(errorCopy(builderError(["MISSING"]), t, "write")).not.toMatch(/English builder/);
		expect(warn).not.toHaveBeenCalled();
	});

	it("E-4: logs exactly one line with a code or class name only", () => {
		errorCopy(Object.assign(new Error("secret text"), { code: "authority-not-found" }), t, "write");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenLastCalledWith("[ui-error]", "write", "authority-not-found");
		warn.mockClear();
		errorCopy(new TypeError("secret text"), t, "read");
		expect(warn).toHaveBeenLastCalledWith("[ui-error]", "read", "TypeError");
		warn.mockClear();
		errorCopy({}, t, "read");
		expect(warn).toHaveBeenLastCalledWith("[ui-error]", "read", "object");
		expect(errorToken(Object.create({ code: "x" }))).not.toBe("x");
		expect(errorToken(Object.assign(new TypeError("m"), { code: "has spaces" }))).toBe("TypeError");
		expect(errorToken(Object.assign(new TypeError("m"), { code: "a".repeat(65) }))).toBe("TypeError");
		const logged = JSON.stringify(warn.mock.calls);
		expect(logged).not.toMatch(/secret text/);
	});

	it("E-4b: log:false calls no console method", () => {
		const spies = CONSOLE_METHODS.map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
		const e = new Error("x");
		const quiet = errorCopy(e, t, "read", { log: false });
		errorCopy(unavailable, t, "write", { log: false });
		errorCopy(builderError(["MISSING"]), t, "write", { log: false });
		for (const s of spies) expect(s).not.toHaveBeenCalled();
		spies[1].mockClear();
		expect(errorCopy(e, t, "read")).toBe(quiet);
	});

	it("E-5: odd inputs never throw", () => {
		for (const bad of [undefined, null, "plain string", {}]) {
			expect(errorCopy(bad, t, "read")).toBe("T:errorLoadFailedGeneric");
			expect(errorCopy(bad, t, "write")).toBe("T:errorActionFailedGeneric");
		}
	});

	it("E-6: Spanish catalog", async () => {
		await i18n.changeLanguage("es");
		try {
			const tt = i18n.t.bind(i18n) as (k: string) => string;
			expect(errorCopy(new Error("x"), tt, "read")).toBe("No se pudo cargar. Inténtalo de nuevo.");
			expect(errorCopy(new Error("x"), tt, "write")).toBe("No se pudo completar. Inténtalo de nuevo.");
		} finally {
			await i18n.changeLanguage("en");
		}
	});
});
