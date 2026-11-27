/**
 * PR-1 (Session 1 Pixel_8, 2026-10-08) FAILED: in Spanish, Revisar Administracion's add button read
 * "AGREGAR ADMINISTRADOR", Agregar Red's founding field read "Administrador Inicial", and the eight
 * permission names stayed English ("Revise Network", "Validate registrations", ...). 62-140 had
 * changed `addOfficer` / `initialOfficer`, which no screen renders, and the permission names came
 * straight from vote-core's English `scopeDescriptions`.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { scopeDescriptions } from "@votetorrent/vote-core";
import { resources } from "../index";
import { scopeLabel } from "../../utils/scopeLabel";

type Tree = { [k: string]: string | Tree };
const es = resources.es.translation as unknown as Record<string, string>;
const en = resources.en.translation as unknown as Record<string, string>;
const tEs = (k: string) => (typeof (es as Tree)[k] === "string" ? es[k] : k);
const tEn = (k: string) => (typeof (en as Tree)[k] === "string" ? en[k] : k);
const SCOPES = Object.keys(scopeDescriptions);

describe("Spanish officer labels the screens actually render (PR-1)", () => {
	it("the add-officer button and the founding-officer field read funcionario", () => {
		// ProposedAdministrationScreen renders t("addAdministrator"); AddNetworkScreen t("initialAdministrator").
		expect(es.addAdministrator).toBe("Agregar Funcionario");
		expect(es.initialAdministrator).toBe("Funcionario Inicial");
	});

	it("every permission name is translated in Spanish, and English keeps vote-core's wording", () => {
		expect(SCOPES).toHaveLength(9);
		for (const scope of SCOPES) {
			const spanish = scopeLabel(scope, tEs);
			expect(spanish).not.toBe(scopeDescriptions[scope]);
			expect(spanish).not.toBe(scope);
			expect(scopeLabel(scope, tEn)).toBe(scopeDescriptions[scope]);
		}
	});

	it("a missing key falls back to vote-core's English, then to the code", () => {
		const identity = (k: string) => k;
		expect(scopeLabel("vrg", identity)).toBe(scopeDescriptions.vrg);
		expect(scopeLabel("zz-unknown", identity)).toBe("zz-unknown");
	});

	it("no screen or component renders scopeDescriptions directly", () => {
		const root = join(__dirname, "..", "..");
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const p = join(dir, name);
				if (statSync(p).isDirectory()) {
					if (name !== "__tests__" && name !== "node_modules") walk(p);
				} else if (/\.tsx?$/.test(name) && /\bscopeDescriptions\b/.test(readFileSync(p, "utf8"))) {
					offenders.push(relative(root, p));
				}
			}
		};
		walk(root);
		expect(offenders).toEqual(["utils/scopeLabel.ts"]);
	});
});
