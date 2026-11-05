import { peerUnavailableMessage } from "../peerUnavailableMessage";

const t = (key: string) => `T:${key}`;
const TEST19 = "Block abc123 is unavailable (cohort-unreachable)";
const unavailable = { name: "BlockUnavailableError", reason: "cohort-unreachable" };

describe("peerUnavailableMessage", () => {
	const cases: [string, unknown][] = [
		["QuereusError message", Object.assign(new Error(TEST19), { name: "QuereusError" })],
		["BlockUnavailableError object", unavailable],
		["Error with unavailable cause", new Error("wrapped", { cause: unavailable })],
		["BlockPossiblyStaleError", { name: "BlockPossiblyStaleError", message: "x" }],
		["message-only object", { message: TEST19 }],
	];

	it.each(cases)("read: %s", (_n, err) => {
		expect(peerUnavailableMessage(err, t, "read")).toBe("T:peerReadUnavailableBody");
	});
	it.each(cases)("write: %s", (_n, err) => {
		expect(peerUnavailableMessage(err, t, "write")).toBe("T:peerWriteUnavailable");
	});
	it.each([
		["plain Error", new Error("disk corrupt")],
		["undefined", undefined],
		["null", null],
		["string", TEST19],
	])("returns undefined for %s", (_n, err) => {
		expect(peerUnavailableMessage(err, t, "read")).toBeUndefined();
		expect(peerUnavailableMessage(err, t, "write")).toBeUndefined();
	});
});
