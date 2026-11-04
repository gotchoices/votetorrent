import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import type { PropsWithChildren } from "react";
import type { INetworksEngine, IDefaultUserEngine, NetworkReference, User } from "@votetorrent/vote-core";
import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";
import { useTranslation } from "react-i18next";
import { hideSplash } from "react-native-splash-view";
import { EngineFactory } from "../engines/engine-factory";
import type { PeerStagingTransports } from "../engines/engine-factory";
import { LocalStorageReact, UserEngine } from "@votetorrent/vote-engine/rn";
import type { StagingOpener, StagingDecisionSigner } from "@votetorrent/vote-engine/rn";
import { rnDbFactory } from "../engines/rn-db-factory";
import { getOrCreateDeviceUser } from "../engines/device-user";
import { createDeviceSigner, type SignCallback } from "../engines/device-signer";
import {
	repairDeviceIdentityForkIfNeeded,
	rollbackDeviceIdentityRepair,
	type OtherNetworkAnswer,
} from "../engines/device-identity-repair";
import { maybeSeedRegistrantFixtures } from "../engines/registrant-dev-seed";
import { classifyPeerReadFailure } from "../engines/peer-read-unavailable";
import { attachSyncBindings } from "../screens/registration/attach-sync-bindings";
import { attachPeerSyncBinding } from "../screens/registration/attach-peer-sync-binding";
import { sweepRetiredDashboardCodeStorage } from "../engines/retired-dashboard-code-storage";
import { useCadreNode, type CadreNodeSettlement } from "./CadreNodeProvider";

interface AppContextType {
	networksEngine?: INetworksEngine;
	getEngine: <T>(engineName: string, initParams?: any) => Promise<T>;
	hasEngine: (engineName: string) => boolean;
	/**
	 * D-09: the device-attestation capability probe (bare boolean — no ctx, no
	 * network, no data). Consumed by 47-16's inline banner and 47-19's
	 * AttestationProvisioningStatusScreen so neither has to reach past the
	 * context boundary into EngineFactory directly.
	 */
	isAttestationVerifierProvisioned: () => boolean;
	isInitialized: boolean;
	hasNetwork: boolean;
	/**
	 * Make `networkRef` the active/current network for this session WITHOUT requiring
	 * an app restart. Mirrors the boot re-attach: bind the device user, open the network
	 * (cache-first — safe for a just-created or a recent network), re-point the engine
	 * factory, and flip `hasNetwork` so gated screens (Elections/Authorities) render.
	 * Previously selection only took effect on the next boot (hasNetwork was set only in
	 * the init effect), so a freshly-created or just-selected network appeared "not selected".
	 */
	selectNetwork: (networkRef: NetworkReference) => Promise<void>;
	/**
	 * LIVE answer to "does this session have a selected network right now?" -- read from a ref,
	 * so a caller holding a stale context value (a screen that has since unmounted, such as Add
	 * Network finishing a slow create) still gets the current truth. `hasNetwork` itself is a
	 * render-time snapshot and cannot answer that.
	 */
	isNetworkSelected: () => boolean;
	/**
	 * 62-21 (D-04/D-28): resolves the Authority's hardware-backed device `SignCallback` ON DEMAND.
	 * The SAME lazy-factory-thunk class already established by the `maybeSeedRegistrantFixtures`
	 * argument in the init effect below — calling it reads the device key and may prompt, so it is
	 * NEVER invoked by the provider itself, only passed down for a user-initiated signing action
	 * (enable encrypted intake, a peer sync's decision publishing) to resolve when it actually
	 * needs to sign. This is what keeps `AppProvider.tsx` — already exempt from the device-signing
	 * rollout inventory for exactly this reason — the only provider-level invoker, so 62-21 adds no
	 * new one.
	 */
	resolveDeviceSigner: () => Promise<SignCallback>;
	/**
	 * 62-27 (D-41/D-44/D-45): screens open the peer staging transports through this passthrough
	 * (an officer reviewing a device change, a decide-time registration publish), mirroring
	 * `isAttestationVerifierProvisioned`'s factory-ref passthrough shape. It holds no key material:
	 * the caller supplies the opener and the decision signer. Throws 62-21's `PeerStrandUnavailableError` when the
	 * established network cannot back a peer strand. Optional so existing `useApp` fakes stay valid.
	 */
	createPeerStagingTransports?: (deps: {
		opener: StagingOpener;
		decisionSigner: StagingDecisionSigner;
	}) => PeerStagingTransports;
}

const AppContext = createContext<AppContextType | null>(null);

export function useApp() {
	const context = useContext(AppContext);
	if (!context) {
		throw new Error("useApp must be used within an AppProvider");
	}
	return context;
}

// ---------------------------------------------------------------------------
// D-09 / RESEARCH Open Question 2: the cold-start re-attach race is REMOVED,
// not survived. Before this plan, the init effect called
// `factory.setNode(node)` with whatever `node` happened to be on the
// CURRENT render — on cold start that is unconditionally `null` on the
// FIRST render, because CadreNode.start() is async and has not resolved
// yet. That guaranteed first attempt at `node === null` routes to
// `rnDbFactory` and dies at `networks-engine.ts`'s `isSchemaInitialized`
// gate. Adding `node` to the effect's dependency array papered over the
// race with an implicit SECOND attempt once the boot completed — but
// nothing distinguished "still booting" from "boot already failed", both
// of which present identically as `node === null` forever, so a failed
// boot left the app re-attempting on `rnDbFactory` and never noticing.
//
// The fix awaits `CadreNodeProvider`'s `nodeSettled` (D-08) BEFORE the
// first `factory.setNode(...)`, so the unconditional first attempt at
// `node === null` never runs at all — there is exactly one dispatch,
// against the backend actually settled on.
//
// Open Question 2 — does the await need its own timeout? YES, and this is
// the answer, not a retry knob: `nodeSettled` awaited unbounded would be a
// NEW availability defect — a hung `CadreNode.start()` would strand the
// officer on the splash screen forever, with no error view and therefore
// no Try Again (T-58-05-02). `NODE_SETTLE_TIMEOUT_MS` bounds the wait;
// the loser of the race RESOLVES to a `'timeout'` status (never rejects),
// so a merely-slow boot degrades to the solo backend instead of surfacing
// "Failed to load network" — a worse outcome than attempting solo. 15000ms
// is three orders above the sub-second solo boot (`.start()` does not
// block on peer discovery) and one third of `AddNetworkScreen.tsx`'s
// `CREATE_TIMEOUT_MS = 45000` — the tolerance already applied to a
// user-initiated wait; a passive cold-start wait must be shorter. This
// value is a liveness ceiling chosen from reasoning, not a device
// measurement — 58-08's D-08 re-measure should record the real settle
// duration so it can be revisited with a number.
//
// D-09 also rejects bounded RETRY (`loadAuthoritiesWithRetry.ts` is
// deliberately not reused here): retrying re-attempts the SAME ambiguous
// signal this plan removes, it does not resolve it.
//
// Device measurements since (2026-10-15): 16957 ms (Redmi 8, after a control-store
// recreate) and 24387 ms (Pixel_8_p63 relaunch) — the timer itself fires late on a
// starved JS thread, and cadre-core's first relay reservation alone may take 18 s
// (`relayReservationBudgetMs`). The bound is kept: it still only decides when the UI
// stops waiting. What changed is that a timed-out run no longer treats the timeout as
// final — the init effect re-runs once on the LATE settlement (see LATE SETTLE below),
// which reacts to the definitive signal rather than retrying the ambiguous one.
// ---------------------------------------------------------------------------
const NODE_SETTLE_TIMEOUT_MS = 15000;

type NodeDispatchStatus = "ready" | "failed" | "timeout" | "unavailable";

interface NodeDispatch {
	status: NodeDispatchStatus;
	node: CadreNodeSettlement["node"];
}

/**
 * Bounded settle-then-dispatch helper (D-09 / Open Question 2). Races
 * `nodeSettled` against `timeoutMs` and NEVER rejects: `'ready'` carries the
 * live node (strand dispatch is correct); every other status
 * (`'failed'` | `'timeout'` | `'unavailable'`) carries `null` (solo dispatch
 * is correct). `'unavailable'` covers a missing/non-thenable `nodeSettled` —
 * conservative direction, and it keeps any existing consumer that mocks
 * `useCadreNode()` without the new field working rather than throwing on
 * `settled.status`.
 */
async function resolveNodeDispatch(
	nodeSettled: Promise<CadreNodeSettlement> | undefined,
	timeoutMs: number
): Promise<NodeDispatch> {
	if (!nodeSettled || typeof (nodeSettled as { then?: unknown }).then !== "function") {
		return { status: "unavailable", node: null };
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const winner = await Promise.race([
			nodeSettled.then((settlement): NodeDispatch => ({ status: settlement.status, node: settlement.node })),
			new Promise<NodeDispatch>((resolve) => {
				timer = setTimeout(() => resolve({ status: "timeout", node: null }), timeoutMs);
			}),
		]);
		return winner;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

type BootError = { kind: "peer-unavailable"; reason: string } | { kind: "generic" } | null;

// Automatic re-open delays after a peer-unavailable failure (5 s, then 15 s). This covers
// short blips only: FRET marks a restored silent peer dead after 3 contact failures, but each
// probe dial can take up to the libp2p dial timeout with backoff up to 32 s, so a long outage
// takes minutes. It is deliberately NOT widened to minutes: the officer would sit on a spinner
// with no explanation; the classified error view with Try Again is the path for the long case.
const PEER_RETRY_DELAYS_MS = [5000, 15000];

/**
 * WR-R4-04: how long boot / select waits for the identity repair's READS (the inspection and the
 * other-network checks, which on a joiner can go through an unreachable cohort for minutes). Past
 * it the caller goes on without the repair and the repair is abandoned before it writes anything;
 * it is attempted again on the next boot. A repair that has already started writing is waited for,
 * because its re-bind or rollback must finish before the session goes on.
 */
export const IDENTITY_REPAIR_BUDGET_MS = 5000;

/**
 * O-06: after the network is open, repair a device identity forked by the old Replace Signing Key.
 * Returns the repaired user (already bound into the factory, the network re-opened with it and the
 * cached engines rebuilt), or `undefined` when nothing changed. Never throws. Bounded by
 * `IDENTITY_REPAIR_BUDGET_MS`, and abandoned before any write once `isCancelled()` is true.
 *
 * Cache handling (read from engine-factory.ts / networks-engine.ts): `NetworksEngine.open` is
 * cache-first but rewrites the cached ctx with the supplied user, so re-opening with the repaired
 * user re-points ctx.user for every sibling reading the established context. The factory's cached
 * 'network' / 'user' / ... engines captured the OLD user, so `clearEngineCache()` (its existing
 * public API) drops them and `getEngine("network", ref)` rebuilds against the repaired user.
 */
async function repairForkedIdentityAfterOpen(
	factory: EngineFactory,
	network: NetworkReference,
	user: User,
	isCancelled: () => boolean = () => false,
): Promise<User | undefined> {
	let expired = false;
	let committed = false;
	const shouldPersist = (): boolean => {
		if (expired || isCancelled()) return false;
		committed = true;
		return true;
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const budget = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => {
			if (committed) return;
			expired = true;
			console.info("[identity-repair] outcome=budget-elapsed");
			resolve(undefined);
		}, IDENTITY_REPAIR_BUDGET_MS);
	});
	try {
		return await Promise.race([runForkedIdentityRepair(factory, network, user, shouldPersist), budget]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function runForkedIdentityRepair(
	factory: EngineFactory,
	network: NetworkReference,
	user: User,
	shouldPersist: () => boolean,
): Promise<User | undefined> {
	try {
		const networksEng = factory.getNetworksEngine();
		const otherNetworkHasUser = async (userId: string): Promise<OtherNetworkAnswer> => {
			const others = (await networksEng.getRecentNetworks()).filter((n) => n.hash !== network.hash);
			if (others.length === 0) return "no";
			let unknown = false;
			for (const other of others) {
				const otherCtx = networksEng.getEstablishedContext(other.hash);
				// Not open in this process: cannot be checked without starting its strand -> fail safe.
				if (!otherCtx) {
					unknown = true;
					continue;
				}
				const row = await otherCtx.db.prepare("select 1 as found from User where Id = :id").get({ id: userId });
				if (row != null) return "yes";
			}
			return unknown ? "unknown" : "no";
		};
		const result = await repairDeviceIdentityForkIfNeeded({
			deviceUser: user,
			getUserEngineForCurrentUser: async () => {
				const ctx = networksEng.getEstablishedContext(network.hash);
				return ctx ? new UserEngine(user, ctx) : undefined;
			},
			otherNetworkHasUser,
			shouldPersist,
		});
		if (result.outcome !== "repaired" || !result.user) return undefined;
		const repaired = result.user;
		try {
			factory.setCurrentUser(repaired);
			await networksEng.open(network, repaired);
			factory.clearEngineCache();
			await factory.getEngine("network", network);
			return repaired;
		} catch {
			// WR-R4-03: the new id is already stored, but the session could not be re-bound to it.
			// Put storage, the factory, the network ctx and the engine cache back on the old id so
			// the session never signs as one user while its engines act as another.
			console.warn("[identity-repair] outcome=rebind-failed");
			await rollbackDeviceIdentityRepair({ fromUserId: user.id, toUserId: repaired.id });
			factory.setCurrentUser(user);
			factory.clearEngineCache();
			try {
				await networksEng.open(network, user);
				await factory.getEngine("network", network);
			} catch {
				console.warn("[identity-repair] outcome=rebind-restore-failed");
			}
			return undefined;
		}
	} catch {
		console.warn("[identity-repair] outcome=failed");
		return undefined;
	}
}

export function AppProvider({ children }: PropsWithChildren) {
	const { t } = useTranslation();
	const [isInitialized, setIsInitialized] = useState(false);
	const [hasNetwork, setHasNetworkState] = useState(false);
	// Ref mirror of hasNetwork for isNetworkSelected(); updated in the same call as the state.
	const hasNetworkRef = useRef(false);
	const setHasNetwork = useCallback((value: boolean) => {
		hasNetworkRef.current = value;
		setHasNetworkState(value);
	}, []);
	const isNetworkSelected = useCallback(() => hasNetworkRef.current, []);
	const [networksEngine, setNetworksEngine] = useState<INetworksEngine | null>(null);
	// Classified boot failure. The raw error object (engine messages carry block ids and
	// table names) never reaches state or render; only the closed kind does.
	const [initError, setInitError] = useState<BootError>(null);
	// CR-02: bump this to re-run the init effect (Try Again). The init effect's
	// dep array is [initNonce]; setIsInitialized(false) alone cannot re-fire it.
	const [initNonce, setInitNonce] = useState(0);
	// Quick task 260928-kkf ("Syncing + escape button", locked decision): flips true
	// once the CURRENT boot's first-sync wait has rejected once with
	// StrandAwaitingFirstSyncError (~300s budget elapsed) — the signal that gates the
	// Start Fresh escape under the Syncing label. Reset to false at the start of every
	// non-cancelled init run (see the [initNonce] effect below).
	const [firstSyncBudgetElapsed, setFirstSyncBudgetElapsed] = useState(false);
	// The currently-running init effect's own cancellation flag, published here so the
	// escape's onPress can mark a superseded run BEFORE calling startFresh() — a
	// cancelled run's later state writes must never reach setInitError/setIsInitialized.
	const cancelInitRunRef = useRef<(() => void) | undefined>(undefined);

	// D-12: one app-lifetime EngineFactory via useRef (constructed once, stable across renders).
	// Pitfall 7: factory ref is stable — getEngine dep array simplifies to [].
	const engineFactoryRef = useRef<EngineFactory | null>(null);
	if (!engineFactoryRef.current) {
		engineFactoryRef.current = new EngineFactory(new LocalStorageReact(), rnDbFactory);
	}

	// Collapse the entire switch to factory delegation (SWAP-01).
	// Empty dep array: factory is stable via useRef; no stale closure risk (Pitfall 7).
	const getEngine = useCallback(
		async <T,>(engineName: string, initParams?: any): Promise<T> => {
			return engineFactoryRef.current!.getEngine<T>(engineName, initParams);
		},
		[]
	);

	// 62-27: the transports passthrough (see `AppContextType.createPeerStagingTransports`).
	const createPeerStagingTransports = useCallback(
		(deps: { opener: StagingOpener; decisionSigner: StagingDecisionSigner }): PeerStagingTransports =>
			engineFactoryRef.current!.createPeerStagingTransports(deps),
		[]
	);

	// hasEngine delegates to factory's cache (SWAP-01).
	const hasEngine = useCallback((engineName: string) => {
		return engineFactoryRef.current?.hasEngine(engineName) ?? false;
	}, []);

	// 62-21 (D-04/D-28): the lazy device-signer thunk — the SAME class as the
	// `maybeSeedRegistrantFixtures` factory argument already in this file (see that call site's
	// own comment): it never resolves a signer at provider construction or cold start. Resolving
	// here would read the device key on every boot for a value most boots never use, and could
	// turn a successful re-attach into "Failed to load network" on a signer failure that has
	// nothing to do with network init. It is invoked only inside a user-initiated signing action
	// (enable encrypted intake, a peer sync's decision publishing), whose caller owns the error
	// handling (`useDeviceSigningErrorHandler`). This keeps `AppProvider.tsx` — already in
	// `ROLLOUT_EXEMPT` for exactly this reason — the only provider-level invoker (62-21 adds no new
	// invoking file).
	const resolveDeviceSigner = useCallback(async (): Promise<SignCallback> => {
		const user = await getOrCreateDeviceUser("Device User");
		return createDeviceSigner(user.name);
	}, []);

	// 62-21 (D-28): the 'peer' sync binding is attached in EVERY build — unlike the REST/filesystem
	// dev/device-proof harnesses below, there is no `__DEV__` gate and no configuration. P2P is the
	// default intake path. The binding holds no key material and constructs its transports lazily,
	// per sync, through the factory's `createPeerStagingTransports`. The catch is silent by design
	// (mirrors the dev-attach effect below): registration is a Map set, and a boot must never fail
	// because this attachment did.
	useEffect(() => {
		try {
			attachPeerSyncBinding({
				getEngine,
				createTransports: (d) => engineFactoryRef.current!.createPeerStagingTransports(d),
				createSigner: resolveDeviceSigner,
			});
		} catch {
			/* boot must not fail */
		}
	}, [getEngine, resolveDeviceSigner]);

	// 62-25 (D-28/D-29): the registration REST binding is attached in EVERY build, like the 'peer'
	// binding above it — no `__DEV__` gate, no configuration at this call site. It is inert until
	// an officer with 'vrg' saves an https bridge URL through `RestBridgeConfigCard`
	// (`registration-bridge-config.ts`, `setIntakePolicy`); `syncNow` itself refuses before any
	// network call while no valid URL is saved. The try/catch is defense-in-depth on top of the
	// attachment's own internal no-throw guards — a boot must never fail because this attachment
	// did, and no error object reaches `console` here (it may carry endpoint/policy text).
	//
	// D-28: association has NO REST or filesystem app binding any more. Through 62-24 this effect
	// also called a second dev-only attach function that composed an association REST harness onto
	// this same "rest" registry entry — that sibling file is deleted; the ONLY association sync
	// path is the 'peer' binding's `processPendingReassociations` call (see that binding's header).
	useEffect(() => {
		try {
			attachSyncBindings(getEngine);
		} catch {
			/* boot must not fail */
		}
	}, [getEngine]);

	// D-09: passthrough to the factory's capability probe. The `?? false`
	// fallback is deliberate: if the factory ref is somehow absent, report NOT
	// provisioned — the conservative direction, which surfaces the setup
	// warning rather than falsely claiming the verifier is ready.
	const isAttestationVerifierProvisioned = useCallback(() => {
		return engineFactoryRef.current?.isAttestationVerifierProvisioned() ?? false;
	}, []);

	// Phones that ran older builds may still hold the retired dashboard sign-in code under two
	// AsyncStorage keys that nothing reads any more: a bearer code secret and, on some builds, a
	// whole-database copy. Remove both blindly, once per mount. The sweep never reads a value and
	// never throws; a failure logs one fixed line with nothing interpolated and boot carries on.
	useEffect(() => {
		void sweepRetiredDashboardCodeStorage().then((outcome) => {
			if (outcome === "failed") console.warn("AppProvider: retired dashboard code storage sweep failed");
		});
	}, []);

	// Activate a network at runtime (create / picker "Select") without a reboot.
	// Mirrors the boot re-attach block below so behavior is identical to a restart.
	const selectNetwork = useCallback(async (networkRef: NetworkReference) => {
		const factory = engineFactoryRef.current!;
		const defaultUserEng = await factory.getEngine<IDefaultUserEngine>("defaultUser");
		const defaultUser = await defaultUserEng.get();
		let user = await getOrCreateDeviceUser(defaultUser?.name ?? "Device User");
		// Same D-19 rationale as the boot re-attach block below: Settings reads DefaultUser via
		// defaultUserEngine.get(), so a first create (which never goes through boot) must persist
		// one too or Settings reads "No default user found" until a restart. Write only when
		// absent, and set ONLY { name } -- never overwrite a user's edited name.
		if (defaultUser === undefined) {
			await defaultUserEng.set({ name: user.name });
		}
		factory.setCurrentUser(user);
		// open() is cache-first (D-06): a just-created network hits the cache; a recent
		// network re-attaches. It also writes networkRef to the recentNetworks list.
		await factory.getNetworksEngine().open(networkRef, user);
		await factory.getEngine("network", networkRef);
		user = (await repairForkedIdentityAfterOpen(factory, networkRef, user)) ?? user;
		setHasNetwork(true);
	}, [setHasNetwork]);

	// ENG-05: register the CadreNode live peer-count source with the factory so
	// NetworkEngine.getStatistics reports connected peers. connectedPeers is keyed
	// by strandId (== networkHash, D-05); it is a stable callback from the provider,
	// so this effect runs once after the CadreNodeProvider mounts.
	// D-04: setNode wires the booted CadreNode into the factory's lazy-dispatch DbFactory
	// (P2P-06 / SC1 no regression). This is also the precondition for the live-node
	// peerId marker the proof asserts (P2P-04 / D-05). node is null until the CadreNode
	// boots → rnDbFactory remains active until that point (solo-safe).
	const { connectedPeers, node, nodeSettled, syncState } = useCadreNode();
	useEffect(() => {
		engineFactoryRef.current?.setGetPeerCount(connectedPeers);
		engineFactoryRef.current?.setNode(node);
	}, [connectedPeers, node]);

	// Quick task 260928-kkf: register the "first wait budget elapsed" listener for the
	// lifetime of this provider (not just the current init run) — a listener registered
	// only inside the init effect would be torn down and re-created on every Try Again,
	// and the factory only ever holds ONE listener at a time (setFirstSyncListener
	// overwrites, it does not accumulate). Deregistered on unmount.
	useEffect(() => {
		engineFactoryRef.current?.setFirstSyncListener(() => setFirstSyncBudgetElapsed(true));
		return () => engineFactoryRef.current?.setFirstSyncListener(undefined);
	}, []);

	// Quick task 260928-kkf: the splash must come down the moment there is SOMETHING to
	// show under it — either the early "strand:started, not yet writable" signal
	// (syncState 'syncing') or the later "first wait budget elapsed" signal — even
	// though isInitialized is still false and the init effect has not resolved. Without
	// this, a joiner blocked on the first-sync gate stays behind the native splash for
	// the whole wait instead of seeing the Syncing label.
	useEffect(() => {
		if (!isInitialized && (syncState === "syncing" || firstSyncBudgetElapsed)) {
			hideSplash();
		}
	}, [isInitialized, syncState, firstSyncBudgetElapsed]);

	useEffect(() => {
		// Quick task 260928-kkf: a cancelled run is one that has been SUPERSEDED —
		// either by unmount, or by the escape action explicitly abandoning the wait
		// (cancelInitRunRef.current(), called BEFORE clearEngineCache/startFresh) — so
		// its state writes must never reach the component after that point. This does
		// NOT stop the background strand wait itself (only cancelPendingStrandWaits does
		// that, in the cleanup below); it stops THIS run's reaction to it.
		let cancelled = false;
		let cancelDelay: (() => void) | undefined;
		cancelInitRunRef.current = () => {
			cancelled = true;
			cancelDelay?.();
		};
		const wait = (ms: number) =>
			new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					cancelDelay = undefined;
					resolve();
				}, ms);
				cancelDelay = () => {
					clearTimeout(timer);
					cancelDelay = undefined;
					resolve();
				};
			});
		// Bounded retry around the open only: a peer-unavailable rejection is retried after each
		// delay; any other rejection (or exhausting the delays) propagates. Never retries once
		// cancelled (unmount, escape, Start Fresh).
		const openWithRetry = async (engine: INetworksEngine, network: any, user: any) => {
			for (let attempt = 0; ; attempt++) {
				try {
					await engine.open(network, user);
					return;
				} catch (openError) {
					if (cancelled || attempt >= PEER_RETRY_DELAYS_MS.length || !classifyPeerReadFailure(openError)) {
						throw openError;
					}
					await wait(PEER_RETRY_DELAYS_MS[attempt]);
					if (cancelled) throw openError;
				}
			}
		};

		async function initialize() {
			try {
				const factory = engineFactoryRef.current!;

				// RE-ATTACH FIX (D-08/D-09, superseding the prior race-survival shape):
				// await the CadreNode boot's settlement BEFORE the first DbFactory call,
				// instead of dispatching on whatever `node` happens to be on the CURRENT
				// render. The lazy-dispatch DbFactory selects strand vs solo based on
				// factory.node AT CALL TIME, and on cold start `node` is unconditionally
				// null on the first render (CadreNode.start() is async and has not
				// resolved yet) — the old `factory.setNode(node)` here guaranteed a first
				// attempt against rnDbFactory that died at isSchemaInitialized. The old
				// fix relied on `node` being in this effect's dependency array to force an
				// implicit SECOND attempt once boot completed, but nothing distinguished
				// "still booting" from "boot already failed" (both are `node === null`
				// forever) — bounded retry (`loadAuthoritiesWithRetry.ts`) was considered
				// and rejected (D-09): retrying re-attempts the same ambiguous signal
				// rather than resolving it. `nodeSettled` makes the two states
				// distinguishable, so there is exactly one dispatch, against the backend
				// actually settled on — see `resolveNodeDispatch`'s header comment above
				// for the bound (Open Question 2) that keeps this await from becoming a
				// hang.
				const settleStart = Date.now();
				const dispatch = await resolveNodeDispatch(nodeSettled, NODE_SETTLE_TIMEOUT_MS);
				// Closed-token diagnostic only: status + elapsed ms, never a hash, an
				// address, or user data (mirrors CadreNodeProvider.tsx's own discipline).
				console.info("[AppProvider] node settle:", dispatch.status, Date.now() - settleStart);
				factory.setNode(dispatch.status === "ready" ? dispatch.node : null);

				// LATE SETTLE: the bound above is a liveness ceiling, not a verdict. On a loaded
				// device the node routinely settles AFTER it (64-53: `timeout 24387` on a relaunched
				// keyholder; 64-52: `timeout 16957` on the Redmi after its control-store recreate,
				// inspirions/votetorrent#97), and a network that lives in a strand can never open on
				// the solo backend ("Network not opened in this session"). So a timed-out run keeps
				// listening to `nodeSettled`: if it later settles 'ready' while this run's re-attach is
				// still in flight or has failed, the run is superseded by a fresh one (the same
				// initNonce bump Try Again uses), which awaits the now-settled promise and dispatches
				// on the live node. Bounded: `nodeSettled` settles once and the re-run cannot time out
				// again, so this adds at most ONE automatic run. A run that attached, or had nothing
				// to attach, is left alone — the peer-count effect hands the live node to the factory.
				let lateReady = false;
				let reattachUnresolved = false;
				const supersedeOnLiveNode = () => {
					if (cancelled || !lateReady || !reattachUnresolved || hasNetworkRef.current) return;
					console.info("[AppProvider] node settle: late-ready", Date.now() - settleStart);
					setInitError(null);
					setIsInitialized(false);
					setInitNonce((n) => n + 1);
				};
				if (dispatch.status === "timeout") {
					void nodeSettled.then((late) => {
						if (late.status !== "ready" || cancelled) return;
						// Hand the live node to the factory NOW. The peer-count effect does the same,
						// but it is a passive effect and on a starved device it lags this settlement
						// by long enough that a re-attach reaching its open in between still saw null
						// and went solo (officer Pixel_8 2026-10-16: an hour rebuilding an empty solo
						// store). The DbFactory reads the node at call time, so every open after this
						// line goes strand. Same node the effect passes, so setNode's change check
						// keeps the later effect call a no-op.
						factory.setNode(late.node);
						lateReady = true;
						supersedeOnLiveNode();
					});
				}

				const networksEng = factory.getNetworksEngine();

				// Attempt to re-attach to the most recently used network.
				const networks = await networksEng.getRecentNetworks();
				if (networks.length > 0) {
					const network = networks[0];
					reattachUnresolved = true;
					try {
						// D-15: inner try/catch for re-attach; on throw → setInitError, NOT setHasNetwork.
						// NetworksEngine.open() may throw if the on-device store is corrupt/uninitialized.
						// NEVER fall back to a silent in-memory context — Phase-14 D-13 hard-fail rule.
						//
						// Resolve the device user so ctx.user is a real User for UserId-scoped queries.
						// Mirror the pattern in AuthorityInvitationScreen.onSend.
						const defaultUserEng = await factory.getEngine<IDefaultUserEngine>("defaultUser");
						const defaultUser = await defaultUserEng.get();
						let user = await getOrCreateDeviceUser(defaultUser?.name ?? "Device User");
						// D-19: Persist a DefaultUser record at boot if one does not yet exist.
						// DefaultUserEngine.get() (LocalStorage key 'defaultUser') is a DIFFERENT
						// store from the network ctx.user resolved above. SettingsScreen reads
						// DefaultUser via defaultUserEngine.get(); without this set() the screen
						// always shows "No default user found" even after ctx.user is bound.
						// Guard: only write when absent (idempotent — a user who later edits their
						// name via DefaultUserScreen is never overwritten on subsequent boots).
						// Set ONLY { name }; do NOT copy private key material into DefaultUser.
						if (defaultUser === undefined) {
							await defaultUserEng.set({ name: user.name });
						}
						// Bind the resolved user into the factory BEFORE getEngine("network", ...) so
						// the factory's internal open() (which wins for the hash) also uses the real user.
						factory.setCurrentUser(user);
						await openWithRetry(networksEng, network, user);
						await factory.getEngine("network", network);
						// O-06: repair a forked device identity. Bounded (IDENTITY_REPAIR_BUDGET_MS) and
						// abandoned before any write once this run is cancelled.
						user = (await repairForkedIdentityAfterOpen(factory, network, user, () => cancelled)) ?? user;
						if (cancelled) return;
						// 47-23: __DEV__-guarded, flag-gated registrant fixture. No-op in
						// release and whenever REGISTRANT_SEED_ENABLED is false (committed
						// default). Awaited HERE — rather than fired from index.js — so
						// exactly one Quereus context ever touches the store (the factory's
						// own), matching the voter app's VoterAppProvider precedent for the
						// same placement.
						// A LAZY factory, never a resolved signer: createDeviceSigner reads
						// the device private key out of AsyncStorage and throws when the
						// device user is absent/corrupt. Resolving it here ran that read on
						// every release cold start for a call that always no-ops, and let a
						// signer failure abort a SUCCESSFUL re-attach into "Failed to load
						// network". maybeSeedRegistrantFixtures now invokes this only after
						// its own __DEV__/flag gate, inside its own try/catch.
						await maybeSeedRegistrantFixtures(networksEng, network, user, () =>
							createDeviceSigner(user.name),
						);
						// A cancelled run (superseded by the escape action, or by unmount) must
						// not write hasNetwork/initError — the newer run (or no run at all,
						// post-escape) owns the UI now.
						if (cancelled) return;
						reattachUnresolved = false;
						// Pitfall 4: setHasNetwork is called by AppProvider (not the factory).
						setHasNetwork(true);
						// RE-ATTACH FIX: clear any initError from a previous failed attempt so
						// the error screen is not shown when re-attach succeeds on the retry
						// triggered by the node dep change (CadreNode boot race).
						setInitError(null);
					} catch (reattachError) {
						// A cancelled run's rejection (e.g. StrandWaitCancelledError from the
						// cleanup below aborting a pending first-sync wait) must never surface
						// as an error view — the escape action already resolved the UI.
						if (cancelled) return;
						// D-15: surface the recoverable error; spinner resolves to an error view.
						const peerFailure = classifyPeerReadFailure(reattachError);
						if (peerFailure) {
							// Closed token only: the message carries block ids and table names.
							console.warn("[AppProvider] re-attach peer read unavailable:", peerFailure.reason);
							setInitError({ kind: "peer-unavailable", reason: peerFailure.reason });
						} else {
							console.error("Re-attach failed:", reattachError);
							setInitError({ kind: "generic" });
						}
						// fall through to setIsInitialized(true) below so the spinner never hangs.
					}
				}

				if (cancelled) return;
				setNetworksEngine(networksEng);
				// D-15: ALWAYS reach setIsInitialized(true) + hideSplash() — no path skips this.
				setIsInitialized(true);
				hideSplash();
				// Quick task 260928-kkf: a fresh run starts with no elapsed-budget escape shown.
				setFirstSyncBudgetElapsed(false);
				// LATE SETTLE: the node may have gone live while the failed re-attach was running.
				supersedeOnLiveNode();
			} catch (fatalError) {
				if (cancelled) return;
				// Outer catch handles failures before/after the re-attach block
				// (e.g. getRecentNetworks() failure, LocalStorageReact init failure).
				const fatalPeer = classifyPeerReadFailure(fatalError);
				if (fatalPeer) {
					console.warn("[AppProvider] fatal init peer read unavailable:", fatalPeer.reason);
					setInitError({ kind: "peer-unavailable", reason: fatalPeer.reason });
				} else {
					console.error("Fatal init error:", fatalError);
					setInitError({ kind: "generic" });
				}
				setIsInitialized(true);
				hideSplash();
			}
		}

		initialize();

		return () => {
			cancelled = true;
			cancelDelay?.();
			// Unmount, network switch, or a superseded boot run: stop waiting on any
			// in-flight first-sync gate so nothing keeps polling in the background.
			engineFactoryRef.current?.cancelPendingStrandWaits();
		};
		// CR-02: re-run when initNonce changes so Try Again can re-attempt init.
		// D-09/D-10: `node` is deliberately OUT of this array — it was the trigger
		// for the implicit second attempt the settle-then-dispatch fix above
		// removes. `initNonce` stays: it is the CR-02 Try Again affordance and is
		// also the recovery path for the timeout branch — bumped automatically by
		// the LATE SETTLE listener above when the node goes live, or by Try Again —
		// since a bump re-awaits the by-then-settled `nodeSettled` promise and gets
		// the correct backend. `nodeSettled` itself is NOT in this array either — it is a
		// stable ref-held promise (CadreNodeProvider.tsx), so listing it would only
		// matter if some future consumer reconstructed it per render, which would
		// re-fire this effect and reintroduce the double attempt this plan removes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [initNonce]);

	// Start Fresh: clear the engine cache and reset to the create-network flow.
	// Extracted (quick task 260928-kkf) so the error view's existing button AND the
	// syncing view's escape button below call the EXACT same handler — same literal
	// copy, same behavior, no divergence between the two call sites.
	// clearEngineCache() also calls cancelPendingStrandWaits() (engine-factory.ts), so
	// this already aborts any pending first-sync wait; the escape's onPress calls
	// cancelInitRunRef.current() FIRST so the (now-cancelled) run's own rejection never
	// re-surfaces as an error view.
	const startFresh = useCallback(() => {
		engineFactoryRef.current?.clearEngineCache();
		setInitError(null);
		setIsInitialized(true);
	}, []);

	// D-15: only show the spinner while initialization is truly pending.
	// Quick task 260928-kkf ("Syncing + escape button", locked decision): while a boot
	// re-attach is gated on the first-sync wait, this same loading view additionally
	// shows the localized Syncing label (as soon as syncState reports 'syncing', or once
	// the wait's first budget has elapsed) and, ONLY once that budget has elapsed, the
	// existing Start Fresh action — reusing its exact literal copy and handler. Try
	// Again is deliberately NOT offered here: it would just start a new ~300s wait on
	// the same strand, which the background wait is already doing.
	if (!isInitialized) {
		const showSyncing = syncState === "syncing" || firstSyncBudgetElapsed;
		return (
			<View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
				<ActivityIndicator size="large" />
				{showSyncing && (
					<Text style={{ marginTop: 16, textAlign: "center" }}>{t("syncSyncing")}</Text>
				)}
				{firstSyncBudgetElapsed && (
					<TouchableOpacity
						testID="boot-syncing-start-fresh"
						onPress={() => {
							// Mark THIS boot run cancelled before startFresh() clears the
							// engine cache — so its (now-orphaned) pending open() never
							// writes state once cancelPendingStrandWaits() rejects it.
							cancelInitRunRef.current?.();
							startFresh();
						}}
						style={{ marginTop: 8 }}
					>
						<Text>{t("bootStartFresh")}</Text>
					</TouchableOpacity>
				)}
			</View>
		);
	}

	// D-15: recoverable boot-error state — shown INSIDE the existing loading View,
	// no new screen, no visual redesign (no-UI-design-change rule).
	// T-15-03-01: never fabricate an empty in-memory context; user must retry or start fresh.
	if (initError && !hasNetwork) {
		return (
			<View testID="boot-error-view" style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
				{initError.kind === "peer-unavailable" ? (
					<>
						<Text style={{ marginBottom: 8, textAlign: "center", fontWeight: "bold" }}>
							{t("peerReadUnavailableTitle")}
						</Text>
						<Text style={{ marginBottom: 16, textAlign: "center" }}>{t("peerReadUnavailableBody")}</Text>
					</>
				) : (
					<Text style={{ marginBottom: 16, textAlign: "center" }}>{t("bootNetworkLoadFailed")}</Text>
				)}
				<TouchableOpacity
					testID="boot-error-try-again"
					onPress={() => {
						// Try Again: reset error state and re-run initialize().
						// CR-02: bumping initNonce re-triggers the init effect (its dep
						// array is [initNonce]); setIsInitialized(false) only shows the
						// spinner again. D-15: the effect always resolves the view.
						setInitError(null);
						setIsInitialized(false);
						setInitNonce((n) => n + 1);
					}}
					style={{ marginBottom: 8 }}
				>
					<Text>{initError.kind === "peer-unavailable" ? t("peerReadUnavailableRetry") : t("bootTryAgain")}</Text>
				</TouchableOpacity>
				<TouchableOpacity testID="boot-error-start-fresh" onPress={startFresh}>
					<Text>{t("bootStartFresh")}</Text>
				</TouchableOpacity>
			</View>
		);
	}

	return (
		<AppContext.Provider
			value={{
				networksEngine: networksEngine ?? undefined,
				getEngine,
				hasEngine,
				isAttestationVerifierProvisioned,
				isInitialized,
				hasNetwork,
				selectNetwork,
				isNetworkSelected,
				resolveDeviceSigner,
				createPeerStagingTransports,
			}}
		>
			{children}
		</AppContext.Provider>
	);
}
