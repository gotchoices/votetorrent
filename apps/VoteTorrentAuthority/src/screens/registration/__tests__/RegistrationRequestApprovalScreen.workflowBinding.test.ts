/**
 * Text gate (67-18): the registration approval screen holds no decision workflow call of its own and
 * binds to the shared `@votetorrent/workflows` registration-approval module, whose approve body keeps
 * the WR-19 order (checklist gate, digest, signer, completion, publish). Every forbidden token is
 * assembled from fragments at runtime so a later scan of the tests tree cannot trip on this file.
 */
import * as fs from "fs";
import * as path from "path";

const SCREEN = path.resolve(__dirname, "..", "RegistrationRequestApprovalScreen.tsx");
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..", "..");
const SHARED = path.join(REPO_ROOT, "packages", "workflows", "src", "authority", "registration-approval.ts");

/** Same shape as deviceSigningRollout.coverage.test.ts: block comments, then `//` line tails. */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map((line) => line.replace(/\/\/.*$/, ""))
		.join("\n");
}

const call = (...parts: string[]): string => parts.join("") + "(";

/** The engine and publish calls the screen used to make itself. */
const FORBIDDEN_CALLS: readonly string[] = [
	call("getSignature", "Digest"),
	call("complete", "Signature"),
	call("rejectRegistration", "Request"),
	call("closeStaleRegistration", "Request"),
	call("getPrior", "Rejections"),
	call("getDuplicate", "Closure"),
	call("getLikelyDuplicate", "Requests"),
	call("getRequested", "Signatures"),
	call("getRegistrantSigning", "Status"),
	call("getStaleClose", "Availability"),
	call("getRegistration", "Request"),
	call("publishRegistrationDecision", "AfterDecide"),
];

const SHARED_FUNCTIONS: readonly string[] = [
	"loadRegistrationApproval",
	"approveRegistrationRequest",
	"refuseRegistrationRequest",
	"recordRegistrationRejectVote",
	"closeRegistrationRequestAsStale",
];

export function forbiddenCallHits(strippedSource: string): string[] {
	return FORBIDDEN_CALLS.filter((token) => strippedSource.includes(token));
}

/** The body of one exported async function: from its declaration to the next top-level `export`. */
function exportedBody(source: string, name: string): string {
	const start = source.indexOf("export async function " + name);
	if (start < 0) throw new Error("missing export " + name);
	const next = source.indexOf("\nexport ", start + 1);
	return next < 0 ? source.slice(start) : source.slice(start, next);
}

function orderedIndexes(body: string, tokens: readonly string[]): number[] {
	return tokens.map((token) => body.indexOf(token));
}

describe("RegistrationRequestApprovalScreen binds to the shared registration-approval workflow", () => {
	const screenSource = fs.readFileSync(SCREEN, "utf8");
	const screen = stripComments(screenSource);

	it("W1 the screen makes none of the decision workflow's engine or publish calls itself", () => {
		expect(forbiddenCallHits(screen)).toEqual([]);
	});

	it("W2 the screen imports the five shared decision functions from @votetorrent/workflows/authority", () => {
		const importBlock = screen.match(/import\s*\{([^}]*)\}\s*from\s*"@votetorrent\/workflows\/authority"/);
		expect(importBlock).not.toBeNull();
		const imported = (importBlock as RegExpMatchArray)[1]
			.split(",")
			.map((s) => s.replace(/^\s*type\s+/, "").trim())
			.filter((s) => s.length > 0);
		for (const name of SHARED_FUNCTIONS) {
			expect(imported).toContain(name);
		}
	});

	it("W3 the screen still owns a real device-signer call and routes it through the signing-error hook", () => {
		expect(screen).toContain(call("createDevice", "Signer"));
		expect(screenSource).toContain("useDeviceSigningErrorHandler");
	});

	it("W4 the shared approve body keeps the WR-19 order and the shared refuse body never reads a digest", () => {
		const shared = stripComments(fs.readFileSync(SHARED, "utf8"));
		const approve = exportedBody(shared, "approveRegistrationRequest");
		const order = orderedIndexes(approve, [
			call("isChecklistGate", "Met"),
			call("getSignature", "Digest"),
			call("resolve", "Sign"),
			call("complete", "Signature"),
			call("publishRegistrationDecision", "AfterDecide"),
		]);
		for (const index of order) expect(index).toBeGreaterThanOrEqual(0);
		for (let i = 1; i < order.length; i++) expect(order[i - 1]).toBeLessThan(order[i]);

		const refuse = exportedBody(shared, "refuseRegistrationRequest");
		const gate = refuse.indexOf(call("isChecklistGate", "Met"));
		const resolve = refuse.indexOf(call("resolve", "Sign"));
		expect(gate).toBeGreaterThanOrEqual(0);
		expect(resolve).toBeGreaterThan(gate);
		expect(refuse.includes(call("getSignature", "Digest"))).toBe(false);
	});

	it("W5 control: the scanner reports a planted digest call, so W1 can fail", () => {
		const planted = "const d = await engine." + call("getSignature", "Digest") + "task);";
		expect(forbiddenCallHits(planted)).toEqual([call("getSignature", "Digest")]);
		expect(forbiddenCallHits("const d = 1;")).toEqual([]);
	});
});
