import { isAppSchemaRefusal } from "../app-schema-refusal";

function refusal(): Error {
	const e = new Error("sApp schema cannot be applied to this strand's tables: Failed to execute DDL");
	e.name = "AppSchemaRefusedError";
	return e;
}

describe("isAppSchemaRefusal", () => {
	it("matches the outdated-version refusal (the network records a newer App schema version), also through cause", () => {
		const outdated = new Error("App schema version 1 is below the version 2 this strand records");
		outdated.name = "AppSchemaOutdatedError";
		expect(isAppSchemaRefusal(outdated)).toBe(true);
		expect(isAppSchemaRefusal(new Error("outer", { cause: outdated }))).toBe(true);
	});

	it("matches the refusal itself and through vote-engine's open() wrapper (cause)", () => {
		expect(isAppSchemaRefusal(refusal())).toBe(true);
		const wrapped = new Error("Network not opened in this session — use create() first: x", { cause: refusal() });
		expect(isAppSchemaRefusal(wrapped)).toBe(true);
		expect(isAppSchemaRefusal(new Error("outer", { cause: wrapped }))).toBe(true);
	});

	it("does not match other errors, a message that merely mentions it, or non-errors", () => {
		expect(isAppSchemaRefusal(new Error("disk corrupt"))).toBe(false);
		expect(isAppSchemaRefusal(new Error("AppSchemaRefusedError: text only, no name"))).toBe(false);
		expect(isAppSchemaRefusal(undefined)).toBe(false);
		expect(isAppSchemaRefusal("AppSchemaRefusedError")).toBe(false);
		const lookalike = new Error("x");
		lookalike.name = "ControlStoreIncompatibleError";
		expect(isAppSchemaRefusal(lookalike)).toBe(false);
	});

	it("stops at five causes and on a cycle, and never throws on a hostile getter", () => {
		let deep: Error = refusal();
		for (let i = 0; i < 6; i++) deep = new Error(`w${i}`, { cause: deep });
		expect(isAppSchemaRefusal(deep)).toBe(false);
		const a = new Error("a") as Error & { cause?: unknown };
		const b = new Error("b", { cause: a });
		a.cause = b;
		expect(isAppSchemaRefusal(a)).toBe(false);
		const hostile = Object.defineProperty({}, "name", { get() { throw new Error("boom"); } });
		expect(isAppSchemaRefusal(hostile)).toBe(false);
	});
});
