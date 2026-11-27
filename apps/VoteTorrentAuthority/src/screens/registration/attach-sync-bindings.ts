import { registerSyncBinding, type SyncBindingHandle, type TransportSyncReport } from "./bulk-import-sync-model";
// The one VALUE import this file takes from `@votetorrent/vote-engine` by bare specifier — the
// `./rn` subpath IS one of the two entries the package's `exports` map allows (the other is `.`),
// so this is NOT the blocked-deep-subpath case the comment below describes; `AppProvider.tsx`
// already imports from the same `/rn` entry statically (`LocalStorageReact`). A plain string
// constant with no transitive runtime dependency of its own.
import { REGISTRATION_DUPLICATE_CLOSED_REASON, isValidRestBridgeUrl } from "@votetorrent/vote-engine/rn";
// Deep RELATIVE filesystem import — deliberately NOT a "@votetorrent/vote-engine" bare package
// specifier. @votetorrent/vote-engine's package.json "exports" map lists only "." and "./rn";
// Metro runs with unstable_enablePackageExports: true (metro.config.js), so any bare-specifier
// deep subpath (e.g. "@votetorrent/vote-engine/dist/registration/transport/...") is BLOCKED by
// that map in both Metro and Jest (jest.config.js's own moduleNameMapper comment confirms:
// "The package exports field blocks subpath access"). A literal RELATIVE path bypasses "exports"
// entirely — that field governs bare-specifier package-name resolution only, never a relative
// import — and this exact target was verified module-by-module to contain zero runtime
// node:fs/node:http/other-Node-builtin references: rest-registration-transport.js -> utils.js ->
// database/initialize.js -> database/schema-sql.js + database/tid-allocator.js. schema-sql.js's
// own header states it is "Bundled so initDB never needs Node fs / import.meta (Hermes cannot
// parse import.meta)"; its lone "fs" occurrence is inside a code-generation COMMENT describing how
// the file was regenerated, not a runtime import.
//
// D-29 (62-25), superseding WR-17's build-time gate: through 62-24 this loader was additionally
// `__DEV__`-gated, because the bridge target was a hardcoded, un-shippable constant — a one-line
// edit to that constant was all it took to turn a release build into a live outbound sync client
// (48-32's commit 70c40b7, reverted by 4c1b231). That hazard is now closed a different way: the
// bridge target comes ONLY from the signed, replicated `AuthorityIntakePolicy` a `'vrg'` officer
// sets through a schema ceremony (`registration-bridge-config.ts`), re-validated https at every
// sync (see `syncNow` below). There is no longer a source-editable constant to protect, so the
// `__DEV__` gate is removed from both this loader and `attachSyncBindings` — a shipped build now
// loads this transport unconditionally, the same way 62-22 made the Voter's REST path unconditional.
// The require keeps a LITERAL path string: Metro cannot resolve a computed specifier, and a
// resolution failure must stay a loud build-time error rather than becoming a silent runtime one.
// It stays `require` rather than a dynamic `import()` because this attachment must remain
// synchronous (`attachSyncBindings` returns `void` and is called from a `useEffect`).
type RestRegistrationTransportCtor = new (options: { baseUrl: string }) => {
	pollDecisions(sinceCursor?: string): Promise<unknown[]>;
};

function loadRestRegistrationTransport(): RestRegistrationTransportCtor {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	return require("../../../../../packages/vote-engine/dist/registration/transport/rest-registration-transport.js")
		.RestRegistrationTransport as RestRegistrationTransportCtor;
}

/**
 * attach-sync-bindings.ts — the production registration REST bridge (D-29, Phase 62 Plan 25).
 *
 * This file is the RN-side attachment site `bulk-import-sync-model.ts` (48-20) deliberately did
 * NOT own: it constructs the REST-constructible binding (`RestRegistrationTransport`, 48-10) and
 * registers it into `registerSyncBinding('rest', ...)` so the device leg's "Sync Now" is a real
 * network call, never a simulation.
 *
 * D-29: the bridge is now a PRODUCTION option. `syncNow` reads the bridge target from the
 * replicated, signed `AuthorityIntakePolicy` at the START of every sync (never cached across
 * syncs) through `IntakeEngine.readIntakePolicy`, so every officer device and the Voter (62-22)
 * read the same value. A build with no saved URL simply refuses before any network call — see
 * `RestBridgeConfigCard`'s own doc comment for the officer-facing side of this contract.
 *
 * THE AUTHORITY-SIDE BRIDGE CONTRACT this file reads and writes (a throwaway dev bridge in this
 * tree, `scripts/device-proof/association-rest-bridge.mjs`, serves it for device-proof sessions;
 * a production bridge implements the SAME shape):
 *   - `GET {url}/staged-requests` -> `{ staged: StagedRequestJson[] }`. A `bridgeKeys` member, if
 *     present, is IGNORED — see the no-provisioning note below.
 *   - `GET {url}/registration-decisions` via `RestRegistrationTransport.pollDecisions()` — the
 *     locked R-3 wire format, each notice `{ requestId, status, reason?, decidedAt, cursor }`.
 *   - `POST {url}/registration-decisions` with `{ requestId, status, reason?, decidedAt }` — so a
 *     REST-route voter (62-22) can learn the authority's decision the same way a peer-route voter
 *     reads it off the strand.
 *
 * WHAT THIS FILE MUST NEVER DO (each load-bearing, each mechanically gated):
 *   - Never import `filesystem-registration-transport` (48-09) — that module imports
 *     `node:fs/promises` and is deliberately unreachable from the RN bundle (Phase 44's `@peculiar`
 *     device-boot wall cost two plans to unstick; jest is structurally blind to this class of
 *     failure because jest runs on Node, where the import resolves fine).
 *   - Never register a `'peer'` id at this seam — that severance belongs to 48-20/48-23/62-21 and
 *     this file does not spend it.
 *   - Never auto-provision a `RegistrationBridgeKey` from a bridge listing (T-62-25-02). Through
 *     62-24 this file provisioned any bridge key a listing named, signed by the device's own
 *     unattended local signer — an unattended officer signature over a key NAMED BY A REMOTE
 *     SERVER is a silent trust grant, not a legitimate provisioning path. That loop is deleted:
 *     bridge-issued documents now intake only when their key was registered by another path (the
 *     `'vrg'` ceremony), and fail their `BridgeIdValid` CHECK otherwise — reported by id, never by
 *     message text.
 *
 * THE INTAKE PATTERN this file implements for REST mirrors, field for field, the pattern
 * `filesystem-registration-transport.ts`'s own `IRegistrationRequestIntake.readStagedRequests` doc
 * comment already documents for the filesystem binding: "hand each result to
 * `RegistrationEngine.submitRegistrationRequest(doc.init, doc.requesterKey, doc.signature)` —
 * passing the already-resolved Signature, never a callback, because the authority does not hold
 * and must never hold the requester's key." `RestRegistrationTransport` implements only the
 * SUBMITTER-facing `IRegistrationRequestTransport` (submitRequest/pollDecisions) — it declares no
 * authority-side intake interface of its own (48-10 left that gap open). This file bridges that
 * gap with a small, NON-locked-protocol listing fetch (`GET {baseUrl}/staged-requests`), then
 * applies the SAME documented hand-off to the local engine.
 */

/** Identifier shape accepted from a bridge listing (and from a notice's own echoed requestId).
 * Anything else is untrusted, hostile-shaped text and is dropped silently rather than ever
 * reaching `errorItemIds` (T-62-25-04). */
export const REST_SYNC_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** The shape the bridge's `GET /staged-requests` response carries per document — a superset of
 * what this file reads is tolerated (unused keys are ignored), never a subset. */
interface StagedRequestJson {
	requestId: unknown;
	init: unknown;
	requesterKey: unknown;
	signature: unknown;
}

/** The minimal local structural type this file needs from `IRegistrationEngine` — declared here
 * rather than imported from `@votetorrent/vote-engine`, so this file's only vote-engine imports
 * stay the one deep relative path documented above and the `/rn` entry. Type-only imports from `@votetorrent/vote-core`
 * are fine (erased at build time; they never pull the package's runtime code into the bundle). */
interface RegistrationIntakeEngine {
	getRegistrationRequest(
		requestId: string,
	): Promise<{ status: string; decidedAt?: string; rejectionReason?: string } | undefined>;
	submitRegistrationRequest(init: unknown, requesterKey: string, signature: unknown): Promise<string>;
	getDuplicateClosure(
		requestId: string,
	): Promise<{ requestId: string; state: "closed" | "closing"; closedAt?: string } | undefined>;
}

/** The minimal local structural type this file needs from `IntakeEngine`. */
interface IntakePolicyReader {
	readIntakePolicy(authorityId: string): Promise<{ restBridgeUrl: string | null }>;
}

export interface RestRegistrationSyncDeps {
	getEngine: <T>(engineName: string) => Promise<T>;
	loadTransport?: () => RestRegistrationTransportCtor;
	/** The default calls the global `fetch` as a plain call — never a stored, unbound
	 * `globalThis.fetch` reference (an RN runtime rebinds `fetch`'s own `this`, so a destructured
	 * reference is unsafe), with a JSON content-type set on every POST. */
	fetchJson?: (
		url: string,
		init?: { method: "GET" | "POST"; body?: string },
	) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
}

/** A bridge that never answers must not leave the card "syncing" forever (initial/G3 WR-03). The
 * deadline covers the whole exchange: the response headers AND the body (WR-R3-05), so a bridge that
 * sends headers and then stalls the body still fails the sync. */
export const REST_BRIDGE_FETCH_TIMEOUT_MS = 15_000;

const DEFAULT_FETCH_JSON: NonNullable<RestRegistrationSyncDeps["fetchJson"]> = async (url, init) => {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new Error("registration bridge request timed out"));
		}, REST_BRIDGE_FETCH_TIMEOUT_MS);
	});
	try {
		const request =
			init?.method === "POST"
				? fetch(url, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: init.body,
						signal: controller.signal,
					})
				: fetch(url, { signal: controller.signal });
		// The body is read under the same deadline, before the timer is cleared: the caller's `json()`
		// then returns the already-read body and can never hang on a stalled stream.
		const exchange = (async () => {
			const res = await request;
			let body: { value: unknown } | { error: unknown };
			try {
				body = { value: await res.json() };
			} catch (error) {
				// A non-JSON body (an error page, an empty 204) only matters if the caller reads it.
				body = { error };
			}
			return {
				ok: res.ok,
				status: res.status,
				json: async () => {
					if ("error" in body) throw body.error;
					return body.value;
				},
			};
		})();
		// Swallow a late rejection of the losing branch (the abort rejects the request itself).
		exchange.catch(() => undefined);
		return await Promise.race([exchange, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
};

/** A bridge-reported decision notice, as read back from `pollDecisions()` (R-3 wire format). */
interface BridgeNotice {
	requestId?: unknown;
}

function isNonEmptyAuthorityId(authorityId: unknown): authorityId is string {
	return typeof authorityId === "string" && authorityId.length > 0;
}

function isValidStagedDoc(doc: unknown): doc is { requestId: string; init: { id: string; authorityId?: string } } {
	if (typeof doc !== "object" || doc === null) return false;
	const d = doc as StagedRequestJson;
	if (typeof d.requestId !== "string" || !REST_SYNC_REQUEST_ID_PATTERN.test(d.requestId)) return false;
	if (typeof d.init !== "object" || d.init === null) return false;
	const init = d.init as { id?: unknown };
	return typeof init.id === "string" && init.id === d.requestId;
}

export function createRestRegistrationSyncBinding(deps: RestRegistrationSyncDeps): SyncBindingHandle {
	const fetchJson = deps.fetchJson ?? DEFAULT_FETCH_JSON;

	return {
		id: "rest",
		syncNow: async (context): Promise<TransportSyncReport> => {
			const authorityId = context?.authorityId;
			if (!isNonEmptyAuthorityId(authorityId)) {
				throw new Error("rest sync requires an authority");
			}

			const intake = await deps.getEngine<IntakePolicyReader>("intake");
			const policy = await intake.readIntakePolicy(authorityId);
			const url = policy.restBridgeUrl;
			if (url === null || !isValidRestBridgeUrl(url)) {
				throw new Error("no registration bridge URL is configured");
			}

			const RestRegistrationTransport = (deps.loadTransport ?? loadRestRegistrationTransport)();
			const transport = new RestRegistrationTransport({ baseUrl: url });

			let noticesKnown = true;
			let notices: BridgeNotice[] = [];
			try {
				notices = (await transport.pollDecisions()) as BridgeNotice[];
			} catch {
				noticesKnown = false;
			}
			const posted = new Set(
				notices
					.map((n) => n.requestId)
					.filter((id): id is string => typeof id === "string"),
			);

			// A listing that throws, times out or answers non-2xx is a FAILED sync, never an honest
			// empty batch (initial/G3 WR-03). Messages are fixed strings carrying at most the numeric
			// status — never the URL, a body or engine text.
			let staged: unknown[] = [];
			let res: { ok: boolean; status: number; json: () => Promise<unknown> };
			try {
				res = await fetchJson(`${url}/staged-requests`);
			} catch {
				throw new Error("registration bridge listing failed");
			}
			if (!res.ok) {
				throw new Error(`registration bridge listing failed (status ${res.status})`);
			}
			try {
				const body = (await res.json()) as { staged?: unknown };
				if (Array.isArray(body.staged)) staged = body.staged;
			} catch {
				throw new Error("registration bridge listing failed");
			}

			const engine = await deps.getEngine<RegistrationIntakeEngine>("registration");
			const errorItemIds = new Set<string>();
			let imported = 0;

			const acceptedDocs: { requestId: string; init: { id: string; authorityId?: string } }[] = [];
			for (const raw of staged) {
				if (!isValidStagedDoc(raw)) continue; // untrusted shape — skip silently (T-62-25-04)
				if (raw.init.authorityId !== authorityId) continue;
				acceptedDocs.push(raw);

				const existing = await engine.getRegistrationRequest(raw.requestId);
				if (existing) continue;

				const d = raw as unknown as StagedRequestJson;
				if (typeof d.requesterKey !== "string" || typeof d.signature !== "object" || d.signature === null) {
					errorItemIds.add(raw.requestId);
					continue;
				}
				try {
					await engine.submitRegistrationRequest(d.init, d.requesterKey, d.signature);
					imported += 1;
				} catch {
					errorItemIds.add(raw.requestId);
				}
			}

			let pending = 0;
			for (const doc of acceptedDocs) {
				if (posted.has(doc.requestId)) continue;
				if (!noticesKnown) {
					// Cannot tell what the bridge already knows — count, never post.
					const local = await engine.getRegistrationRequest(doc.requestId);
					if (local && (local.status === "a" || local.status === "r") && local.decidedAt !== undefined) {
						pending += 1;
					}
					continue;
				}

				const local = await engine.getRegistrationRequest(doc.requestId);
				let body: { requestId: string; status: "a" | "r"; reason?: string; decidedAt: string } | undefined;
				if (local && (local.status === "a" || local.status === "r") && local.decidedAt !== undefined) {
					body = {
						requestId: doc.requestId,
						status: local.status as "a" | "r",
						...(local.status === "r" ? { reason: local.rejectionReason } : {}),
						decidedAt: local.decidedAt,
					};
				} else if (!local || local.status === "p") {
					const closure = await engine.getDuplicateClosure(doc.requestId);
					if (closure && closure.state === "closed" && closure.closedAt !== undefined) {
						body = {
							requestId: doc.requestId,
							status: "r",
							reason: REGISTRATION_DUPLICATE_CLOSED_REASON,
							decidedAt: closure.closedAt,
						};
					}
				}

				if (!body) continue;

				try {
					const res = await fetchJson(`${url}/registration-decisions`, {
						method: "POST",
						body: JSON.stringify(body),
					});
					if (!res.ok) errorItemIds.add(doc.requestId);
				} catch {
					errorItemIds.add(doc.requestId);
				}
			}

			if (!noticesKnown) {
				// No further "still not local" counting needed — the loop above already folded the
				// decided-but-unposted set into pending.
			} else {
				for (const doc of acceptedDocs) {
					if (!(await engine.getRegistrationRequest(doc.requestId))) pending += 1;
				}
			}

			return {
				syncedAt: new Date().toISOString(),
				imported,
				pending,
				errorItemIds: [...errorItemIds],
			};
		},
	};
}

/**
 * Attaches the REST sync binding. Called exactly once from `AppProvider.tsx`, at the point
 * engines become available. `getEngine` is the app's existing engine-factory accessor
 * (`useApp().getEngine`) — this file never constructs or imports an engine class directly.
 *
 * D-29: attached unconditionally, in every build. The binding is inert — `syncNow` refuses
 * before any network call — until an officer with `'vrg'` saves an https bridge URL.
 */
export function attachSyncBindings(getEngine: <T>(engineName: string) => Promise<T>): void {
	registerSyncBinding(createRestRegistrationSyncBinding({ getEngine }));
}
