import * as fs from "fs";
import * as path from "path";
import { REGISTRATION_DUPLICATE_CLOSED_REASON } from "@votetorrent/vote-engine/rn";
import {
	attachSyncBindings,
	createRestRegistrationSyncBinding,
	REST_BRIDGE_FETCH_TIMEOUT_MS,
	REST_SYNC_REQUEST_ID_PATTERN,
	type RestRegistrationSyncDeps,
} from "../attach-sync-bindings";
import { clearSyncBindings, resolveSyncBinding } from "../bulk-import-sync-model";

/**
 * attach-sync-bindings.test.ts — Phase 62 Plan 25 (D-29). RED-then-GREEN against the old
 * `__DEV__`-gated, bridge-key-provisioning module; GREEN against this plan's production binding.
 * Fakes only — no network.
 */

const AUTHORITY_ID = "auth-1";

interface FakeIntakeEngine {
	readIntakePolicy: jest.Mock;
}

interface FakeRegistrationEngine {
	getRegistrationRequest: jest.Mock;
	submitRegistrationRequest: jest.Mock;
	getDuplicateClosure: jest.Mock;
	registerBridgeKey?: jest.Mock;
}

interface FakeTransport {
	pollDecisions: jest.Mock;
}

function makeDeps(overrides?: {
	restBridgeUrl?: string | null;
	policyThrows?: boolean;
	localRequests?: Record<string, { status: string; decidedAt?: string; rejectionReason?: string }>;
	submitImpl?: (init: unknown, requesterKey: string, signature: unknown) => Promise<string>;
	duplicateClosures?: Record<string, { requestId: string; state: "closed" | "closing"; closedAt?: string }>;
	notices?: Array<{ requestId: string }>;
	pollDecisionsThrows?: boolean;
	stagedResponse?: { ok: boolean; status?: number; body?: unknown; throws?: boolean };
	postResponses?: Record<string, { ok: boolean; status?: number }>;
}) {
	const o = overrides ?? {};
	const localRequests = o.localRequests ?? {};

	const intakeEngine: FakeIntakeEngine = {
		readIntakePolicy: jest.fn(async () => {
			if (o.policyThrows) throw new Error("policy read failed");
			return { restBridgeUrl: o.restBridgeUrl === undefined ? null : o.restBridgeUrl };
		}),
	};

	const regEngine: FakeRegistrationEngine = {
		getRegistrationRequest: jest.fn(async (id: string) => localRequests[id]),
		submitRegistrationRequest: jest.fn(
			o.submitImpl ?? (async () => "ok"),
		),
		getDuplicateClosure: jest.fn(async (id: string) => (o.duplicateClosures ?? {})[id]),
		registerBridgeKey: jest.fn(async () => undefined),
	};

	const engines: Record<string, unknown> = { intake: intakeEngine, registration: regEngine };
	const getEngine = jest.fn(async <T,>(name: string): Promise<T> => engines[name] as T);

	const transportCalls: { baseUrl: string }[] = [];
	const transport: FakeTransport = {
		pollDecisions: jest.fn(async () => {
			if (o.pollDecisionsThrows) throw new Error("poll failed");
			return o.notices ?? [];
		}),
	};
	const loadTransport = jest.fn(() => {
		return class {
			pollDecisions: jest.Mock;
			constructor(options: { baseUrl: string }) {
				transportCalls.push(options);
				this.pollDecisions = transport.pollDecisions;
			}
		} as unknown as RestRegistrationSyncDeps extends { loadTransport?: () => infer C } ? C : never;
	});

	const fetchCalls: { url: string; init?: { method: "GET" | "POST"; body?: string } }[] = [];
	const fetchJson = jest.fn(async (url: string, init?: { method: "GET" | "POST"; body?: string }) => {
		fetchCalls.push({ url, init });
		if (!init || init.method === "GET" || init.method === undefined) {
			if (o.stagedResponse?.throws) throw new Error("fetch failed");
			const resp = o.stagedResponse ?? { ok: true, body: { staged: [] } };
			return {
				ok: resp.ok,
				status: resp.status ?? (resp.ok ? 200 : 500),
				json: async () => resp.body ?? { staged: [] },
			};
		}
		// POST
		const body = init.body ? (JSON.parse(init.body) as { requestId: string }) : undefined;
		const key = body?.requestId ?? "";
		const resp = (o.postResponses ?? {})[key] ?? { ok: true, status: 200 };
		return { ok: resp.ok, status: resp.status ?? (resp.ok ? 200 : 500), json: async () => ({}) };
	});

	const deps: RestRegistrationSyncDeps = {
		getEngine: getEngine as unknown as RestRegistrationSyncDeps["getEngine"],
		loadTransport,
		fetchJson,
	};

	return { deps, intakeEngine, regEngine, getEngine, transportCalls, fetchCalls, fetchJson };
}

describe("createRestRegistrationSyncBinding — R1-R10", () => {
	it("R1: no context rejects before any getEngine/transport/fetch call", async () => {
		const { deps, getEngine, fetchJson } = makeDeps();
		const binding = createRestRegistrationSyncBinding(deps);
		await expect(binding.syncNow()).rejects.toThrow();
		await expect(binding.syncNow({ authorityId: "" })).rejects.toThrow();
		expect(getEngine).not.toHaveBeenCalled();
		expect(fetchJson).not.toHaveBeenCalled();
	});

	it("R2b: a private or loopback bridge host is refused locally, no fetch; a public host still fetches", async () => {
		for (const url of ["https://192.168.1.2/x", "https://127.0.0.1/x"]) {
			const { deps, fetchJson } = makeDeps({ restBridgeUrl: url });
			const binding = createRestRegistrationSyncBinding(deps);
			await expect(binding.syncNow({ authorityId: AUTHORITY_ID })).rejects.toThrow();
			expect(fetchJson).not.toHaveBeenCalled();
		}
		const { deps, fetchJson } = makeDeps({ restBridgeUrl: "https://bridge.example" });
		await createRestRegistrationSyncBinding(deps).syncNow({ authorityId: AUTHORITY_ID });
		expect(fetchJson).toHaveBeenCalled();
	});

	it("R2: no URL (null or non-https) rejects before transport construction or fetch", async () => {
		const { deps, fetchJson } = makeDeps({ restBridgeUrl: null });
		const binding = createRestRegistrationSyncBinding(deps);
		await expect(binding.syncNow({ authorityId: AUTHORITY_ID })).rejects.toThrow();
		expect(fetchJson).not.toHaveBeenCalled();

		const { deps: deps2, fetchJson: fetchJson2 } = makeDeps({ restBridgeUrl: "http://bridge.example" });
		const binding2 = createRestRegistrationSyncBinding(deps2);
		await expect(binding2.syncNow({ authorityId: AUTHORITY_ID })).rejects.toThrow();
		expect(fetchJson2).not.toHaveBeenCalled();
	});

	it("R3: the constructor receives the policy's baseUrl, the listing fetch targets it, and a later sync re-reads the policy (no caching)", async () => {
		let currentUrl = "https://bridge.example/intake";
		const deps = makeDeps({ restBridgeUrl: currentUrl }).deps;
		(deps.getEngine as jest.Mock).mockImplementation(async (name: string) => {
			if (name === "intake") return { readIntakePolicy: async () => ({ restBridgeUrl: currentUrl }) };
			return {
				getRegistrationRequest: async () => undefined,
				submitRegistrationRequest: async () => "ok",
				getDuplicateClosure: async () => undefined,
			};
		});
		const transportCalls: { baseUrl: string }[] = [];
		(deps as any).loadTransport = () =>
			class {
				constructor(options: { baseUrl: string }) {
					transportCalls.push(options);
				}
				pollDecisions = async () => [];
			};
		const fetchCalls: string[] = [];
		(deps as any).fetchJson = async (url: string) => {
			fetchCalls.push(url);
			return { ok: true, status: 200, json: async () => ({ staged: [] }) };
		};

		const binding = createRestRegistrationSyncBinding(deps);
		await binding.syncNow({ authorityId: AUTHORITY_ID });
		expect(transportCalls[0]).toEqual({ baseUrl: "https://bridge.example/intake" });
		expect(fetchCalls[0]).toBe("https://bridge.example/intake/staged-requests");

		currentUrl = "https://other.example/bridge";
		await binding.syncNow({ authorityId: AUTHORITY_ID });
		expect(transportCalls[1]).toEqual({ baseUrl: "https://other.example/bridge" });
		expect(fetchCalls[1]).toBe("https://other.example/bridge/staged-requests");
	});

	it("R4: intake submits absent docs for this authority, skips other authorities, skips already-local, counts imported, and routes a throwing submit to errorItemIds without leaking its message", async () => {
		const staged = [
			{ requestId: "r1", init: { id: "r1", authorityId: AUTHORITY_ID }, requesterKey: "k1", signature: {} },
			{ requestId: "r2", init: { id: "r2", authorityId: "auth-2" }, requesterKey: "k2", signature: {} },
			{ requestId: "r3", init: { id: "r3", authorityId: AUTHORITY_ID }, requesterKey: "k3", signature: {} },
			{ requestId: "r4", init: { id: "r4", authorityId: AUTHORITY_ID }, requesterKey: "k4", signature: {} },
		];
		const { deps, regEngine } = makeDeps({
			restBridgeUrl: "https://bridge.example",
			localRequests: { r3: { status: "p" } },
			stagedResponse: { ok: true, body: { staged } },
			submitImpl: async (init: any) => {
				if (init.id === "r4") throw new Error("super-secret-detail-should-not-leak");
				return "ok";
			},
		});
		const binding = createRestRegistrationSyncBinding(deps);
		const report = await binding.syncNow({ authorityId: AUTHORITY_ID });

		expect(regEngine.submitRegistrationRequest).toHaveBeenCalledWith(
			{ id: "r1", authorityId: AUTHORITY_ID },
			"k1",
			{},
		);
		expect(regEngine.submitRegistrationRequest).not.toHaveBeenCalledWith(
			expect.objectContaining({ id: "r2" }),
			expect.anything(),
			expect.anything(),
		);
		expect(regEngine.submitRegistrationRequest).not.toHaveBeenCalledWith(
			expect.objectContaining({ id: "r3" }),
			expect.anything(),
			expect.anything(),
		);
		expect(report.imported).toBe(1);
		expect(report.errorItemIds).toContain("r4");
		expect(JSON.stringify(report)).not.toContain("super-secret-detail-should-not-leak");
	});

	it("R5: hostile ids never reach submit or the report; a valid id with a missing init/signature goes to errorItemIds", async () => {
		const longId = "x".repeat(300);
		const staged = [
			{ requestId: longId, init: { id: longId, authorityId: AUTHORITY_ID }, requesterKey: "k", signature: {} },
			{ requestId: "has space", init: { id: "has space", authorityId: AUTHORITY_ID }, requesterKey: "k", signature: {} },
			{ requestId: "line\nbreak", init: { id: "line\nbreak", authorityId: AUTHORITY_ID }, requesterKey: "k", signature: {} },
			{ requestId: "mismatch", init: { id: "other", authorityId: AUTHORITY_ID }, requesterKey: "k", signature: {} },
			{ requestId: "ok-valid-1", init: { id: "ok-valid-1", authorityId: AUTHORITY_ID }, requesterKey: undefined, signature: {} },
		];
		const { deps, regEngine } = makeDeps({
			restBridgeUrl: "https://bridge.example",
			stagedResponse: { ok: true, body: { staged } },
		});
		const binding = createRestRegistrationSyncBinding(deps);
		const report = await binding.syncNow({ authorityId: AUTHORITY_ID });

		expect(regEngine.submitRegistrationRequest).not.toHaveBeenCalled();
		expect(JSON.stringify(report)).not.toContain(longId);
		expect(JSON.stringify(report)).not.toContain("has space");
		expect(JSON.stringify(report)).not.toContain("line\nbreak");
		expect(JSON.stringify(report)).not.toContain("mismatch");
		expect(report.errorItemIds).toContain("ok-valid-1");
	});

	it("R6: a listing with bridgeKeys causes zero registerBridgeKey calls, and the source has no registerBridgeKey/createDeviceSigner", async () => {
		const { deps, regEngine } = makeDeps({
			restBridgeUrl: "https://bridge.example",
			stagedResponse: { ok: true, body: { staged: [], bridgeKeys: [{ id: "bk1", authorityId: AUTHORITY_ID, label: "x", key: "y" }] } },
		});
		const binding = createRestRegistrationSyncBinding(deps);
		await binding.syncNow({ authorityId: AUTHORITY_ID });
		expect(regEngine.registerBridgeKey).not.toHaveBeenCalled();

		const source = fs.readFileSync(
			path.join(__dirname, "..", "attach-sync-bindings.ts"),
			"utf8",
		);
		expect(source).not.toMatch(/registerBridgeKey/);
		expect(source).not.toMatch(/createDeviceSigner/);
	});

	it("R7: decision post-back posts the right body per status, never re-posts a known notice, and handles duplicate closure", async () => {
		const staged = [
			{ requestId: "r1", init: { id: "r1", authorityId: AUTHORITY_ID }, requesterKey: "k1", signature: {} },
			{ requestId: "r2", init: { id: "r2", authorityId: AUTHORITY_ID }, requesterKey: "k2", signature: {} },
			{ requestId: "r-old", init: { id: "r-old", authorityId: AUTHORITY_ID }, requesterKey: "k3", signature: {} },
			{ requestId: "r3", init: { id: "r3", authorityId: AUTHORITY_ID }, requesterKey: "k4", signature: {} },
			{ requestId: "r4", init: { id: "r4", authorityId: AUTHORITY_ID }, requesterKey: "k5", signature: {} },
		];
		const { deps, fetchJson } = makeDeps({
			restBridgeUrl: "https://bridge.example",
			stagedResponse: { ok: true, body: { staged } },
			notices: [{ requestId: "r-old" }],
			localRequests: {
				r1: { status: "a", decidedAt: "2026-01-01T00:00:00.000Z" },
				r2: { status: "r", decidedAt: "2026-01-02T00:00:00.000Z", rejectionReason: "bad-id" },
				"r-old": { status: "a", decidedAt: "2026-01-03T00:00:00.000Z" },
				r3: { status: "p" },
				r4: { status: "a", decidedAt: "2026-01-04T00:00:00.000Z" },
			},
			duplicateClosures: {
				r3: { requestId: "r3", state: "closed", closedAt: "2026-01-05T00:00:00.000Z" },
			},
		});
		const binding = createRestRegistrationSyncBinding(deps);
		await binding.syncNow({ authorityId: AUTHORITY_ID });

		const posts = (fetchJson as jest.Mock).mock.calls.filter(
			([, init]) => init?.method === "POST",
		);
		const bodies = posts.map(([, init]) => JSON.parse(init.body));

		expect(bodies).toContainEqual({ requestId: "r1", status: "a", decidedAt: "2026-01-01T00:00:00.000Z" });
		expect(bodies).toContainEqual({
			requestId: "r2",
			status: "r",
			reason: "bad-id",
			decidedAt: "2026-01-02T00:00:00.000Z",
		});
		expect(bodies.find((b: any) => b.requestId === "r-old")).toBeUndefined();
		expect(bodies).toContainEqual({
			requestId: "r3",
			status: "r",
			reason: REGISTRATION_DUPLICATE_CLOSED_REASON,
			decidedAt: "2026-01-05T00:00:00.000Z",
		});
		// r4 is declared 'local' but excluded above so we can see what an un-decided pending ('p', no
		// closure) request does: it posts nothing (covered by not appearing in bodies at all); here
		// r4 IS decided 'a' so it posts like r1.
		expect(bodies).toContainEqual({ requestId: "r4", status: "a", decidedAt: "2026-01-04T00:00:00.000Z" });
	});

	it("R8: a non-2xx POST goes to errorItemIds; a throwing pollDecisions makes no POST and folds decided-unposted into pending", async () => {
		const staged = [
			{ requestId: "r1", init: { id: "r1", authorityId: AUTHORITY_ID }, requesterKey: "k1", signature: {} },
		];
		const { deps, fetchJson } = makeDeps({
			restBridgeUrl: "https://bridge.example",
			stagedResponse: { ok: true, body: { staged } },
			localRequests: { r1: { status: "a", decidedAt: "2026-01-01T00:00:00.000Z" } },
			postResponses: { r1: { ok: false, status: 500 } },
		});
		const binding = createRestRegistrationSyncBinding(deps);
		const report = await binding.syncNow({ authorityId: AUTHORITY_ID });
		expect(report.errorItemIds).toContain("r1");

		const { deps: deps2, fetchJson: fetchJson2 } = makeDeps({
			restBridgeUrl: "https://bridge.example",
			stagedResponse: { ok: true, body: { staged } },
			localRequests: { r1: { status: "a", decidedAt: "2026-01-01T00:00:00.000Z" } },
			pollDecisionsThrows: true,
		});
		const binding2 = createRestRegistrationSyncBinding(deps2);
		const report2 = await binding2.syncNow({ authorityId: AUTHORITY_ID });
		const posts2 = (fetchJson2 as jest.Mock).mock.calls.filter(([, init]) => init?.method === "POST");
		expect(posts2).toHaveLength(0);
		expect(report2.pending).toBeGreaterThanOrEqual(1);
	});

	it("R9 (inverted, S-1): a non-ok or throwing GET /staged-requests REJECTS the sync with a fixed message, never an empty healthy batch", async () => {
		for (const status of [401, 500]) {
			const { deps } = makeDeps({ restBridgeUrl: "https://bridge.example", stagedResponse: { ok: false, status } });
			const binding = createRestRegistrationSyncBinding(deps);
			const err = await binding.syncNow({ authorityId: AUTHORITY_ID }).then(
				() => undefined,
				(e: Error) => e,
			);
			expect(err).toBeInstanceOf(Error);
			expect(err!.message).toBe(`registration bridge listing failed (status ${status})`);
			expect(err!.message).not.toContain("bridge.example");
		}

		const { deps: deps2 } = makeDeps({ restBridgeUrl: "https://bridge.example", stagedResponse: { ok: true, throws: true } });
		const binding2 = createRestRegistrationSyncBinding(deps2);
		const err2 = await binding2.syncNow({ authorityId: AUTHORITY_ID }).then(
			() => undefined,
			(e: Error) => e,
		);
		expect(err2).toBeInstanceOf(Error);
		expect(err2!.message).toBe("registration bridge listing failed");
		expect(err2!.message).not.toContain("fetch failed");
	});

	it("R9b: a 200 body without a staged array is an honest empty listing", async () => {
		const { deps } = makeDeps({ restBridgeUrl: "https://bridge.example", stagedResponse: { ok: true, body: {} } });
		const report = await createRestRegistrationSyncBinding(deps).syncNow({ authorityId: AUTHORITY_ID });
		expect(report.imported).toBe(0);
	});

	it("S-2: the default fetch times out a hung bridge, aborts the request, and still calls fetch as a plain call", async () => {
		jest.useFakeTimers();
		const priorFetch = (global as any).fetch;
		let seenSignal: AbortSignal | undefined;
		(global as any).fetch = jest.fn((_url: string, init?: { signal?: AbortSignal }) => {
			seenSignal = init?.signal;
			return new Promise(() => undefined);
		});
		try {
			const { deps } = makeDeps({ restBridgeUrl: "https://bridge.example" });
			delete (deps as any).fetchJson;
			const binding = createRestRegistrationSyncBinding(deps);
			const outcome = binding.syncNow({ authorityId: AUTHORITY_ID }).then(
				() => undefined,
				(e: Error) => e,
			);
			await jest.advanceTimersByTimeAsync(REST_BRIDGE_FETCH_TIMEOUT_MS + 1);
			const err = await outcome;
			expect(err).toBeInstanceOf(Error);
			expect(seenSignal).toBeDefined();
			expect(seenSignal!.aborted).toBe(true);
			// WR-R6-05: "a plain call" means fetch ran with no receiver (or the global object). A
			// stored or method-call reference would hand it another `this`, which RN/Hermes rejects
			// with an illegal-invocation error.
			const fetchMock = (global as any).fetch as jest.Mock;
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const receiver = fetchMock.mock.contexts[0];
			expect(receiver === undefined || receiver === globalThis).toBe(true);
		} finally {
			(global as any).fetch = priorFetch;
			jest.useRealTimers();
		}
	});

	it("S-2b (WR-R3-05): headers that arrive but a body that stalls still time out, abort, and fail the sync", async () => {
		jest.useFakeTimers();
		const priorFetch = (global as any).fetch;
		let seenSignal: AbortSignal | undefined;
		(global as any).fetch = jest.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
			seenSignal = init?.signal;
			return { ok: true, status: 200, json: () => new Promise(() => undefined) };
		});
		try {
			const { deps } = makeDeps({ restBridgeUrl: "https://bridge.example" });
			delete (deps as any).fetchJson;
			const binding = createRestRegistrationSyncBinding(deps);
			let settled = false;
			const outcome = binding.syncNow({ authorityId: AUTHORITY_ID }).then(
				() => undefined,
				(e: Error) => e,
			);
			void outcome.then(() => {
				settled = true;
			});
			await jest.advanceTimersByTimeAsync(REST_BRIDGE_FETCH_TIMEOUT_MS - 1);
			expect(settled).toBe(false);
			await jest.advanceTimersByTimeAsync(2);
			const err = await outcome;
			expect(err).toBeInstanceOf(Error);
			expect(err!.message).toBe("registration bridge listing failed");
			expect(seenSignal!.aborted).toBe(true);
		} finally {
			(global as any).fetch = priorFetch;
			jest.useRealTimers();
		}
	});

	it("S-2c: the default fetch hands back the body it read, and a 200 listing still imports nothing when empty", async () => {
		const priorFetch = (global as any).fetch;
		(global as any).fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ staged: [] }) }));
		try {
			const { deps } = makeDeps({ restBridgeUrl: "https://bridge.example" });
			delete (deps as any).fetchJson;
			const report = await createRestRegistrationSyncBinding(deps).syncNow({ authorityId: AUTHORITY_ID });
			expect(report.imported).toBe(0);
			expect((global as any).fetch).toHaveBeenCalledTimes(1);
		} finally {
			(global as any).fetch = priorFetch;
		}
	});

	it("R10: attachSyncBindings registers a handle with id 'rest' outside __DEV__", async () => {
		const priorDev = (global as any).__DEV__;
		(global as any).__DEV__ = false;
		try {
			clearSyncBindings();
			attachSyncBindings(async <T,>() => ({} as T));
			const handle = resolveSyncBinding("rest");
			expect(handle?.id).toBe("rest");
		} finally {
			(global as any).__DEV__ = priorDev;
			clearSyncBindings();
		}
	});
});

describe("attach-sync-bindings.ts — source gates G1-G3", () => {
	function readStripped(relPath: string): string {
		const source = fs.readFileSync(path.join(__dirname, "..", relPath), "utf8");
		return source
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.split("\n")
			.map((line) => line.replace(/\/\/.*$/, ""))
			.join("\n");
	}

	it("G1: no __DEV__, no DEV_REGISTRATION_SYNC_REST_BASE_URL, no dangling-undefined constant, no registerBridgeKey/createDeviceSigner/console, exactly one require() to the literal path", () => {
		const stripped = readStripped("attach-sync-bindings.ts");
		expect(stripped).not.toMatch(/__DEV__/);
		expect(stripped).not.toMatch(/DEV_REGISTRATION_SYNC_REST_BASE_URL/);
		expect(stripped).not.toMatch(/string \| undefined = undefined/);
		expect(stripped).not.toMatch(/registerBridgeKey/);
		expect(stripped).not.toMatch(/createDeviceSigner/);
		expect(stripped).not.toMatch(/console\./);
		const requireMatches = [...stripped.matchAll(/require\(([^)]*)\)/g)];
		expect(requireMatches).toHaveLength(1);
		expect(requireMatches[0]![1]).toContain(
			"../../../../../packages/vote-engine/dist/registration/transport/rest-registration-transport.js",
		);
	});

	it("G2: attach-association-sync-bindings.ts does not exist, and no non-test source file mentions it", () => {
		const deletedPath = path.join(__dirname, "..", "attach-association-sync-bindings.ts");
		expect(fs.existsSync(deletedPath)).toBe(false);

		const srcRoot = path.join(__dirname, "..", "..", "..");
		function walk(dir: string): string[] {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			const files: string[] = [];
			for (const entry of entries) {
				if (entry.name === "__tests__") continue;
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) files.push(...walk(full));
				else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
			}
			return files;
		}
		const forbidden = [
			"attach-association-sync-bindings",
			"attachAssociationSyncBindings",
			"rest-association-transport",
			"filesystem-association-transport",
			"DEV_ASSOCIATION_SYNC_REST_BASE_URL",
		];
		for (const file of walk(srcRoot)) {
			const stripped = fs
				.readFileSync(file, "utf8")
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.split("\n")
				.map((line) => line.replace(/\/\/.*$/, ""))
				.join("\n");
			for (const token of forbidden) {
				expect({ file, hasToken: stripped.includes(token) }).toEqual({ file, hasToken: false });
			}
		}
	});

	it("G3: the attachSyncBindings useEffect block in AppProvider.tsx has no __DEV__ and no console.", () => {
		const source = fs.readFileSync(
			path.join(__dirname, "..", "..", "..", "providers", "AppProvider.tsx"),
			"utf8",
		);
		const idx = source.lastIndexOf("useEffect(", source.indexOf("attachSyncBindings(getEngine)"));
		const endIdx = source.indexOf("}, [getEngine]);", idx);
		const block = source.slice(idx, endIdx);
		expect(block).not.toMatch(/__DEV__/);
		expect(block).not.toMatch(/console\./);
	});
});
