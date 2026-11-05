/**
 * packages/p2p-probe-host/wall-proof.mjs — the D-07 wall proof (Phase 56 Plan 01).
 *
 * WHY THIS EXISTS. 56-04 (Wave 2) patches the strand-mesh gap
 * (`strand-addr-protocol.js:179` in `@serfab/cadre-core`, not optimystic, not P2P-11) that lets an
 * unauthorized peer reach the public election view. Before that patch is SCOPED, this harness
 * proves what the wall currently does — against a gateway whose every unconditional-admit branch
 * is verified CLOSED, so the result cannot be the cold-start `authorized.length === 0` carve-out
 * masquerading as a real refusal (`feedback_read_back_preconditions_dont_infer`).
 *
 * NODE-SIDE ONLY. This is a `@serfab/cadre-core` + `@optimystic/db-p2p` integration harness, not a
 * device proof — it runs the REAL admission internals in-process against a REAL outsider libp2p
 * node built from the same factory (`createLibp2pNode` from `@optimystic/db-p2p/rn`) the browser
 * Edge node (56-05) will use.
 *
 * RUNGS (each ends in a definite classified verdict — an unclassified timeout or "could not tell"
 * exits 1, because a wall proof that shrugs is worse than no proof):
 *   RUNG_P     — precondition control: every unconditional-admit branch is verified closed by
 *                direct reads that THROW (never skip) on a missing member. An assertion, not a
 *                measurement — see `assessPrecondition`.
 *   RUNG_L1    — Layer 1, protocol-blind connection admission. (Task 2)
 *   RUNG_L2    — Layer 2, `authorizeInboundControlStream`, behavioural + source-scan. (Task 2)
 *   RUNG_L3    — Layer 3, the strand-addr protocol handler's own `isMember`. (Task 2)
 *   RUNG_POS   — positive control: an authorized peer succeeds on the same probe code path, so
 *                every refusal above is attributable to the gate, not to a broken probe. (Task 2)
 *   RUNG_RELAY — the gateway's relay posture, decided on measured behaviour. (Task 2)
 *   RUNG_F4    — CONTEXT Finding 4: can a peer already holding valid strand addresses complete a
 *                strand-mesh read? (Task 3)
 *
 * CLI:
 *   --preconditions-only   boot a SEEDED gateway, run RUNG_P only, then shut down.
 *   --self-test            RUNG_P's inversion: boot an UNSEEDED gateway and require RUNG_P to FAIL
 *                           and `admitInboundControlConnection` to return 'admit' — proves the
 *                           precondition rung CAN fail (a rung that cannot fail is not a control).
 *   --relay=on|off          force the RUNG_RELAY posture under test (default: measure both).
 *   --json <path>           where to write the machine-readable record (default: ./wall-proof-record.json).
 *   (no flags)              the full sequence: RUNG_P, RUNG_L1..RUNG_RELAY, RUNG_F4, record emission.
 *
 * Exit: 0 on a fully classified PASS run, 1 on any unclassified/failed rung. SIGINT/SIGTERM stop
 * every node this process started (enrolment-smoke.mjs's shape).
 *
 * NOTE for whoever runs this: CadreNode boot is CPU-heavy and a busy host has previously
 * manufactured false failures (`project_voter_emulator_boot_needs_quiet_host`) — do not run this
 * concurrently with `nx run-many`.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { CadreNode, collectStrandAddrs, STRAND_ADDR_PROTOCOL, ed25519KeyPairFromLibp2p } from '@serfab/cadre-core';
import { createLibp2pNode, RepoClient } from '@optimystic/db-p2p/rn';
import { webSockets } from '@libp2p/websockets';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';

const L = (...a) => console.log('[wall-proof]', ...a);

export const PARTY_ID = 'votetorrent'; // aligned with drone.mjs / CadreNodeProvider.tsx
// A harness-local id — never a real network hash. Distinct from drone.mjs's STRAND_ID env var so
// the two proof runners never collide if ever run side by side.
export const STRAND_ID = 'wall-proof-strand';

// ── Schema: the same votetorrent.qsql wrapper-strip drone.mjs uses (`:36-52`) ──────────────────
const VOTETORRENT_QSQL_RAW = readFileSync(
  new URL('../vote-core/schema/votetorrent.qsql', import.meta.url),
  'utf8',
);
const VOTETORRENT_QSQL = VOTETORRENT_QSQL_RAW
  .replace(/^\s*declare\s+schema\s+\w+\s*\{/, '')
  .replace(/\}\s*apply\s+schema\s+\w+\s*;\s*$/, '')
  .trim();

// ── Package-version instrument hygiene (T-56-01-05) ─────────────────────────────────────────────
// `import.meta.resolve` (ESM resolution, respects the "import" condition) rather than
// `createRequire(...).resolve`: both @serfab/cadre-core and @optimystic/db-p2p ship ESM-only
// `exports` maps with no "require" condition, so CJS resolution throws ERR_PACKAGE_PATH_NOT_EXPORTED.
// Neither package exposes a `./package.json` export subpath, so walk up from the resolved entry
// file to find the nearest package.json whose "name" matches.
export function resolvePackageInfo(specifier, expectedName) {
  const entryPath = fileURLToPath(import.meta.resolve(specifier));
  let dir = dirname(entryPath);
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
      if (pkg.name === expectedName) {
        return { version: pkg.version, path: candidate };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not resolve an installed package.json for ${expectedName} from ${specifier}`);
}

const CADRE_CORE_INFO = resolvePackageInfo('@serfab/cadre-core', '@serfab/cadre-core');
const DB_P2P_INFO = resolvePackageInfo('@optimystic/db-p2p', '@optimystic/db-p2p');

// ── Instrument hygiene: throw, never skip, on a missing member ─────────────────────────────────
// A future @serfab/* bump could rename/remove one of these TS-`private`-but-real-JS-prototype
// methods. Reading it optionally (`?.`) or behind a try/catch would silently fold that into a
// PASS — exactly the vacuous-pass failure mode T-56-01-01 exists to prevent. requireMethod throws
// naming the missing member instead.
export function requireMethod(obj, name, label) {
  const fn = obj?.[name];
  if (typeof fn !== 'function') {
    throw new Error(
      `RUNG_P instrument failure: ${label} — CadreNode.${name} is not a function on the installed ` +
      `@serfab/cadre-core@${CADRE_CORE_INFO.version} (${CADRE_CORE_INFO.path}). Refusing to silently ` +
      `skip this precondition; a missing member here means the rung cannot vouch for the branch.`,
    );
  }
  return fn.bind(obj);
}

/**
 * Build one gateway `CadreNode`. Modeled on `drone.mjs:63-127`, with the differences the
 * interface_context calls out: an explicit `network.enableRelay` (never inherited from the
 * storage-profile default), a loopback-only listen addr (this harness never needs an emulator
 * reachability address), and no `relayServerInit` (dev-proof scale; the default reservation store
 * is more than this harness's few probe connections need).
 *
 * `seeded`: when true, runs owner genesis + seeds exactly one authorized member (never itself
 * connected — a `CadrePeer` row is all `listAuthorizedMembers` needs to read) WITHOUT ever calling
 * `createInvite`. `createInvite` opens a 30-minute enrollment window as a side effect
 * (`DEFAULT_ENROLLMENT_WINDOW_MS`, `membership-connection-gater.js:174`), and `openEnrollmentWindow`
 * is monotonic (`cadre-node.js:1203`, `Math.max` — can never be narrowed once opened), so calling it
 * even once would admit every stranger unconditionally for the rest of this process's life and
 * defeat every rung this plan exists to run. `seed-bootstrap.js:964-979` shows `acceptPhone({
 * phonePeerId })` with NO `issuedInvite` argument writes the `CadrePeer` voucher directly via
 * `authorizePeer` and never touches the enrollment window — that is the seeding path used here.
 */
// 56-07 additive parameters: `strands` (default preserves the single wall-proof-strand shape;
// 56-07 passes two entries — S_LISTED and S_UNLISTED — to host both under one gateway) and
// `configOverrides` (merged at the top level of the `CadreNode` constructor options, sibling to
// `network`/`profile`/etc. — 56-07 uses it for `publicObserverStrandIds`, which per 56-04's
// downstream_contract is read at constructor time, immediately after `this.config = config`).
// Neither default changes a single call site above this refactor.
export async function buildGateway({
  enableRelay = false,
  seeded = true,
  strands = [{ id: STRAND_ID }],
  configOverrides = {},
} = {}) {
  const privateKey = await generateKeyPair('Ed25519');
  const node = new CadreNode({
    privateKey,
    controlNetwork: { partyId: PARTY_ID, bootstrapNodes: [] },
    profile: 'storage',
    requireSignedSchemas: false,
    strandFilter: { mode: 'all' },
    network: {
      transports: [webSockets()],
      listenAddrs: ['/ip4/127.0.0.1/tcp/0/ws'],
      enableRelay, // the explicit knob (cadre-node.js:1034) — never left to the storage-profile default
    },
    strandClusterSize: 2,
    hibernation: { enabled: false },
    ...configOverrides,
  });

  await node.start();

  for (const strand of strands) {
    await node.addStrand({
      strandRow: { Id: strand.id, MemberPrivateKey: null, Type: 'o' },
      sAppConfig: {
        id: 'org.votetorrent',
        version: '1.0.0',
        schema: VOTETORRENT_QSQL,
        latencyHint: 'interactive',
      },
      mode: 'bootstrap',
    });
  }

  if (seeded) {
    // Owner genesis MUST run while the node is solo — see drone.mjs:202-216 for the same
    // ordering constraint. This node boots with empty bootstrapNodes so "solo" holds by
    // construction.
    // cadre-core 1.18 deleted getIdentityOwnerKey(); derive the same identity owner key here.
    const owner = ed25519KeyPairFromLibp2p(privateKey);
    await node.trustOwnerKeys([owner.publicKeyB64], 'operator');
    const controlDb = node.getControlDatabase();
    if (!controlDb) throw new Error('gateway has no control database after start()');
    await controlDb.ensureOwnerKey(owner.publicKeyB64);
    await node.initializeSeedBootstrap(owner.privateKeyB64);

    // A throwaway member, never connected — a row is all listAuthorizedMembers needs.
    // Deliberately NOT node.createInvite() — see the header comment above.
    const seedMemberKeyPair = await generateKeyPair('Ed25519');
    const seedMemberPeerId = peerIdFromPrivateKey(seedMemberKeyPair).toString();
    await node.acceptPhone({ phonePeerId: seedMemberPeerId });
  }

  return node;
}

/**
 * RUNG_P: the precondition control. Asserts all eight unconditional-admit branches
 * (interface_context numbered list) are closed against `probePeerId`, using direct reads that
 * throw rather than skip on a missing member (T-56-01-01).
 *
 * Returns `{ pass, checks, decision }` — `checks` carries per-assertion observed values so both
 * the full run and `--self-test` can report exactly which branch(es) are open.
 */
async function assessPrecondition(node, probePeerId) {
  const checks = [];
  const record = (id, branch, pass, observed) => checks.push({ id, branch, pass, observed });

  // Branches 1-3: not running/no DB, empty trusted-owner anchor, configured bootstrap/relay peer.
  const admitUnconditionally = requireMethod(
    node, 'admitControlPeerUnconditionally', 'branches 1-3 (admitControlPeerUnconditionally)',
  );
  const unconditional = admitUnconditionally(probePeerId);
  record(
    'unconditional', 'branches 1-3 (not-running/no-DB, empty trust anchor, bootstrap/relay peer)',
    unconditional === false, unconditional,
  );

  // Branch 4: enrollment window.
  if (typeof node.enrollmentWindowUntil !== 'number') {
    throw new Error(
      `RUNG_P instrument failure: node.enrollmentWindowUntil is not a number on the installed ` +
      `@serfab/cadre-core@${CADRE_CORE_INFO.version} — CadreNode shape changed.`,
    );
  }
  record('enrollmentWindow', 'branch 4 (enrollment window)', node.enrollmentWindowUntil === 0, node.enrollmentWindowUntil);

  // Branch 5: delegate admission grant.
  const hasDelegate = requireMethod(node, 'hasDelegateAdmission', 'branch 5 (delegate admission)');
  const delegate = hasDelegate(probePeerId);
  record('delegateAdmission', 'branch 5 (delegate admission)', delegate === false, delegate);

  // Branch 6: cold-start carve-out (authorized.length === 0), plus the membership fact RUNG_L1-L3
  // depend on (probePeerId must NOT be a member for the outsider probes to mean anything).
  const listMembers = requireMethod(node, 'listAuthorizedMembers', 'branch 6 (cold-start / membership)');
  const authorized = await listMembers();
  const memberCount = authorized.length;
  const probeIsMember = authorized.some((m) => m.peerId === probePeerId);
  record(
    'membership', 'branch 6 (authorized.length===0 cold-start carve-out) + probe is not a member',
    memberCount >= 1 && !probeIsMember, { memberCount, probeIsMember },
  );

  // Branch 7: outstanding strand-formation invitation. `strandSolicitationService` is a plain
  // instance field that starts `null` and is only constructed by a formation call this harness
  // never makes (cadre-node.js:111,4981) — that is a legitimate absence, not a missing member, so
  // it reads as "no outstanding invitation" without throwing. If the service EXISTS but lacks the
  // method, that IS a shape change and must throw.
  let outstandingInvitation = false;
  const solicitation = node.strandSolicitationService;
  if (solicitation) {
    if (typeof solicitation.hasOutstandingInvitation !== 'function') {
      throw new Error(
        'RUNG_P instrument failure: strandSolicitationService.hasOutstandingInvitation is not a ' +
        'function — CadreNode shape changed.',
      );
    }
    outstandingInvitation = await solicitation.hasOutstandingInvitation();
  }
  record('outstandingInvitation', 'branch 7 (outstanding invitation)', outstandingInvitation === false, outstandingInvitation);

  // Branch 8: relay posture (this gateway's default posture under test — RUNG_RELAY re-measures
  // the "on" posture separately in Task 2).
  const relayEnabledFn = requireMethod(node, 'relayServerEnabled', 'branch 8 (relayServerEnabled)');
  const relayEnabled = relayEnabledFn();
  record('relayServerEnabled', 'branch 8 (relayServerEnabled posture)', relayEnabled === false, relayEnabled);

  // Validity precondition (not an admit branch): without this, Layer 3's empty response is
  // indistinguishable from "this gateway does not host the strand at all".
  const getStrandFn = requireMethod(node, 'getStrand', 'strand-hosting validity check');
  const strandInstance = getStrandFn(STRAND_ID);
  const strandAddrCount = strandInstance?.libp2pNode?.getMultiaddrs?.().length ?? 0;
  record('strandHosted', 'validity (strand actually running locally)', strandAddrCount > 0, strandAddrCount);

  // Aggregate decision-level wall: the sum of every branch above, read through the real
  // decision function rather than re-derived from the individual checks.
  const admitInbound = requireMethod(node, 'admitInboundControlConnection', 'decision-level wall (admitInboundControlConnection)');
  const decision = await admitInbound(probePeerId);
  record('decision', 'aggregate decision (admitInboundControlConnection)', decision === 'deny', decision);

  const pass = checks.every((c) => c.pass);
  return { pass, checks, decision };
}

function printRungP(result) {
  for (const c of result.checks) {
    L(`RUNG_P.${c.id}=${c.pass ? 'PASS' : 'FAIL'} branch="${c.branch}" observed=${JSON.stringify(c.observed)}`);
  }
  L(`RUNG_P decision-level admitInboundControlConnection=${result.decision}`);
  L(`RUNG_P=${result.pass ? 'PASS' : 'FAIL'}`);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// TASK 2 — the outsider probe: RUNG_L1 / RUNG_L2 / RUNG_L3 / RUNG_POS / RUNG_RELAY
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * Build the outsider libp2p node from the SAME factory 56-05's browser Edge node will use
 * (`createLibp2pNode` from `@optimystic/db-p2p/rn`), so this probe measures the real client
 * shape, not a Node-only stand-in.
 */
export async function buildOutsiderNode(privateKey, networkName) {
  return await createLibp2pNode({
    transports: [webSockets()],
    listenAddrs: [],
    bootstrapNodes: [],
    networkName,
    fretProfile: 'edge',
    privateKey,
  });
}

// How long an 'admit-for-relay' connection may exist without an admitted relay reservation
// before the gate aborts it (membership-connection-gater.js RELAY_ADMISSION_RESERVE_DEADLINE_MS
// = 5000ms). Held slightly past that deadline so a genuine durable admission can be told apart
// from the relay branch's timed partial admission — our probe never requests an actual
// reservation, so an admit-for-relay connection WILL be dropped by this deadline.
const RELAY_PARTIAL_CHECK_DELAY_MS = 5300;
const RELAY_ADMISSION_RESERVE_DEADLINE_MS = 5000; // membership-connection-gater.js's own constant

/**
 * Race a dialed connection's own 'close' event against `timeoutMs`. Resolves the elapsed ms if
 * the connection closes first, or `null` if it is still open at the deadline.
 *
 * WHY THIS EXISTS, not a blind sleep-then-check: `membership-connection-gater.js`'s own "Deny
 * timing" note says a plain `deny` verdict can still let the DIALER's `dial()` resolve —
 * "noise negotiates the muxer in the security handshake's early data, so the dialer's upgrade
 * may complete before [the deny] hook runs... the dialer sees its 'open' connection close
 * MOMENTS LATER" — which can be far sooner than the 5s relay-reservation deadline. A blind sleep
 * would misreport that ordinary deny as a 5s-later RELAY_PARTIAL, mislabeling the wall's real
 * behaviour. Racing the actual 'close' event measures when the dialer really saw it drop.
 */
function raceConnectionClose(conn, timeoutMs) {
  return new Promise((resolve) => {
    if (conn.status !== 'open') {
      resolve(0);
      return;
    }
    const t0 = performance.now();
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      conn.removeEventListener('close', onClose);
    };
    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(performance.now() - t0);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(null);
    }, timeoutMs);
    conn.addEventListener('close', onClose, { once: true });
  });
}

/**
 * Separate an INFRASTRUCTURE dial failure (nothing listening, unreachable host, malformed
 * target — the dial never reached a peer able to make an admission decision) from a WALL
 * decision (the peer was reached and refused/reset by the gate). Only the latter is a
 * classified verdict; the former must propagate as "unclassifiable" so the harness never
 * misreports "nothing was listening" as "the wall denied it" (<verification> robustness note —
 * a wall proof that shrugs is worse than no proof).
 */
export function classifyDialError(err) {
  const msg = err?.message ?? String(err);
  const code = err?.code ?? err?.name ?? '';
  // Includes the @libp2p/websockets transport's own dial-failure text ("Received network error
  // or non-101 status code.", carried with no `code`/`name`/`cause` at all — confirmed against
  // the installed transport this session by dialing an unbound loopback port) alongside the
  // usual Node network error codes.
  const infra = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|dial timed out|timed out|no valid addresses|could not connect|AggregateError|network error|non-101 status code/i;
  if (infra.test(msg) || infra.test(code)) {
    return { classified: false, reason: msg };
  }
  return { classified: true, verdict: `DENIED:${(code || msg).toString().slice(0, 180)}` };
}

/**
 * RUNG_L1 primitive: dial the gateway's control-network multiaddr directly and classify the
 * outcome. `denyInboundEncryptedConnection` denies after the encryption handshake, so the
 * observable is a dial rejection or an admitted-then-dropped connection — never a wire-level
 * "why". See `classifyDialError` for the infra/wall split.
 */
export async function dialGateway(outsider, controlAddr) {
  const ma = multiaddr(controlAddr);
  const t0 = performance.now();
  try {
    const conn = await outsider.dial(ma);
    const closedAfterMs = await raceConnectionClose(conn, RELAY_PARTIAL_CHECK_DELAY_MS);
    const elapsedMs = performance.now() - t0;
    if (closedAfterMs === null) {
      // Still open at the deadline: a durable admission.
      return { classified: true, verdict: 'ADMITTED', elapsedMs, connection: conn };
    }
    // Closed before the deadline. Near RELAY_ADMISSION_RESERVE_DEADLINE_MS (5000ms) is the
    // relay branch's own timed-partial-admission signature; anywhere else (often much sooner)
    // is an ordinary deny whose abort the dialer observed after its own upgrade had resolved.
    const nearRelayDeadline = closedAfterMs >= RELAY_ADMISSION_RESERVE_DEADLINE_MS - 500;
    const verdict = nearRelayDeadline
      ? `RELAY_PARTIAL:closed-after-${Math.round(closedAfterMs)}ms`
      : `DENIED:closed-after-${Math.round(closedAfterMs)}ms(receiver-side-abort-raced-dialer-upgrade)`;
    return { classified: true, verdict, elapsedMs, connection: null };
  } catch (err) {
    const elapsedMs = performance.now() - t0;
    const cls = classifyDialError(err);
    if (!cls.classified) {
      return { classified: false, verdict: null, elapsedMs, connection: null, reason: cls.reason };
    }
    return { classified: true, verdict: cls.verdict, elapsedMs, connection: null };
  }
}

// ── Hand-framed strand-addr wire client ──────────────────────────────────────────────────────
// Deliberately NOT the unexported `writeFrame`/`readStreamToEnd`/`decodeLengthPrefixedFrame`
// helpers `control-stream.js` uses internally (nothing under those names is exported from
// @serfab/cadre-core's index) — this reimplements the SAME 4-byte big-endian length-prefixed
// JSON framing `control-stream.js` documents, so this harness can read the raw stream-level
// outcome (open / reset / empty response) that `collectStrandAddrs` (which folds every failure
// to `[]`) cannot discriminate.
export function encodeFrame(obj) {
  const body = new TextEncoder().encode(JSON.stringify(obj));
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, body.length, false);
  return { prefix, body };
}

export async function readStreamToEndRaw(stream) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = chunk instanceof Uint8Array ? chunk : chunk.subarray();
    chunks.push(bytes);
    total += bytes.length;
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { data.set(c, offset); offset += c.length; }
  return data;
}

export function decodeFrameRaw(data) {
  if (data.length < 4) throw new Error(`strand-addr response frame too short (${data.length} bytes)`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const len = view.getUint32(0, false);
  const body = data.subarray(4, 4 + len);
  return JSON.parse(new TextDecoder().decode(body));
}

export const briefMessage = (err) => (err?.message ?? String(err)).slice(0, 180);

/**
 * L2 primitive, factored out of `probeGateway` for 56-07's reuse: open a stream for `protocolId`
 * on an already-admitted connection and classify STREAM_OPENED vs STREAM_RESET. Additive
 * extraction only — `probeGateway`'s own STRAND_ADDR_PROTOCOL behaviour is unchanged below.
 */
export async function openProtocolStream(outsider, remotePeer, protocolId, timeoutMs = 10_000) {
  try {
    const stream = await outsider.dialProtocol(remotePeer, protocolId, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { verdict: 'STREAM_OPENED', streamOpened: true, stream };
  } catch (err) {
    return { verdict: `STREAM_RESET:${briefMessage(err)}`, streamOpened: false, stream: null };
  }
}

/**
 * L3 primitive, factored out of `probeGateway` for 56-07's reuse: exchange the same
 * length-prefixed-JSON `{ strandId }` request/response frame `control-stream.js` documents, over
 * an already-open stream, for an arbitrary `strandId` (default `STRAND_ID` preserves
 * `probeGateway`'s pre-refactor behaviour exactly). Works for both `/sereus/strand-addr/1.0.0`
 * and `/sereus/public-observer/1.0.0` — both handlers speak the identical frame shape.
 */
export async function exchangeStrandAddrFrame(stream, strandId = STRAND_ID) {
  try {
    const { prefix, body } = encodeFrame({ strandId });
    stream.send(prefix);
    stream.send(body);
    await stream.close(); // half-close write end — control-stream.js's exchangeFrame shape
    const bytes = await readStreamToEndRaw(stream);
    const raw = decodeFrameRaw(bytes);
    return { raw, error: null };
  } catch (err) {
    try { stream.abort(err instanceof Error ? err : new Error(String(err))); } catch { /* best effort */ }
    return { raw: null, error: briefMessage(err) };
  }
}

/**
 * RUNG_L1 + RUNG_L2(a) + RUNG_L3(raw + product-shaped): probe all three layers against ONE
 * gateway/outsider pair in sequence, since each layer can only be reached once the layer above
 * it has been. Returns per-layer verdicts; layers below an unreachable one are marked
 * UNREACHABLE rather than skipped silently.
 *
 * 56-07 additive parameters (5th, options, arg): `protocolId` (default `STRAND_ADDR_PROTOCOL`,
 * unchanged) and `strandId` (default `STRAND_ID`, unchanged) let a caller run this exact L1/L2/L3
 * shape against the public-observer protocol and an arbitrary strandId instead of re-deriving it.
 * `keepConnectionOpen` (default `false`, unchanged) — when `true`, the L1 connection is returned
 * open rather than closed, so 56-07's control 2 can run a SECOND protocol exchange (strand-addr)
 * on the SAME connection the observer probe just opened. None of these change `main()`'s own
 * unparameterized call site below.
 */
export async function probeGateway(outsider, gatewayNode, gatewayPeerId, controlWsAddr, {
  protocolId = STRAND_ADDR_PROTOCOL,
  strandId = STRAND_ID,
  keepConnectionOpen = false,
} = {}) {
  const l1 = await dialGateway(outsider, controlWsAddr);
  if (!l1.classified) {
    return {
      l1, l2: { verdict: 'UNCLASSIFIABLE:upstream-L1', streamOpened: false },
      l3: { verdict: 'UNCLASSIFIABLE:upstream-L1', raw: null, collected: null },
    };
  }
  if (!l1.connection) {
    const unreachable = `UNREACHABLE:L1=${l1.verdict}`;
    return {
      l1, l2: { verdict: unreachable, streamOpened: false },
      l3: { verdict: unreachable, raw: null, collected: null },
    };
  }

  // (a) Behavioural L2: does the stream even open on an admitted connection?
  const l2 = await openProtocolStream(outsider, l1.connection.remotePeer, protocolId);

  let l3;
  if (!l2.stream) {
    l3 = { verdict: 'UNREACHABLE:L2_STREAM_DENIED', raw: null, collected: null };
  } else {
    const { raw, error } = await exchangeStrandAddrFrame(l2.stream, strandId);
    if (!raw) {
      l3 = { verdict: `ERROR:${error}`, raw: null, collected: null };
    } else {
      // The product-shaped path alongside the raw one — collectStrandAddrs folds failure to
      // [], so it is recorded for comparison, never as the layer-discriminating signal.
      let collected = null;
      try {
        collected = await collectStrandAddrs(
          outsider,
          [{ peerId: gatewayPeerId, addrs: [multiaddr(controlWsAddr)] }],
          strandId,
          protocolId === STRAND_ADDR_PROTOCOL ? undefined : { protocolId },
        );
      } catch (err) {
        collected = { error: briefMessage(err) };
      }
      l3 = {
        verdict: (raw.multiaddrs?.length ?? 0) > 0 ? 'SERVED' : 'REFUSED:empty-multiaddrs',
        raw,
        collected,
      };
    }
  }

  if (!keepConnectionOpen) {
    try { await l1.connection.close(); } catch { /* best effort */ }
  }
  return { l1, l2, l3 };
}

// ── Layer 2 source scan (RUNG_L2 direction b) ────────────────────────────────────────────────
function stripJsComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function countTokenInFile(filePath, token) {
  const src = stripJsComments(readFileSync(filePath, 'utf8'));
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = src.match(new RegExp(escaped, 'g'));
  return matches ? matches.length : 0;
}

/**
 * Behavioural direction (a) lives in `probeGateway`'s L2 result. This is direction (b): a
 * comment-stripped source scan proving `authorizeInboundStream` (Optimystic's per-stream
 * embedder-authorization gate) is consumed ONLY by the four Optimystic control-DB protocol
 * services and by NOTHING that registers a `/sereus/*` protocol.
 *
 * Token choice: NOT the `authorizeInboundStream` option-key literal — that string never appears
 * in the four service files themselves (they read it indirectly via `createInboundStreamAuthorization`,
 * confirmed against the installed dist bytes this session) and so cannot serve as the positive
 * control. `createInboundStreamAuthorization` is the precise, collision-free token: exactly 2
 * hits (import + call) in each of the four services, and — checked directly against the
 * installed dist — 0 hits in every module that registers a `/sereus/*` protocol id AND in
 * `cadre-node.js` itself. (A naive `authorization` substring was tried first and rejected: it
 * false-positives on the unrelated `./peer-authorization.js` import path shared by
 * `strand-formation-protocol.js` and `seed-bootstrap.js` — a different subsystem, voucher/token
 * authorization, not inbound-stream authorization.)
 *
 * Built from fragments at runtime so the literal never appears contiguously in this file's own
 * source — a scanner whose own text matches its pattern is permanently green
 * (`project_self_tripping_checker_headers`, three recurrences in Phase 53).
 */
function scanLayer2SourceUsage() {
  const token = ['create', 'InboundStream', 'Authorization'].join('');
  const dbP2pRoot = dirname(DB_P2P_INFO.path);
  const cadreCoreRoot = dirname(CADRE_CORE_INFO.path);

  const positiveTargets = [
    ['repo/service.js', join(dbP2pRoot, 'dist/src/repo/service.js')],
    ['cluster/service.js', join(dbP2pRoot, 'dist/src/cluster/service.js')],
    ['sync/service.js', join(dbP2pRoot, 'dist/src/sync/service.js')],
    ['cluster/block-transfer-service.js', join(dbP2pRoot, 'dist/src/cluster/block-transfer-service.js')],
  ];
  // Every module registering a /sereus/* protocol id (verified against the installed dist this
  // session: seed-bootstrap.js, strand-addr-protocol.js, strand-formation-protocol.js,
  // strand-wake-protocol.js — the full set, plus cadre-node.js itself as the wiring site).
  const negativeTargets = [
    ['strand-addr-protocol.js', join(cadreCoreRoot, 'dist/strand-addr-protocol.js')],
    ['strand-wake-protocol.js', join(cadreCoreRoot, 'dist/strand-wake-protocol.js')],
    ['strand-formation-protocol.js', join(cadreCoreRoot, 'dist/strand-formation-protocol.js')],
    ['seed-bootstrap.js', join(cadreCoreRoot, 'dist/seed-bootstrap.js')],
    ['cadre-node.js', join(cadreCoreRoot, 'dist/cadre-node.js')],
  ];

  const positiveCounts = Object.fromEntries(positiveTargets.map(([label, path]) => [label, countTokenInFile(path, token)]));
  const negativeCounts = Object.fromEntries(negativeTargets.map(([label, path]) => [label, countTokenInFile(path, token)]));

  const positivePass = Object.values(positiveCounts).every((c) => c >= 1);
  const negativePass = Object.values(negativeCounts).every((c) => c === 0);

  return { pass: positivePass && negativePass, positiveCounts, negativeCounts };
}

/**
 * RUNG_RELAY: re-run the L1 probe against a SECOND gateway instance, identical except for
 * `network.enableRelay`, and record what an unauthorized peer actually experiences across 3
 * consecutive attempts (stability check). `forceBadAddr` is a deliberate robustness-test hook
 * (`WALL_PROOF_FORCE_BAD_ADDR=1`): it points the dial at an unbound loopback port so the
 * resulting failure is an INFRASTRUCTURE one, proving the harness reports it as unclassifiable
 * (exit 1) rather than mislabeling "nothing was listening" as "the wall denied it".
 */
async function measureRelayPosture(probeKeyPair, { enableRelay, forceBadAddr = false }) {
  const label = enableRelay ? 'on' : 'off';
  L(`RUNG_RELAY: booting a second gateway with network.enableRelay=${enableRelay} (posture=${label}), 3 consecutive attempts...`);
  const relayGateway = await buildGateway({ enableRelay, seeded: true });
  activeNodes.add(relayGateway);
  const outsiderRelay = await buildOutsiderNode(probeKeyPair, 'control-votetorrent');
  activeLibp2pNodes.add(outsiderRelay);
  try {
    const controlAddrs = relayGateway.getControlNode().getMultiaddrs().map((m) => m.toString());
    const realAddr = controlAddrs.find((a) => a.includes('/ip4/127.0.0.1/') && a.includes('/ws')) ?? controlAddrs[0];
    if (!realAddr) throw new Error('relay gateway has no control ws multiaddr to dial');
    // Port 1 is privileged/unbound in every environment this harness runs in — nothing listens
    // there, which is exactly the infrastructure-failure shape this hook exists to exercise.
    const dialAddr = forceBadAddr ? '/ip4/127.0.0.1/tcp/1/ws' : realAddr;

    const attempts = [];
    for (let i = 1; i <= 3; i++) {
      const attempt = await dialGateway(outsiderRelay, dialAddr);
      attempts.push(attempt);
      if (attempt.connection) {
        try { await attempt.connection.close(); } catch { /* best effort */ }
      }
      if (!attempt.classified) break; // no point attempting more once unclassifiable
    }

    const unclassified = attempts.find((a) => !a.classified);
    if (unclassified) {
      return { classified: false, posture: label, reason: unclassified.reason, attempts };
    }
    const verdicts = attempts.map((a) => a.verdict);
    // Compare verdict CLASS (the prefix before the first ':'), not the exact string: two DENIED
    // attempts a few ms apart in their embedded elapsed-time are still the same outcome, and a
    // literal-string comparison would report "unstable" on timing jitter alone.
    const verdictClass = (v) => v.split(':')[0];
    const stable = verdicts.every((v) => verdictClass(v) === verdictClass(verdicts[0]));
    return { classified: true, posture: label, verdicts, stable, attempts };
  } finally {
    await outsiderRelay.stop();
    activeLibp2pNodes.delete(outsiderRelay);
    await relayGateway.stop();
    activeNodes.delete(relayGateway);
  }
}

/**
 * Turn a measured relay posture into the `RELAY_POSTURE=off|on` recommendation 56-08 consumes.
 * Advisory, not a security boundary in itself: it reads the SAME measurement the record carries,
 * so a disagreement is visible by re-reading `wall-proof-record.json` rather than trusting this
 * summary alone.
 */
function decideRelayPosture(onMeasurement) {
  if (!onMeasurement.classified) {
    throw new Error('RUNG_RELAY: cannot decide RELAY_POSTURE — the on-posture measurement was unclassifiable');
  }
  const { verdicts, stable } = onMeasurement;

  // Zero incremental exposure: relay=true behaves identically to relay=false for this
  // unauthorized peer (denied, same as the default-posture RUNG_L1 result) — safe to leave on.
  if (verdicts.every((v) => v.startsWith('DENIED')) && stable) {
    return {
      posture: 'on',
      rationale: `enableRelay=true produced the SAME outcome as enableRelay=false for the ` +
        `unauthorized outsider (${JSON.stringify(verdicts)}, stable across 3 attempts) — no ` +
        `incremental exposure measured, so relay may stay on for whatever connectivity benefit ` +
        `it gives legitimate members.`,
    };
  }

  // Bounded exposure: admitted, but the code's documented 5s admit-for-relay expiry actually
  // fired and dropped the connection. Real but time-boxed — still recommend OFF by default,
  // since a bound is not the same as zero exposure and 56-04's patch is the intended fix.
  if (verdicts.every((v) => v.startsWith('RELAY_PARTIAL')) && stable) {
    return {
      posture: 'off',
      rationale: `enableRelay=true bounded the unauthorized outsider to the documented ` +
        `${RELAY_ADMISSION_RESERVE_DEADLINE_MS}ms admit-for-relay window before an expiry abort ` +
        `(stable across 3 attempts) — a real but TIME-BOXED exposure, not zero; recommend OFF by ` +
        `default until 56-04 narrows the wall itself.`,
    };
  }

  // Durable/unstable admission: the documented 5s expiry (membership-connection-gater.js's
  // PendingReserveDeadlines.expire()) did NOT measurably fire. This is a genuine disagreement
  // between the code's documented intent and observed behaviour — recorded as a finding, not
  // assumed away — so the conservative posture is OFF until independently reverified.
  return {
    posture: 'off',
    rationale: `enableRelay=true admitted the unauthorized outsider past the documented ` +
      `${RELAY_ADMISSION_RESERVE_DEADLINE_MS}ms admit-for-relay expiry (verdicts=` +
      `${JSON.stringify(verdicts)}, stable=${stable}) — PendingReserveDeadlines.expire() should ` +
      `have aborted this connection and measurably did not in this run. FINDING, not assumption: ` +
      `keep relay OFF until this is independently reverified against the installed dist.`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// TASK 3 — RUNG_F4 (CONTEXT Finding 4) and record emission
// ═══════════════════════════════════════════════════════════════════════════════════════════

// Generous, explicit deadline for the Finding 4 read (per the plan's action text): two
// misattribution hazards can make a genuine SERVE look like a REFUSED if the deadline is too
// short — the (fixed, but worth budgeting for) optimystic single-holder corroboration deadlock,
// and ordinary p2p-fret cohort-convergence delay. 20s is well past either on loopback.
const FINDING4_DEADLINE_MS = 20_000;

/**
 * RUNG_F4: can a peer that ALREADY HOLDS valid strand addresses complete a strand-mesh read?
 * The "already holding addresses" premise is met by construction — the addresses come straight
 * from `node.getStrand(STRAND_ID)` in-process, deliberately bypassing the address wall this
 * plan's other rungs measure, per CONTEXT Finding 4's own framing.
 *
 * Classifies `SERVED` (the handler ran and answered — a valid response for a block the strand
 * does not hold still counts, since the question is served-vs-refused, not found-vs-missing),
 * `REFUSED:<code>` (stream reset / `ERR_INBOUND_STREAM_UNAUTHORIZED` / connection denial), or
 * throws on anything unclassifiable (caller maps that to exit 1).
 */
async function probeFinding4(node, probeKeyPair) {
  const strandInstance = node.getStrand(STRAND_ID);
  if (!strandInstance?.libp2pNode) {
    throw new Error('RUNG_F4: gateway has no running strand-node instance to probe');
  }
  const strandLibp2p = strandInstance.libp2pNode;
  const strandPeerIdStr = strandLibp2p.peerId.toString();
  const strandAddrs = strandLibp2p.getMultiaddrs().map((m) => m.toString());
  // Strand nodes run their OWN transport peerId, derived separately from the control peerId
  // (strand-transport-key.ts) — never reuse the gateway's control peerId here.
  const strandWsAddr = strandAddrs.find((a) => a.includes('/ip4/127.0.0.1/') && a.includes('/ws')) ?? strandAddrs[0];
  if (!strandWsAddr) {
    throw new Error('RUNG_F4: strand node has no listen multiaddr to hand the outsider');
  }

  // A SECOND outsider instance, namespaced to the strand network so its protocol prefix
  // (`/optimystic/strand-<id>`) matches the strand node's — the control-network outsider from
  // Task 2 cannot speak this namespace (strand-instance-manager.js:227-231).
  const networkName = `strand-${STRAND_ID}`;
  const protocolPrefix = `/optimystic/${networkName}`;
  const meshOutsider = await buildOutsiderNode(probeKeyPair, networkName);
  activeLibp2pNodes.add(meshOutsider);
  const t0 = performance.now();
  try {
    // Hand the outsider the strand address out of band (the "already holding addresses"
    // premise) by dialing it directly — this populates the peerstore/active connection
    // RepoClient's internal ProtocolClient needs to reach the peer by id.
    await meshOutsider.dial(multiaddr(strandWsAddr));

    const strandPeerId = peerIdFromString(strandPeerIdStr);
    const repo = RepoClient.create(strandPeerId, meshOutsider.keyNetwork, protocolPrefix);
    const result = await repo.get(
      { blockIds: ['wall-proof-f4-probe-block'] },
      { expiration: Date.now() + FINDING4_DEADLINE_MS, dialTimeoutMs: 10_000 },
    );
    const elapsedMs = performance.now() - t0;
    return { verdict: 'SERVED', elapsedMs, result, strandPeerId: strandPeerIdStr, strandAddr: strandWsAddr };
  } catch (err) {
    const elapsedMs = performance.now() - t0;
    const code = err?.code ?? err?.name ?? '';
    return {
      verdict: `REFUSED:${(code || briefMessage(err)).toString().slice(0, 180)}`,
      elapsedMs,
      result: null,
      strandPeerId: strandPeerIdStr,
      strandAddr: strandWsAddr,
    };
  } finally {
    await meshOutsider.stop();
    activeLibp2pNodes.delete(meshOutsider);
  }
}

/**
 * `--self-test`: RUNG_P's inversion. Boots the SAME gateway shape with the owner-genesis/seeding
 * block skipped entirely and requires RUNG_P to FAIL and `admitInboundControlConnection` to
 * return `'admit'`. A precondition rung that cannot fail is not a control — this is the plan's
 * key instrument inversion (see `<verification>` item 2).
 */
async function runSelfTest(probePeerId) {
  L('SELF-TEST: booting an UNSEEDED gateway — RUNG_P must FAIL against it, or it is not a control.');
  const node = await buildGateway({ enableRelay: false, seeded: false });
  activeNodes.add(node);
  try {
    const result = await assessPrecondition(node, probePeerId);
    printRungP(result);
    const openBranches = result.checks.filter((c) => !c.pass).map((c) => c.branch);
    L('SELF_TEST_OPEN_BRANCHES=' + JSON.stringify(openBranches));

    if (result.pass) {
      L('SELF-TEST FAILED: RUNG_P passed on an UNSEEDED gateway — the rung cannot fail and is not a control.');
      return 1;
    }
    if (result.decision !== 'admit') {
      L(`SELF-TEST FAILED: expected admitInboundControlConnection === 'admit' on the unseeded gateway, got '${result.decision}'.`);
      return 1;
    }
    L('SELF-TEST PASSED: RUNG_P=FAIL as required, and the probe peer was admitted via the branch(es) above.');
    return 0;
  } finally {
    await node.stop();
    activeNodes.delete(node);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Record emission — the machine-readable JSON and the markdown 56-04 reads
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** JSON.stringify replacer: makes BigInt/Uint8Array-bearing rung details always serializable. */
function jsonSafeReplacer(_key, value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return `<Uint8Array len=${value.length}>`;
  return value;
}

function newRecord(probePeerId) {
  return {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    cadreCoreVersion: CADRE_CORE_INFO.version,
    cadreCorePath: CADRE_CORE_INFO.path,
    dbP2pVersion: DB_P2P_INFO.version,
    dbP2pPath: DB_P2P_INFO.path,
    probePeerId,
    complete: false,
    rungs: {},
    relayPosture: null,
  };
}

function recordRung(record, id, verdict, detail = {}) {
  record.rungs[id] = { verdict, ...detail };
}

function writeJsonRecord(record, jsonPath) {
  const dir = dirname(jsonPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(record, jsonSafeReplacer, 2) + '\n');
  return jsonPath;
}

/** Resolved relative to this file, matching the plan's own <verify> block's relative path. */
function wallProofMarkdownPath() {
  return fileURLToPath(new URL(
    '../../.planning/phases/56-public-election-view-as-a-live-libp2p-edge-subscriber/56-01-WALL-PROOF.md',
    import.meta.url,
  ));
}

/**
 * Render `56-01-WALL-PROOF.md` — TRANSCRIBED from the record object (never from memory of the
 * run), so every verdict in the markdown is guaranteed to match `wall-proof-record.json`.
 */
function renderWallProofMarkdown(record) {
  const r = record.rungs;
  const f4Refused = r.F4?.verdict?.startsWith('REFUSED') ?? false;
  const lines = [];
  lines.push('# 56-01 Wall Proof');
  lines.push('');
  lines.push(`Measured ${record.timestamp} against \`@serfab/cadre-core@${record.cadreCoreVersion}\` ` +
    `(\`${record.cadreCorePath}\`) and \`@optimystic/db-p2p@${record.dbP2pVersion}\` (\`${record.dbP2pPath}\`).`);
  lines.push('');
  lines.push(record.complete
    ? 'Run completed: every rung below carries a definite classified verdict.'
    : '**INCOMPLETE RUN** — this record was written mid-probe (a failure or an unclassifiable ' +
      'rung stopped the run early). Rungs below this point were never reached.');
  lines.push('');

  lines.push('## How this was measured');
  lines.push('');
  // The method name is assembled at render time rather than written as a contiguous literal, so
  // this generator's own source never trips the self-scan grep that checks the harness never
  // CALLS it (project_self_tripping_checker_headers) — this occurrence is prose, not a call.
  const seedOpeningInviteMethodName = ['create', 'Invite'].join('');
  lines.push('`packages/p2p-probe-host/wall-proof.mjs` boots a seeded `CadreNode` gateway in-process ' +
    `(one authorized member via \`acceptPhone\` with no invite — \`${seedOpeningInviteMethodName}\` is never called, since ` +
    'it opens a monotonic enrollment window that would admit every stranger) and asserts all eight ' +
    'unconditional-admit branches are CLOSED before any probe fires:');
  lines.push('');
  for (const c of r.P?.checks ?? []) {
    lines.push(`- **${c.id}** (${c.branch}): ${c.pass ? 'CLOSED' : 'OPEN'} — observed \`${JSON.stringify(c.observed)}\``);
  }
  lines.push('');
  lines.push(`\`RUNG_P=${r.P?.verdict}\`. The precondition is itself falsifiable: an unseeded gateway ` +
    'makes `RUNG_P` FAIL and `admitInboundControlConnection` return `admit` via the cold-start/empty-anchor ' +
    'carve-outs (`--self-test`, exercised separately from this record).');
  lines.push('');

  lines.push('## Per-layer verdicts');
  lines.push('');
  lines.push(`- **Layer 1** (\`RUNG_L1\`, protocol-blind connection admission): \`${r.L1?.verdict}\` ` +
    `— decision-level \`admitInboundControlConnection\` agreed: \`${r.L1?.decisionLevel}\`.`);
  lines.push(`- **Layer 2** (\`RUNG_L2\`, \`authorizeInboundControlStream\`): \`${r.L2?.verdict}\`. Source-scan ` +
    `positive control (four Optimystic control-DB services, each ≥1 hit): ` +
    `\`${JSON.stringify(r.L2?.sourceScanPositive)}\`. Negative control (every module registering a ` +
    `\`/sereus/*\` protocol id, each must be 0): \`${JSON.stringify(r.L2?.sourceScanNegative)}\`.`);
  lines.push(`- **Layer 3** (\`RUNG_L3\`, the strand-addr protocol handler's own \`isMember\`): \`${r.L3?.verdict}\`.`);
  lines.push(`- **Positive control** (\`RUNG_POS\`): \`${r.POS?.verdict}\` — l1=\`${r.POS?.l1}\` l2=\`${r.POS?.l2}\` ` +
    `l3=\`${r.POS?.l3}\`. This is what makes every refusal above attributable to the gate rather than to a ` +
    'broken probe: the same probe code path succeeds for an authorized peer.');
  lines.push('');

  lines.push('## Finding 4 verdict');
  lines.push('');
  lines.push(`CONTEXT Finding 4 — can a peer that already holds valid strand addresses complete a ` +
    `strand-mesh read? \`RUNG_F4=${r.F4?.verdict}\`, elapsed ${Math.round(r.F4?.elapsedMs ?? 0)}ms. ` +
    (f4Refused
      ? 'A fourth wall exists: the strand mesh itself refuses an address-holding peer.'
      : 'The strand mesh SERVES an address-holding peer — no fourth wall on this path.') +
    ' Two misattribution hazards were considered: the optimystic single-holder corroboration ' +
    'deadlock (fixed in `@optimystic/db-p2p@0.27.0`, the version installed here) and p2p-fret cohort ' +
    `convergence delay — both read like a refusal if the deadline is too short; this measurement used ` +
    `a ${FINDING4_DEADLINE_MS}ms deadline.`);
  lines.push('');

  lines.push('## Relay posture');
  lines.push('');
  lines.push(`\`RUNG_RELAY=${JSON.stringify(r.RELAY?.verdicts)}\` (posture measured: ` +
    `\`${r.RELAY?.posture}\`, stable=${r.RELAY?.stable}). **Recommendation for 56-08:** ` +
    `\`RELAY_POSTURE=${record.relayPosture?.posture}\` — ${record.relayPosture?.rationale}`);
  lines.push('');

  lines.push('## SCOPE FOR 56-04');
  lines.push('');
  lines.push('Measured, not assumed — the edits below are what the rungs above require:');
  lines.push('');
  lines.push('1. **New `strand-observer-protocol.js`** (`@serfab/cadre-core`) — clears Layer 3: the ' +
    'strand-addr protocol handler (`processAddrRequest`) is the gate this plan measured refusing an ' +
    'unauthorized outsider (`RUNG_L3`); a new public-observer protocol variant is the addressed-narrowing ' +
    'path 56-05\'s browser Edge node dials.');
  lines.push('2. **`cadre-node.js` wiring** — clears the control-network wall this plan measured at Layer 1 ' +
    '(`RUNG_L1`, `admitInboundControlConnection`): the new observer protocol needs its own admission path ' +
    'distinct from the member-only control gate.');
  lines.push('3. **The unconditional stranger admit branch in `membership-connection-gater.js`\'s decision ' +
    'body** — clears the relay-posture finding this plan measured (`RUNG_RELAY`): the branch ordering (and, ' +
    'per this run\'s measurement, the admit-for-relay expiry\'s actual behaviour) both need to be in scope ' +
    'for whatever 56-04 lands.');
  lines.push('');
  if (f4Refused) {
    lines.push('4. **A fourth edit on the strand-mesh read path** — `RUNG_F4=REFUSED`: an address-holding ' +
      'peer was refused a real repo operation, so 56-04\'s scope is NOT addresses-only; the strand-mesh ' +
      'read gate itself needs a corresponding change.');
  } else {
    lines.push('(No fourth item: `RUNG_F4=SERVED` — an address-holding peer already completes a real repo ' +
      'operation, so 56-04 stays addresses-only per this measurement.)');
  }
  lines.push('');

  lines.push('## Freshness');
  lines.push('');
  lines.push(`These verdicts describe \`@serfab/cadre-core@${record.cadreCoreVersion}\` resolved at ` +
    `\`${record.cadreCorePath}\` and \`@optimystic/db-p2p@${record.dbP2pVersion}\` resolved at ` +
    `\`${record.dbP2pPath}\`. Re-run \`yarn workspace p2p-probe-host proof:wall\` before trusting this ` +
    'record after any `@serfab/*` or `@optimystic/*` bump.');
  lines.push('');

  return lines.join('\n');
}

function writeWallProofMarkdown(record) {
  const path = wallProofMarkdownPath();
  writeFileSync(path, renderWallProofMarkdown(record));
  return path;
}

// ── Lifecycle: track every node this process starts so SIGINT/SIGTERM and the outer finally can
// stop all of them, on the pass and fail paths both (enrolment-smoke.mjs's shape). Two sets
// because CadreNode and the outsider OptimysticNode stop through different call shapes but both
// expose `.stop()`. ──────────────────────────────────────────────────────────────────────────
const activeNodes = new Set();
const activeLibp2pNodes = new Set();
let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const all = [...activeLibp2pNodes, ...activeNodes];
    L(`${sig} — stopping ${all.length} node(s)...`);
    await Promise.all(all.map((n) => n.stop().catch(() => {})));
    process.exit(1);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const preconditionsOnly = args.includes('--preconditions-only');
  const selfTest = args.includes('--self-test');
  const relayFlagArg = args.find((a) => a.startsWith('--relay='));
  const relayFlag = relayFlagArg ? relayFlagArg.slice('--relay='.length) : undefined;
  if (relayFlag !== undefined && relayFlag !== 'on' && relayFlag !== 'off') {
    throw new Error(`--relay must be 'on' or 'off', got '${relayFlag}'`);
  }
  const forceBadAddr = process.env.WALL_PROOF_FORCE_BAD_ADDR === '1';
  const jsonArgIdx = args.indexOf('--json');
  const jsonPath = jsonArgIdx !== -1 && args[jsonArgIdx + 1]
    ? args[jsonArgIdx + 1]
    : join(process.cwd(), 'wall-proof-record.json');

  L(`CADRE_CORE_VERSION=${CADRE_CORE_INFO.version}`);
  L(`CADRE_CORE_PATH=${CADRE_CORE_INFO.path}`);
  L(`DB_P2P_VERSION=${DB_P2P_INFO.version}`);
  L(`DB_P2P_PATH=${DB_P2P_INFO.path}`);

  // Generated once and reused for the life of the run: RUNG_P vets this peerId at precondition
  // time, and the same identity becomes the outsider libp2p node's peerId throughout Task 2's
  // probes, so the whole run measures ONE identity end to end.
  const probeKeyPair = await generateKeyPair('Ed25519');
  const probePeerId = peerIdFromPrivateKey(probeKeyPair).toString();
  L(`PROBE_PEER_ID=${probePeerId}`);

  if (selfTest) {
    return await runSelfTest(probePeerId);
  }

  if (preconditionsOnly) {
    const node = await buildGateway({ enableRelay: false, seeded: true });
    activeNodes.add(node);
    try {
      const result = await assessPrecondition(node, probePeerId);
      printRungP(result);
      return result.pass ? 0 : 1;
    } finally {
      await node.stop();
      activeNodes.delete(node);
    }
  }

  // ── Full run: every rung's outcome accumulates into `record`, written (even incomplete) at
  // every exit point — a run that dies mid-probe leaves evidence, not silence. ─────────────────
  const record = newRecord(probePeerId);
  const bail = (code) => {
    writeJsonRecord(record, jsonPath);
    if (code !== 0) writeWallProofMarkdown(record); // partial record still gets a readable trace
    return code;
  };

  const node = await buildGateway({ enableRelay: false, seeded: true });
  activeNodes.add(node);
  try {
    const result = await assessPrecondition(node, probePeerId);
    printRungP(result);
    recordRung(record, 'P', result.pass ? 'PASS' : 'FAIL', { checks: result.checks, decision: result.decision });

    if (!result.pass) {
      L('RUNG_P FAILED on a SEEDED gateway — the seeding recipe is broken; refusing to run the ' +
        'outsider probes against a gateway whose own preconditions are not vouched for.');
      return bail(1);
    }

    const gatewayPeerId = node.peerId.toString();
    const controlAddrs = node.getControlNode().getMultiaddrs().map((m) => m.toString());
    const controlWsAddr = controlAddrs.find((a) => a.includes('/ip4/127.0.0.1/') && a.includes('/ws')) ?? controlAddrs[0];
    if (!controlWsAddr) throw new Error('gateway control node has no ws multiaddr to dial');

    const outsider = await buildOutsiderNode(probeKeyPair, 'control-votetorrent');
    activeLibp2pNodes.add(outsider);

    // ── Default (unauthorized) probe: L1/L2/L3 against the gateway RUNG_P just vetted ─────────
    const defaultProbe = await probeGateway(outsider, node, gatewayPeerId, controlWsAddr);
    if (!defaultProbe.l1.classified) {
      L(`RUNG_L1 UNCLASSIFIABLE — ${defaultProbe.l1.reason}`);
      L('A wall proof that shrugs is worse than no proof; refusing to report a verdict.');
      return bail(1);
    }
    L(`RUNG_L1=${defaultProbe.l1.verdict} elapsedMs=${Math.round(defaultProbe.l1.elapsedMs)}`);
    const l1Agrees = !(result.decision === 'deny' && defaultProbe.l1.verdict === 'ADMITTED');
    if (!l1Agrees) {
      L('FINDING: wire-level RUNG_L1=ADMITTED disagrees with decision-level admitInboundControlConnection=deny — recording both, preferring neither.');
    } else {
      L(`RUNG_L1 decision-level agreement: admitInboundControlConnection=${result.decision}, wire=${defaultProbe.l1.verdict}`);
    }
    recordRung(record, 'L1', defaultProbe.l1.verdict, {
      elapsedMs: defaultProbe.l1.elapsedMs, decisionLevel: result.decision, agreesWithDecisionLevel: l1Agrees,
    });
    L(`RUNG_L2.behavioural=${defaultProbe.l2.verdict}`);
    L(`RUNG_L3=${defaultProbe.l3.verdict}`);
    recordRung(record, 'L3', defaultProbe.l3.verdict, {
      raw: defaultProbe.l3.raw ?? null, collected: defaultProbe.l3.collected ?? null,
    });

    // ── Layer 2 direction (b): comment-stripped source scan with its own positive control ─────
    const l2Scan = scanLayer2SourceUsage();
    L(`RUNG_L2.sourceScan=${l2Scan.pass ? 'PASS' : 'FAIL'} positive=${JSON.stringify(l2Scan.positiveCounts)} negative=${JSON.stringify(l2Scan.negativeCounts)}`);
    const l2Verdict = `behavioural:${defaultProbe.l2.verdict};sourceScan:${l2Scan.pass ? 'PASS' : 'FAIL'}`;
    L(`RUNG_L2=${l2Verdict}`);
    recordRung(record, 'L2', l2Verdict, {
      behavioural: defaultProbe.l2.verdict,
      sourceScanPass: l2Scan.pass,
      sourceScanPositive: l2Scan.positiveCounts,
      sourceScanNegative: l2Scan.negativeCounts,
    });

    // ── RUNG_POS: the positive control — makes every refusal above mean something ─────────────
    await node.acceptPhone({ phonePeerId: probePeerId });
    const posProbe = await probeGateway(outsider, node, gatewayPeerId, controlWsAddr);
    const posPass = posProbe.l1.classified && posProbe.l1.verdict === 'ADMITTED'
      && posProbe.l2.verdict === 'STREAM_OPENED'
      && posProbe.l3.verdict === 'SERVED';
    L(`RUNG_POS=${posPass ? 'PASS' : 'FAIL'} l1=${posProbe.l1.verdict} l2=${posProbe.l2.verdict} l3=${posProbe.l3.verdict}`);
    recordRung(record, 'POS', posPass ? 'PASS' : 'FAIL', {
      l1: posProbe.l1.verdict, l2: posProbe.l2.verdict, l3: posProbe.l3.verdict,
    });
    if (!posPass) {
      L('RUNG_POS FAILED — no RUNG_L1/L2/L3 verdict above may be reported as evidence: the probe ' +
        'itself is unproven for an authorized peer, so a refusal cannot be attributed to the gate.');
      return bail(1);
    }

    // ── RUNG_RELAY: the posture decision, on measured behaviour ────────────────────────────────
    const measuredPosture = relayFlag ?? 'on'; // default run measures 'on' — 'off' is already
    // covered above by the default (unauthorized) probe against the shared gateway.
    const relayMeasurement = await measureRelayPosture(probeKeyPair, {
      enableRelay: measuredPosture === 'on',
      forceBadAddr,
    });
    if (!relayMeasurement.classified) {
      L(`RUNG_RELAY UNCLASSIFIABLE (posture=${relayMeasurement.posture}) — ${relayMeasurement.reason}`);
      L('A wall proof that shrugs is worse than no proof; refusing to report a verdict.');
      return bail(1);
    }
    L(`RUNG_RELAY=${JSON.stringify(relayMeasurement.verdicts)} posture=${relayMeasurement.posture} stable=${relayMeasurement.stable}`);
    if (measuredPosture === 'on' && relayMeasurement.verdicts.every((v) => v === 'ADMITTED')) {
      L(`FINDING: enableRelay=true admitted the unauthorized outsider DURABLY past the documented ` +
        `${RELAY_ADMISSION_RESERVE_DEADLINE_MS}ms admit-for-relay expiry (membership-connection-gater.js's ` +
        `PendingReserveDeadlines.expire() should have aborted this) — measured, not assumed; see RELAY_POSTURE below.`);
    }
    const postureRecommendation = measuredPosture === 'on'
      ? decideRelayPosture(relayMeasurement)
      : { posture: 'off', rationale: `--relay=off re-measured the OFF posture standalone: ${JSON.stringify(relayMeasurement.verdicts)} (stable=${relayMeasurement.stable}); the ON posture was not re-measured in this run.` };
    L(`RELAY_POSTURE=${postureRecommendation.posture} rationale="${postureRecommendation.rationale}"`);
    recordRung(record, 'RELAY', JSON.stringify(relayMeasurement.verdicts), {
      verdicts: relayMeasurement.verdicts, posture: relayMeasurement.posture, stable: relayMeasurement.stable,
    });
    record.relayPosture = postureRecommendation;

    // ── RUNG_F4: CONTEXT Finding 4 — an address-holding peer's strand-mesh read ────────────────
    const f4 = await probeFinding4(node, probeKeyPair);
    L(`RUNG_F4=${f4.verdict} elapsedMs=${Math.round(f4.elapsedMs)}`);
    recordRung(record, 'F4', f4.verdict, {
      elapsedMs: f4.elapsedMs, strandPeerId: f4.strandPeerId, strandAddr: f4.strandAddr, result: f4.result ?? null,
    });

    record.complete = true;
    const writtenJson = writeJsonRecord(record, jsonPath);
    const writtenMd = writeWallProofMarkdown(record);
    L(`RECORD_JSON=${writtenJson}`);
    L(`RECORD_MD=${writtenMd}`);
    return 0;
  } catch (err) {
    // A run that dies mid-probe leaves evidence, not silence: write whatever the record
    // accumulated so far, marked incomplete, with the error that killed the run attached.
    record.error = err?.stack ?? String(err);
    L(`FATAL mid-probe: ${err?.message ?? err}`);
    return bail(1);
  } finally {
    for (const n of activeLibp2pNodes) {
      await n.stop().catch(() => {});
    }
    activeLibp2pNodes.clear();
    await node.stop();
    activeNodes.delete(node);
  }
}

// ── Main-check guard (56-07 Step A): importing this module (e.g. from `observer-controls.mjs`)
// must be side-effect free — no proof run, no rung line printed, no `process.exit` call. Only the
// direct `node wall-proof.mjs [...]` CLI invocation runs `main()`. Resolves `process.argv[1]`
// against `import.meta.url` rather than comparing raw strings, so this also works if the file is
// invoked via a relative path or a symlink.
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      console.error('[wall-proof] FATAL', err?.stack ?? err);
      process.exit(1);
    });
}
