/**
 * registrant-detail-model.test.ts — renderer-free truth tables for the D-10
 * lifecycle action table + no-op suppression, and the private/public tier
 * projections. Plain jest, no render harness, no mocks — mirrors
 * `registration-policy-reconciliation.test.ts`.
 */
import {
	LIFECYCLE_ACTIONS,
	availableLifecycleActions,
	isNoOpTransition,
	flattenPrivateDetails,
	toPublicTierRows,
	selectiveTierReadState,
	SELECTIVE_TIER_READ_STATE_COPY,
} from "../registrant-detail-model";
import type { PrivateDetail, RegistrantPublic, RegistrantStatus } from "@votetorrent/vote-core";

describe("availableLifecycleActions — D-10 no-op suppression truth table", () => {
	it("Active ('a'): renew, suspend, revoke — reinstate omitted (no-op)", () => {
		expect(availableLifecycleActions("a")).toEqual(["renew", "suspend", "revoke"]);
	});

	it("Suspended ('s'): renew, reinstate, revoke — suspend omitted (no-op)", () => {
		expect(availableLifecycleActions("s")).toEqual(["renew", "reinstate", "revoke"]);
	});

	it("Revoked ('r'): renew, reinstate, suspend — revoke omitted (no-op)", () => {
		expect(availableLifecycleActions("r")).toEqual(["renew", "reinstate", "suspend"]);
	});

	it("each status omits EXACTLY its own no-op action, asserted per status", () => {
		expect(availableLifecycleActions("a")).not.toContain("reinstate");
		expect(availableLifecycleActions("s")).not.toContain("suspend");
		expect(availableLifecycleActions("r")).not.toContain("revoke");
	});

	it("renew is present for every status — a renewal is never a no-op", () => {
		const statuses: RegistrantStatus[] = ["a", "s", "r"];
		for (const status of statuses) {
			expect(availableLifecycleActions(status)).toContain("renew");
		}
	});
});

describe("isNoOpTransition", () => {
	it.each<[RegistrantStatus, RegistrantStatus | undefined, boolean]>([
		["a", "a", true],
		["a", "s", false],
		["s", "s", true],
		["r", undefined, false],
		["a", undefined, false],
	])("isNoOpTransition(%s, %s) === %s", (current, target, expected) => {
		expect(isNoOpTransition(current, target)).toBe(expected);
	});
});

describe("LIFECYCLE_ACTIONS — the D-10 variant split", () => {
	it("suspend and revoke are BOTH typed — D-10 groups them together, not revoke alone", () => {
		expect(LIFECYCLE_ACTIONS.suspend.variant).toBe("typed");
		expect(LIFECYCLE_ACTIONS.revoke.variant).toBe("typed");
	});

	it("renew and reinstate are both ordinary", () => {
		expect(LIFECYCLE_ACTIONS.renew.variant).toBe("ordinary");
		expect(LIFECYCLE_ACTIONS.reinstate.variant).toBe("ordinary");
	});

	it("every dismissLabelKey names what is kept, and no copy key is an empty string", () => {
		const allowedDismissKeys = new Set([
			"registrantLifecycleKeepCurrentStatus",
			"registrantLifecycleKeepCurrentExpiration",
		]);
		for (const meta of Object.values(LIFECYCLE_ACTIONS)) {
			expect(allowedDismissKeys.has(meta.dismissLabelKey)).toBe(true);
			expect(meta.titleKey.length).toBeGreaterThan(0);
			expect(meta.bodyKey.length).toBeGreaterThan(0);
			expect(meta.confirmLabelKey.length).toBeGreaterThan(0);
			expect(meta.dismissLabelKey.length).toBeGreaterThan(0);
		}
	});

	it("renew.targetStatus is undefined; reinstate/suspend/revoke target a/s/r", () => {
		expect(LIFECYCLE_ACTIONS.renew.targetStatus).toBeUndefined();
		expect(LIFECYCLE_ACTIONS.reinstate.targetStatus).toBe("a");
		expect(LIFECYCLE_ACTIONS.suspend.targetStatus).toBe("s");
		expect(LIFECYCLE_ACTIONS.revoke.targetStatus).toBe("r");
	});
});

describe("flattenPrivateDetails", () => {
	it("flattens a flat list of three scalars in input order, String-coerced, including a numeric and a boolean value", () => {
		const details: PrivateDetail[] = [
			{ name: "SSN", value: "000-00-0000" },
			{ name: "AgeYears", value: 42 },
			{ name: "IsVerified", value: true },
		];
		expect(flattenPrivateDetails(details)).toEqual([
			{ name: "SSN", value: "000-00-0000" },
			{ name: "AgeYears", value: "42" },
			{ name: "IsVerified", value: "true" },
		]);
	});

	it("a nested detail flattens to prefixed child rows and emits no row of its own", () => {
		const details: PrivateDetail[] = [
			{
				name: "Address",
				value: [
					{ name: "Street", value: "12 Elm" },
					{ name: "Zip", value: 90210 },
				],
			},
		];
		const rows = flattenPrivateDetails(details);
		expect(rows).toEqual([
			{ name: "Address.Street", value: "12 Elm" },
			{ name: "Address.Zip", value: "90210" },
		]);
		expect(rows.some((r) => r.name === "Address")).toBe(false);
	});

	it("returns [] for undefined, [], and a non-array input, and skips whitespace-only names without throwing", () => {
		expect(flattenPrivateDetails(undefined)).toEqual([]);
		expect(flattenPrivateDetails([])).toEqual([]);
		expect(flattenPrivateDetails("not-an-array" as unknown as PrivateDetail[])).toEqual([]);

		const details: PrivateDetail[] = [
			{ name: "   ", value: "should be skipped" },
			{ name: "", value: "also skipped" },
			{ name: "Real", value: "kept" },
		];
		expect(() => flattenPrivateDetails(details)).not.toThrow();
		expect(flattenPrivateDetails(details)).toEqual([{ name: "Real", value: "kept" }]);
	});

	it("never emits a hint value, even though it does emit the value", () => {
		const details: PrivateDetail[] = [{ name: "SSN", value: "000-00-0000", hint: "HINT_SENTINEL" }];
		const result = flattenPrivateDetails(details);
		expect(JSON.stringify(result)).not.toContain("HINT_SENTINEL");
		expect(JSON.stringify(result)).toContain("000-00-0000");
	});

	it("a chain nested 12 levels deep returns without hanging and emits no row deeper than MAX_PRIVATE_DETAIL_DEPTH", () => {
		// Build a single-child chain: leaf0 -> leaf0.leaf1 -> ... -> 12 deep.
		let chain: PrivateDetail[] = [{ name: "Leaf11", value: "bottom" }];
		for (let i = 10; i >= 0; i--) {
			chain = [{ name: `Leaf${i}`, value: chain }];
		}
		const rows = flattenPrivateDetails(chain);
		// Every emitted row's name is a dot-joined path; the deepest possible
		// path has at most MAX_PRIVATE_DETAIL_DEPTH (8) segments — a row from
		// beyond the guard would have 9+ segments.
		for (const row of rows) {
			const segments = row.name.split(".").length;
			expect(segments).toBeLessThanOrEqual(8);
		}
		// The chain is 12 deep, so the guard must have actually suppressed
		// something — otherwise this test would vacuously pass on an unguarded
		// implementation.
		expect(rows.length).toBe(0);
	});
});

describe("toPublicTierRows", () => {
	it("orders lastName, firstName, district, then extras in Object.keys order", () => {
		const publicTier: RegistrantPublic = {
			cid: "cid-1",
			registrantId: "r-1",
			lastName: "Doe",
			firstName: "Jane",
			district: "D-7",
			extraFields: { precinct: "P-12", ward: "W-3" },
		};
		expect(toPublicTierRows(publicTier)).toEqual([
			{ name: "lastName", value: "Doe" },
			{ name: "firstName", value: "Jane" },
			{ name: "district", value: "D-7" },
			{ name: "precinct", value: "P-12" },
			{ name: "ward", value: "W-3" },
		]);
	});

	it("a tier with only district returns one row", () => {
		const publicTier: RegistrantPublic = { cid: "cid-1", registrantId: "r-1", district: "D-7" };
		expect(toPublicTierRows(publicTier)).toEqual([{ name: "district", value: "D-7" }]);
	});

	it("undefined returns []", () => {
		expect(toPublicTierRows(undefined)).toEqual([]);
	});

	it("an empty-string firstName is omitted", () => {
		const publicTier: RegistrantPublic = {
			cid: "cid-1",
			registrantId: "r-1",
			lastName: "Doe",
			firstName: "   ",
		};
		expect(toPublicTierRows(publicTier)).toEqual([{ name: "lastName", value: "Doe" }]);
	});
});

describe("negative space — this module's runtime surface is pinned", () => {
	it("exposes exactly the seven runtime bindings; no export accepts or returns a signature, engine, or scope shape", () => {
		// `export type`/`export interface` (LifecycleActionId, LifecycleActionMeta,
		// DetailFieldRow — three of the eight names in the plan's must_haves.artifacts
		// export list) produce NO runtime binding at all: TypeScript erases them
		// entirely, so they never appear in `Object.keys` of the compiled module.
		// The module's actual JS surface is therefore these seven names; the other
		// three are pinned at compile time instead — any external use of those
		// type names already fails to typecheck if this module stopped exporting
		// them. Together the two mechanisms pin the same eight-name surface the
		// plan describes, so a later edit cannot silently grow engine access into
		// a file the screen trusts to be pure.
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const moduleExports = require("../registrant-detail-model");
		expect(Object.keys(moduleExports).sort()).toEqual(
			[
				"LIFECYCLE_ACTIONS",
				"availableLifecycleActions",
				"isNoOpTransition",
				"flattenPrivateDetails",
				"toPublicTierRows",
				"privateTierReadState",
				"PRIVATE_TIER_READ_STATE_COPY",
				"selectiveTierReadState",
				"SELECTIVE_TIER_READ_STATE_COPY",
			].sort(),
		);
	});
});

describe("selectiveTierReadState (M1/M2)", () => {
	it("M1: readable states", () => {
		expect(selectiveTierReadState(undefined)).toBe("readable");
		expect(selectiveTierReadState("opened")).toBe("readable");
		expect(selectiveTierReadState("unsealed")).toBe("readable");
	});
	it("M1: unread states", () => {
		expect(selectiveTierReadState("not-a-recipient")).toBe("not-a-recipient");
		expect(selectiveTierReadState("no-opener")).toBe("no-key");
		expect(selectiveTierReadState("unreadable")).toBe("unreadable");
		expect(selectiveTierReadState("tampered")).toBe("tampered");
	});
	it("M2: copy map", () => {
		expect(SELECTIVE_TIER_READ_STATE_COPY).toEqual({
			"not-a-recipient": "registrantSelectiveNotRecipient",
			"no-key": "registrationContentNoKey",
			unreadable: "registrantSelectiveUnreadable",
			tampered: "registrantSelectiveTampered",
		});
	});
});
