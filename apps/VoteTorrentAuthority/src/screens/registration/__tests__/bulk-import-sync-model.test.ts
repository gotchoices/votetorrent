/**
 * bulk-import-sync-model.test.ts — the first dedicated co-located suite for
 * `bulk-import-sync-model.ts`'s pure, RN-safe view-model. Pins the D-01
 * registry seam, the D-11 peer-severance discipline, the T-48-20-02 PII
 * gate, and (51-10) the D-19 association-processing ordering/pre-filter
 * discipline (T-51-10-09) plus the combined-drive report merge.
 *
 * Plain TypeScript only, matching the module under test — no React, no
 * react-native, no @votetorrent/* import.
 */

import {
	clearSyncBindings,
	mergeTransportSyncReports,
	registerSyncBinding,
	resolveSyncBinding,
	resolveTransportCardState,
	runAssociationSync,
	toSyncErrorRefs,
	type SyncBindingHandle,
	type TransportSyncReport,
} from "../bulk-import-sync-model";

beforeEach(() => {
	clearSyncBindings();
});

// ---------------------------------------------------------------------------
// The registry seam
// ---------------------------------------------------------------------------

describe("registerSyncBinding / resolveSyncBinding / clearSyncBindings", () => {
	it("resolves undefined for an id nothing has attached", () => {
		expect(resolveSyncBinding("rest")).toBeUndefined();
	});

	it("resolves the handle registered for its own id, and no other", () => {
		const handle: SyncBindingHandle = {
			id: "filesystem",
			syncNow: async () => ({ syncedAt: "t", imported: 0, pending: 0, errorItemIds: [] }),
		};
		registerSyncBinding(handle);
		expect(resolveSyncBinding("filesystem")).toBe(handle);
		expect(resolveSyncBinding("rest")).toBeUndefined();
	});

	it("a later registration under the SAME id replaces the earlier one", () => {
		const first: SyncBindingHandle = { id: "rest", syncNow: async () => ({ syncedAt: "a", imported: 1, pending: 0, errorItemIds: [] }) };
		const second: SyncBindingHandle = { id: "rest", syncNow: async () => ({ syncedAt: "b", imported: 2, pending: 0, errorItemIds: [] }) };
		registerSyncBinding(first);
		registerSyncBinding(second);
		expect(resolveSyncBinding("rest")).toBe(second);
	});

	it("clearSyncBindings clears every registered binding", () => {
		registerSyncBinding({ id: "peer", syncNow: async () => ({ syncedAt: "t", imported: 0, pending: 0, errorItemIds: [] }) });
		clearSyncBindings();
		expect(resolveSyncBinding("peer")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// resolveTransportCardState
// ---------------------------------------------------------------------------

describe("resolveTransportCardState", () => {
	it("no report and not failed -> 'never', every other member undefined", () => {
		expect(resolveTransportCardState({})).toEqual({ syncState: "never" });
	});

	it("a report with no failure -> 'success', counts read straight off the report", () => {
		const report: TransportSyncReport = { syncedAt: "t", imported: 3, pending: 1, errorItemIds: ["a", "b"] };
		expect(resolveTransportCardState({ report })).toEqual({
			syncState: "success",
			lastSyncedAt: "t",
			importedCount: 3,
			pendingCount: 1,
			errorCount: 2,
		});
	});

	it("failed -> 'error', carrying the last successful report's values when one exists", () => {
		const report: TransportSyncReport = { syncedAt: "t", imported: 3, pending: 1, errorItemIds: ["a"] };
		expect(resolveTransportCardState({ report, failed: true })).toEqual({
			syncState: "error",
			lastSyncedAt: "t",
			importedCount: 3,
			pendingCount: 1,
			errorCount: 1,
		});
	});

	it("failed with no prior report -> 'error', every count undefined", () => {
		expect(resolveTransportCardState({ failed: true })).toEqual({ syncState: "error" });
	});
});

// ---------------------------------------------------------------------------
// toSyncErrorRefs — PII gate + fixed ordering
// ---------------------------------------------------------------------------

describe("toSyncErrorRefs", () => {
	it("returns refs in fixed transport order (filesystem, rest, peer), item order preserved within a transport", () => {
		const refs = toSyncErrorRefs({
			rest: { syncedAt: "t", imported: 0, pending: 0, errorItemIds: ["r1", "r2"] },
			filesystem: { syncedAt: "t", imported: 0, pending: 0, errorItemIds: ["f1"] },
			peer: { syncedAt: "t", imported: 0, pending: 0, errorItemIds: ["p1"] },
		});
		expect(refs).toEqual([
			{ transport: "filesystem", itemId: "f1" },
			{ transport: "rest", itemId: "r1" },
			{ transport: "rest", itemId: "r2" },
			{ transport: "peer", itemId: "p1" },
		]);
	});

	it("carries only identifiers — the ref shape has exactly transport and itemId", () => {
		const refs = toSyncErrorRefs({ rest: { syncedAt: "t", imported: 0, pending: 0, errorItemIds: ["r1"] } });
		expect(Object.keys(refs[0]).sort()).toEqual(["itemId", "transport"]);
	});

	it("an absent transport entry contributes nothing", () => {
		expect(toSyncErrorRefs({})).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// mergeTransportSyncReports — the D-19 combined-drive report merge
// ---------------------------------------------------------------------------

describe("mergeTransportSyncReports", () => {
	it("sums imported and pending, concatenates errorItemIds in (a, then b) order, and keeps b's syncedAt", () => {
		const a: TransportSyncReport = { syncedAt: "a-time", imported: 2, pending: 1, errorItemIds: ["a1"] };
		const b: TransportSyncReport = { syncedAt: "b-time", imported: 3, pending: 0, errorItemIds: ["b1", "b2"] };
		expect(mergeTransportSyncReports(a, b)).toEqual({
			syncedAt: "b-time",
			imported: 5,
			pending: 1,
			errorItemIds: ["a1", "b1", "b2"],
		});
	});

	it("the result still has exactly the 4 TransportSyncReport fields", () => {
		const merged = mergeTransportSyncReports(
			{ syncedAt: "a", imported: 0, pending: 0, errorItemIds: [] },
			{ syncedAt: "b", imported: 0, pending: 0, errorItemIds: [] },
		);
		expect(Object.keys(merged).sort()).toEqual(["errorItemIds", "imported", "pending", "syncedAt"]);
	});
});

// ---------------------------------------------------------------------------
// runAssociationSync — the D-19 ordering/pre-filter discipline (T-51-10-09)
// ---------------------------------------------------------------------------

describe("runAssociationSync", () => {
	interface ReqDoc {
		requestId: string;
	}
	interface AttDoc {
		requestId: string;
	}

	it("performs readStagedRequests -> submitRequest per doc, then readStagedAttestations -> submitAttestation per doc, then calls processPending exactly once", async () => {
		const calls: string[] = [];
		const req: ReqDoc = { requestId: "req-1" };
		const att: AttDoc = { requestId: "att-1" };

		const report = await runAssociationSync<ReqDoc, AttDoc>({
			readStagedRequests: async () => {
				calls.push("readStagedRequests");
				return [req];
			},
			readStagedAttestations: async () => {
				calls.push("readStagedAttestations");
				return [att];
			},
			requestIdOf: (d) => d.requestId,
			attestationIdOf: (d) => d.requestId,
			submitRequest: async (d) => {
				calls.push("submitRequest:" + d.requestId);
			},
			submitAttestation: async (d) => {
				calls.push("submitAttestation:" + d.requestId);
			},
			processPending: async () => {
				calls.push("processPending");
			},
		});

		expect(calls).toEqual([
			"readStagedRequests",
			"submitRequest:req-1",
			"readStagedAttestations",
			"submitAttestation:att-1",
			"processPending",
		]);
		expect(report.imported).toBe(2);
		expect(report.errorItemIds).toEqual([]);
	});

	it("T-51-10-09: a submitAttestation pre-filter THROW records the doc id in errorItemIds, the loop continues, and processPending is still called exactly once", async () => {
		let processPendingCalls = 0;
		const attestations: AttDoc[] = [{ requestId: "att-ok" }, { requestId: "att-fails" }];

		const report = await runAssociationSync<ReqDoc, AttDoc>({
			readStagedRequests: async () => [],
			readStagedAttestations: async () => attestations,
			requestIdOf: (d) => d.requestId,
			attestationIdOf: (d) => d.requestId,
			submitRequest: async () => {},
			submitAttestation: async (d) => {
				if (d.requestId === "att-fails") throw new Error("pre-filter rejected this document");
			},
			processPending: async () => {
				processPendingCalls += 1;
			},
		});

		expect(report.errorItemIds).toEqual(["att-fails"]);
		expect(report.imported).toBe(1);
		expect(processPendingCalls).toBe(1);
	});

	it("a submitRequest pre-filter THROW also records the doc id and does not prevent processPending", async () => {
		let processPendingCalls = 0;
		const requests: ReqDoc[] = [{ requestId: "req-fails" }];

		const report = await runAssociationSync<ReqDoc, AttDoc>({
			readStagedRequests: async () => requests,
			readStagedAttestations: async () => [],
			requestIdOf: (d) => d.requestId,
			attestationIdOf: (d) => d.requestId,
			submitRequest: async () => {
				throw new Error("boom");
			},
			submitAttestation: async () => {},
			processPending: async () => {
				processPendingCalls += 1;
			},
		});

		expect(report.errorItemIds).toEqual(["req-fails"]);
		expect(processPendingCalls).toBe(1);
	});

	it("a rejected readStagedRequests/readStagedAttestations is treated as an honest empty batch, never an abort", async () => {
		let processPendingCalls = 0;
		const report = await runAssociationSync<ReqDoc, AttDoc>({
			readStagedRequests: async () => {
				throw new Error("network unreachable");
			},
			readStagedAttestations: async () => {
				throw new Error("network unreachable");
			},
			requestIdOf: (d) => d.requestId,
			attestationIdOf: (d) => d.requestId,
			submitRequest: async () => {},
			submitAttestation: async () => {},
			processPending: async () => {
				processPendingCalls += 1;
			},
		});

		expect(report.errorItemIds).toEqual([]);
		expect(report.imported).toBe(0);
		expect(processPendingCalls).toBe(1);
	});

	it("WR-07: a re-offered document an alreadyImported predicate claims is neither imported nor an error", async () => {
		// Staged reads take no cursor and nothing deletes a staged document, so every previously
		// imported document is re-offered on every Sync Now. Before this, press 2 reported press
		// 1's success as a sync error (duplicate primary key / Status !== 'c') forever.
		const submitted: string[] = [];
		let processPendingCalls = 0;

		const report = await runAssociationSync<ReqDoc, AttDoc>({
			readStagedRequests: async () => [{ requestId: "req-old" }, { requestId: "req-new" }],
			readStagedAttestations: async () => [{ requestId: "att-old" }, { requestId: "att-new" }],
			requestIdOf: (d) => d.requestId,
			attestationIdOf: (d) => d.requestId,
			submitRequest: async (d) => {
				submitted.push("req:" + d.requestId);
			},
			submitAttestation: async (d) => {
				submitted.push("att:" + d.requestId);
			},
			processPending: async () => {
				processPendingCalls += 1;
			},
			alreadyImportedRequest: async (d) => d.requestId === "req-old",
			alreadyImportedAttestation: async (d) => d.requestId === "att-old",
		});

		expect(submitted).toEqual(["req:req-new", "att:att-new"]);
		expect(report.imported).toBe(2);
		expect(report.errorItemIds).toEqual([]);
		expect(processPendingCalls).toBe(1);
	});

	it("WR-07: an alreadyImported predicate that THROWS falls back to attempting the submit", async () => {
		// A broken predicate must never silently swallow a document.
		const submitted: string[] = [];
		const report = await runAssociationSync<ReqDoc, AttDoc>({
			readStagedRequests: async () => [{ requestId: "req-1" }],
			readStagedAttestations: async () => [],
			requestIdOf: (d) => d.requestId,
			attestationIdOf: (d) => d.requestId,
			submitRequest: async (d) => {
				submitted.push(d.requestId);
			},
			submitAttestation: async () => {},
			processPending: async () => {},
			alreadyImportedRequest: async () => {
				throw new Error("engine read failed");
			},
		});

		expect(submitted).toEqual(["req-1"]);
		expect(report.imported).toBe(1);
		expect(report.errorItemIds).toEqual([]);
	});

	it("WR-07: omitting the predicates preserves the previous behaviour exactly", async () => {
		const report = await runAssociationSync<ReqDoc, AttDoc>({
			readStagedRequests: async () => [{ requestId: "req-1" }],
			readStagedAttestations: async () => [{ requestId: "att-1" }],
			requestIdOf: (d) => d.requestId,
			attestationIdOf: (d) => d.requestId,
			submitRequest: async () => {},
			submitAttestation: async () => {},
			processPending: async () => {},
		});
		expect(report.imported).toBe(2);
		expect(report.errorItemIds).toEqual([]);
	});

	it("errorItemIds never carries a payload value, only the identifier the caller supplies via requestIdOf/attestationIdOf", async () => {
		const report = await runAssociationSync<ReqDoc, AttDoc>({
			readStagedRequests: async () => [{ requestId: "req-1" }],
			readStagedAttestations: async () => [],
			requestIdOf: (d) => d.requestId,
			attestationIdOf: (d) => d.requestId,
			submitRequest: async () => {
				throw new Error("a transport error message with sensitive detail that must never leak");
			},
			submitAttestation: async () => {},
			processPending: async () => {},
		});
		expect(report.errorItemIds).toEqual(["req-1"]);
		expect(JSON.stringify(report)).not.toContain("sensitive detail");
	});
});
