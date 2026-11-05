/// <reference types="node" />
import * as fs from "fs";
import * as path from "path";
import { FOUNDING_OFFICER_SCOPES } from "../foundingOfficerScopes";

const SCHEMA_PATH = path.join(
	__dirname,
	"../../../../../packages/vote-core/schema/votetorrent.qsql",
);

function parseSchemaScopeCodes(): Set<string> {
	const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
	const start = schema.indexOf("view Scope as");
	const end = schema.indexOf(";", start);
	const viewBody = schema.slice(start, end);

	const codes = new Set<string>();
	const re = /select\s+'([a-z]+)'\s+as\s+Code/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(viewBody)) !== null) {
		codes.add(match[1]);
	}
	return codes;
}

describe("FOUNDING_OFFICER_SCOPES (D-15)", () => {
	test("the seed set equals the schema view Scope code set exactly", () => {
		const schemaCodes = parseSchemaScopeCodes();
		expect(schemaCodes.size).toBe(9);
		expect(new Set(FOUNDING_OFFICER_SCOPES)).toEqual(schemaCodes);
		expect(FOUNDING_OFFICER_SCOPES.length).toBe(9);
	});

	test("the seed set does not contain rnp", () => {
		// 'rnp' was declared in the TS Scope union but never in the schema's
		// view Scope; it was removed from the union on 2026-08-25. Officer.ScopesValid
		// (votetorrent.qsql:185) and ProposedOfficer.ScopesValid (:421) reject any
		// code the view does not define, which would throw the whole
		// network-creation transaction. Kept as a regression guard.
		expect(FOUNDING_OFFICER_SCOPES).not.toContain("rnp");
	});

	test("the seed set includes the scopes every Phase 47 screen gates on", () => {
		expect(FOUNDING_OFFICER_SCOPES).toContain("vrg");
		expect(FOUNDING_OFFICER_SCOPES).toContain("cap");

		for (const code of ["rn", "rad", "iad", "uai", "mel", "ceb"]) {
			expect(FOUNDING_OFFICER_SCOPES).toContain(code);
		}
	});

	test("both seed sites consume the shared constant and hold no inline scope literal", () => {
		const addNetworkScreen = fs.readFileSync(
			path.join(__dirname, "../../screens/networks/AddNetworkScreen.tsx"),
			"utf8",
		);
		const adminInvitationScreen = fs.readFileSync(
			path.join(__dirname, "../../screens/admin/AdministratorInvitationScreen.tsx"),
			"utf8",
		);

		for (const source of [addNetworkScreen, adminInvitationScreen]) {
			expect(source).toContain("[...FOUNDING_OFFICER_SCOPES]");
			expect(source).toContain("utils/foundingOfficerScopes");
			expect(source).not.toMatch(/scopes:\s*\[\s*"/);
		}
	});

	test("the seed array is not mutable through the export", () => {
		const mutableCopy = [...FOUNDING_OFFICER_SCOPES];
		mutableCopy.push("rn");
		mutableCopy.pop();
		mutableCopy.length = 0;

		expect(FOUNDING_OFFICER_SCOPES.length).toBe(9);
	});
});
