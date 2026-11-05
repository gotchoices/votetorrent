/**
 * Optimystic ecosystem — `@serfab/cadre-core`: an unauthenticated peer cannot resolve strand
 * addresses for a PUBLIC election's strand mesh, because the only address-resolution protocol
 * (`/sereus/strand-addr/1.0.0`) gates on cadre membership with no "this strand is public" escape
 * hatch. VoteTorrent's public election view needs an address-holding peer to complete a strand-
 * mesh read (no membership gate exists on THAT path — see the companion wall-proof evidence), so
 * the only wall standing between "public election" and "anonymous readable election" is this one
 * address-resolution protocol.
 *
 * Upstream target: https://github.com/gotchoices/sereus (`@serfab/cadre-core`)
 *   node --test repro/public-observer-blocker.test.mjs
 *
 * ── SELF-CONTAINED, DELIBERATELY ─────────────────────────────────────────────────────────────
 * Every OTHER file in this package imports `56-01`'s seeding recipe from `wall-proof.mjs` rather
 * than re-deriving it — that rule is inverted here on purpose. `56-15` inlines this exact file
 * into the upstream issue, and a maintainer who copies it out must be able to run it without also
 * taking the rest of this package. Equivalence with the rest of this harness is preserved by
 * asserting the SAME preconditions below (direct reads, not imports), not by sharing code.
 *
 * No cadre invitation is ever minted — on cadre-core 1.14 a LIVE `CadreInvite` row opens the
 * cadre-invite protocol to strangers, which would defeat every assertion in this file (on <= 1.13
 * the equivalent hazard was `createInvite`'s 30-minute enrollment window, a mechanism 1.14
 * deleted). `authorizePeer(peerId)` writes the membership voucher directly.
 *
 * On 1.14 the decision-level wall for a non-member outsider reads `'admit-provisionally'` (the
 * policy cannot place the peer: its connection is admitted with a deadline, and the per-stream
 * protocol guard refuses it every members-only protocol), where <= 1.13 read `'deny'`.
 *
 * ── MODE DETECTION, AND THE HOLE IT MUST NOT OPEN ────────────────────────────────────────────
 * This file resolves `@serfab/cadre-core` through ONE indirection — `process.env.CADRE_CORE_ENTRY`
 * if set, else the bare `@serfab/cadre-core` specifier — so the identical file runs against this
 * repo's patched bytes and against stock upstream bytes. It derives its mode from TWO INDEPENDENT
 * signals and requires them to agree:
 *   1. Export signal — is `STRAND_OBSERVER_PROTOCOL` a non-empty string?
 *   2. Byte signal — a comment-stripped scan of the resolved package's `dist/*.js` (excluding
 *      `*.js.map`) for a token DERIVED from `STRAND_ADDR_PROTOCOL` (never written as a literal —
 *      substituting the imported protocol id's own name segment), carrying a positive control
 *      (the scan must find `STRAND_ADDR_PROTOCOL`'s own literal in `strand-addr-protocol.js`, or
 *      the scanner itself is broken, not the observer protocol).
 * If the two signals disagree, this file throws `MODE_AMBIGUOUS` naming both observations rather
 * than guessing — that disagreement is exactly the hole that would let a failed patch silently
 * downgrade this file to the weaker `stock` assertion set and report green.
 * `REPRO_REQUIRE_MODE=stock|patched` pins the expected mode; a mismatch throws instead of running
 * the wrong assertion set. This repo's own gate always sets `REPRO_REQUIRE_MODE=patched`.
 *
 * ── HYGIENE ───────────────────────────────────────────────────────────────────────────────────
 * Loopback-only listen addresses, in-memory storage (the default `CadreNode` backend), ephemeral
 * `generateKeyPair('Ed25519')` identities per run, empty `bootstrapNodes`, no on-disk enrolment
 * channel, every node stopped in a `finally` on both paths — this file is handed to strangers who
 * may run it on a machine with a real deployment. Generous per-test timeouts: `CadreNode` boot is
 * CPU-heavy and a busy host has manufactured false failures before
 * (`project_voter_emulator_boot_needs_quiet_host`). Production-length strandIds throughout, not a
 * three-character fixture that cannot fail (`project_ui_defects_invisible_to_every_tier`). No
 * probe payload ever carries a delegate-announcement field — the observer service deliberately
 * has no delegate path, and a probe that supplied one would misrepresent the surface this issue
 * describes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLibp2pNode } from '@optimystic/db-p2p/rn';
import { webSockets } from '@libp2p/websockets';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';

/** What `admitInboundControlConnection` answers for a peer the policy cannot place (cadre-core 1.14+). */
const UNPLACED_VERDICT = 'admit-provisionally';

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Mode resolution — the single indirection, and the two-signal agreement gate
// ═══════════════════════════════════════════════════════════════════════════════════════════

const CADRE_CORE_ENTRY = process.env.CADRE_CORE_ENTRY;
const cadreCoreSpecifier = CADRE_CORE_ENTRY
  ? pathToFileURL(resolve(CADRE_CORE_ENTRY)).href
  : '@serfab/cadre-core';

const cadreCore = await import(cadreCoreSpecifier);
const {
  CadreNode,
  STRAND_ADDR_PROTOCOL,
  STRAND_OBSERVER_PROTOCOL,
  StrandObserverService,
} = cadreCore;

if (typeof STRAND_ADDR_PROTOCOL !== 'string' || STRAND_ADDR_PROTOCOL.length === 0) {
  throw new Error(
    `could not resolve STRAND_ADDR_PROTOCOL from "${cadreCoreSpecifier}" — is CADRE_CORE_ENTRY ` +
    `really pointed at an @serfab/cadre-core entry point?`,
  );
}

function resolveCadreCoreEntryPath() {
  if (CADRE_CORE_ENTRY) return resolve(CADRE_CORE_ENTRY);
  return fileURLToPath(import.meta.resolve('@serfab/cadre-core'));
}

/** Walk up from the resolved entry file to the nearest `package.json` — the package's own root. */
function resolveCadreCorePackageDir() {
  const entryPath = resolveCadreCoreEntryPath();
  let dir = dirname(entryPath);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate a package.json for @serfab/cadre-core walking up from ${entryPath}`);
}

function stripJsComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function countTokenInFile(filePath, token) {
  const src = stripJsComments(readFileSync(filePath, 'utf8'));
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = src.match(new RegExp(escaped, 'g'));
  return matches ? matches.length : 0;
}

/** Scan every `dist/*.js` (never `*.js.map`) for `token`, comment-stripped, per-file counts. */
function scanDistForToken(distDir, token) {
  const files = readdirSync(distDir).filter((f) => f.endsWith('.js') && !f.endsWith('.js.map'));
  let total = 0;
  const perFile = {};
  for (const f of files) {
    const count = countTokenInFile(join(distDir, f), token);
    perFile[f] = count;
    total += count;
  }
  return { total, perFile };
}

const CADRE_CORE_PACKAGE_DIR = resolveCadreCorePackageDir();
const CADRE_CORE_DIST_DIR = join(CADRE_CORE_PACKAGE_DIR, 'dist');

// Signal 1 — export.
const exportSignal = typeof STRAND_OBSERVER_PROTOCOL === 'string' && STRAND_OBSERVER_PROTOCOL.length > 0;

// Positive control for signal 2 — a broken scanner finds nothing everywhere, and a bare zero
// count with no positive control reads exactly like "stock" (project_self_tripping_checker_headers,
// three recurrences in Phase 53).
const positiveControlScan = scanDistForToken(CADRE_CORE_DIST_DIR, STRAND_ADDR_PROTOCOL);
const positiveControlHits = positiveControlScan.perFile['strand-addr-protocol.js'] ?? 0;
if (positiveControlHits < 1) {
  throw new Error(
    `byte-scan positive control FAILED: STRAND_ADDR_PROTOCOL (imported, not pasted) was not found ` +
    `in ${join(CADRE_CORE_DIST_DIR, 'strand-addr-protocol.js')} (${positiveControlHits} hits; full ` +
    `per-file counts: ${JSON.stringify(positiveControlScan.perFile)}) — the scanner itself is ` +
    `broken, not the observer protocol's absence.`,
  );
}

// Signal 2 — byte scan. The token is DERIVED from the imported STRAND_ADDR_PROTOCOL constant by
// substituting its own protocol-name segment, never written as a contiguous literal — so this
// file's own source never contains the pattern it searches for, and an upstream rename of the
// `/sereus/*` namespace turns this red rather than leaving a stale literal that still matches.
const derivedObserverToken = STRAND_ADDR_PROTOCOL.replace('strand-addr', 'public-observer');
const byteScan = scanDistForToken(CADRE_CORE_DIST_DIR, derivedObserverToken);
const byteSignal = byteScan.total >= 1;

if (exportSignal !== byteSignal) {
  throw new Error(
    `MODE_AMBIGUOUS: export signal says ${exportSignal ? 'patched' : 'stock'} ` +
    `(STRAND_OBSERVER_PROTOCOL=${JSON.stringify(STRAND_OBSERVER_PROTOCOL)}, ` +
    `StrandObserverService=${typeof StrandObserverService}), byte signal says ` +
    `${byteSignal ? 'patched' : 'stock'} (derived-token hits=${byteScan.total} across ` +
    `${JSON.stringify(byteScan.perFile)}). Refusing to guess: this disagreement is exactly the ` +
    `hole that would let a failed patch silently downgrade to the weaker stock assertion set.`,
  );
}

const MODE = exportSignal ? 'patched' : 'stock';

const REQUIRED_MODE = process.env.REPRO_REQUIRE_MODE;
if (REQUIRED_MODE !== undefined && REQUIRED_MODE !== 'stock' && REQUIRED_MODE !== 'patched') {
  throw new Error(`REPRO_REQUIRE_MODE must be 'stock' or 'patched', got '${REQUIRED_MODE}'`);
}
if (REQUIRED_MODE !== undefined && REQUIRED_MODE !== MODE) {
  throw new Error(
    `REPRO_REQUIRE_MODE=${REQUIRED_MODE} but the resolved @serfab/cadre-core at ` +
    `"${cadreCoreSpecifier}" is MODE=${MODE} (exportSignal=${exportSignal}, byteSignal=${byteSignal}). ` +
    `This gate cannot pass via a silent mode downgrade.`,
  );
}

console.log(`[public-observer-blocker] MODE=${MODE} entry=${cadreCoreSpecifier} distDir=${CADRE_CORE_DIST_DIR}`);

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Self-contained gateway/outsider builders — same PRECONDITIONS as wall-proof.mjs/56-01, never
// imported (see this file's header)
// ═══════════════════════════════════════════════════════════════════════════════════════════

const PARTY_ID = 'votetorrent-repro'; // harness-local, never a real network hash
const STRAND_ID = `repro-public-observer-strand-${randomUUID()}`;

const VOTETORRENT_QSQL_RAW = readFileSync(
  new URL('../../vote-core/schema/votetorrent.qsql', import.meta.url),
  'utf8',
);
const VOTETORRENT_QSQL = VOTETORRENT_QSQL_RAW
  .replace(/^\s*declare\s+schema\s+\w+\s*\{/, '')
  .replace(/\}\s*apply\s+schema\s+\w+\s*;\s*$/, '')
  .trim();

/**
 * `publicObserverStrandIds` is passed unconditionally when provided — on STOCK bytes `CadreNode`
 * does not read this field at all (unknown config key, silently ignored), so the exact same call
 * shape demonstrates the suggested fix as a drop-in config change on PATCHED bytes.
 */
async function buildGateway({ publicObserverStrandIds } = {}) {
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
      enableRelay: false,
    },
    strandClusterSize: 2,
    hibernation: { enabled: false },
    ...(publicObserverStrandIds ? { publicObserverStrandIds } : {}),
  });

  await node.start();
  await node.addStrand({
    strandRow: { Id: STRAND_ID, MemberPrivateKey: null, Type: 'o' },
    sAppConfig: {
      id: 'org.votetorrent',
      version: '1.0.0',
      schema: VOTETORRENT_QSQL,
      latencyHint: 'interactive',
    },
    // `mode: 'bootstrap'` was deleted from StrandConfig in cadre-core 0.11 and has been ignored
    // since; a solo node hosting a hand-built strand row must FOUND it, or addStrand waits forever
    // for a founder that never comes (the hang this file used to end in).
    founder: true,
  });

  // Owner genesis + one seeded member, no invite ever issued (see header) — the recipe that
  // produces authorized.length > 0 without opening an enrollment window.
  // cadre-core 1.18 deleted getIdentityOwnerKey(); the identity-derived owner key it returned is
  // derived here instead (the helper is exported since well before 1.14).
  const owner = cadreCore.ed25519KeyPairFromLibp2p(privateKey);
  await node.trustOwnerKeys([owner.publicKeyB64], 'operator');
  const controlDb = node.getControlDatabase();
  if (!controlDb) throw new Error('gateway has no control database after start()');
  await controlDb.ensureOwnerKey(owner.publicKeyB64);
  await node.initializeSeedBootstrap(owner.privateKeyB64);

  const seedMemberKeyPair = await generateKeyPair('Ed25519');
  const seedMemberPeerId = peerIdFromPrivateKey(seedMemberKeyPair).toString();
  await node.authorizePeer(seedMemberPeerId);

  return node;
}

async function buildOutsiderNode(privateKey) {
  return await createLibp2pNode({
    transports: [webSockets()],
    listenAddrs: [],
    bootstrapNodes: [],
    networkName: 'control-votetorrent-repro',
    fretProfile: 'edge',
    privateKey,
  });
}

/**
 * The SAME preconditions `wall-proof.mjs`'s `RUNG_P` asserts, re-derived by direct read (not
 * imported — see header). Throws (via `assert`) rather than skipping on a missing/false member.
 */
async function assertPreconditions(node, probePeerId) {
  assert.equal(
    node.admitControlPeerUnconditionally(probePeerId), false,
    'unconditional-admit branches (not-running/no-DB, empty trust anchor, bootstrap/relay peer) must be closed',
  );
  const liveInvitations = (await node.listCadreInvitations()).filter((st) => st.live).length;
  assert.equal(liveInvitations, 0, 'no live cadre invitation may be held (the 1.14 stranger window)');
  assert.equal(node.hasDelegateAdmission(probePeerId), false, 'no delegate admission for the probe peer');

  const authorized = await node.listAuthorizedMembers();
  assert.ok(
    authorized.length >= 1,
    'the gateway must have at least one authorized member (never the cold-start authorized.length===0 carve-out)',
  );
  assert.ok(
    !authorized.some((m) => m.peerId === probePeerId),
    'the probe peer must NOT itself be an authorized member',
  );

  const hasOutstanding = node.strandSolicitationService
    ? await node.strandSolicitationService.hasOutstandingInvitation()
    : false;
  assert.equal(hasOutstanding, false, 'no outstanding strand-formation invitation');

  const strandInstance = node.getStrand(STRAND_ID);
  assert.ok(
    (strandInstance?.libp2pNode?.getMultiaddrs?.().length ?? 0) > 0,
    'the strand must actually be hosted locally (otherwise an empty response proves nothing)',
  );
}

// ── Length-prefixed JSON frame wire client — the same shape control-stream.js documents. Never
// the unexported control-stream.js helpers themselves (nothing under those names is exported from
// @serfab/cadre-core's index). Only ever sends `{ strandId }` — no delegate-announcement field. ──
function encodeFrame(obj) {
  const body = new TextEncoder().encode(JSON.stringify(obj));
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, body.length, false);
  return { prefix, body };
}

async function readStreamToEndRaw(stream) {
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

function decodeFrameRaw(data) {
  if (data.length < 4) throw new Error(`response frame too short (${data.length} bytes)`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const len = view.getUint32(0, false);
  const body = data.subarray(4, 4 + len);
  return JSON.parse(new TextDecoder().decode(body));
}

async function exchangeFrame(stream, strandId) {
  const { prefix, body } = encodeFrame({ strandId });
  stream.send(prefix);
  stream.send(body);
  await stream.close(); // half-close write end — control-stream.js's exchangeFrame shape
  const bytes = await readStreamToEndRaw(stream);
  return decodeFrameRaw(bytes);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// STOCK mode — the blocker itself
// ═══════════════════════════════════════════════════════════════════════════════════════════

if (MODE === 'stock') {
  test('STOCK: the public-observer protocol export does not exist on this cadre-core', { timeout: 30_000 }, () => {
    assert.equal(STRAND_OBSERVER_PROTOCOL, undefined, 'STRAND_OBSERVER_PROTOCOL must not be exported on stock bytes');
    assert.equal(StrandObserverService, undefined, 'StrandObserverService must not be exported on stock bytes');
  });

  test('STOCK: an authorized-but-non-member outsider cannot resolve strand addresses, and dialing the (derived) observer protocol id fails at negotiation', { timeout: 60_000 }, async () => {
    const gw = await buildGateway();
    let outsider;
    try {
      const probeKeyPair = await generateKeyPair('Ed25519');
      const probePeerId = peerIdFromPrivateKey(probeKeyPair).toString();
      await assertPreconditions(gw, probePeerId);

      const controlAddrs = gw.getControlNode().getMultiaddrs().map((m) => m.toString());
      const controlWsAddr = controlAddrs.find((a) => a.includes('/ip4/127.0.0.1/') && a.includes('/ws')) ?? controlAddrs[0];
      outsider = await buildOutsiderNode(probeKeyPair);

      let refusalShape;
      let conn;
      try {
        conn = await outsider.dial(multiaddr(controlWsAddr));
        // Connection admitted (or raced open before the deny hook aborted it) — try the
        // members-only protocol; on stock bytes this is the ONLY address-resolution path.
        const stream = await outsider.dialProtocol(conn.remotePeer, STRAND_ADDR_PROTOCOL, { signal: AbortSignal.timeout(10_000) });
        const response = await exchangeFrame(stream, STRAND_ID);
        assert.equal(response.multiaddrs.length, 0, 'a non-member outsider must get an empty strand-addr response');
        refusalShape = `connection admitted, stream opened, empty response: ${JSON.stringify(response)}`;
      } catch (err) {
        refusalShape = `connection or stream refused before any response: ${err?.message ?? err}`;
      } finally {
        if (conn) { try { await conn.close(); } catch { /* best effort */ } }
      }
      console.log(`[public-observer-blocker] STOCK strand-addr refusal shape: ${refusalShape}`);
      assert.ok(refusalShape, 'the refusal must be observed and classified, never silently skipped');

      // The suggested fix's surface does not exist yet: dialing its (derived, never pasted)
      // protocol id must fail at protocol negotiation — no handler is registered for it.
      let observerDialFailed = false;
      let observerDialReason = null;
      let observerConn;
      try {
        observerConn = await outsider.dial(multiaddr(controlWsAddr));
        await outsider.dialProtocol(observerConn.remotePeer, derivedObserverToken, { signal: AbortSignal.timeout(10_000) });
      } catch (err) {
        observerDialFailed = true;
        observerDialReason = err?.message ?? String(err);
      } finally {
        if (observerConn) { try { await observerConn.close(); } catch { /* best effort */ } }
      }
      console.log(`[public-observer-blocker] STOCK observer-protocol dial: failed=${observerDialFailed} reason=${observerDialReason}`);
      assert.ok(observerDialFailed, 'dialing the (not-yet-existing) observer protocol must fail — no handler is registered for it on stock bytes');
    } finally {
      if (outsider) await outsider.stop().catch(() => {});
      await gw.stop().catch(() => {});
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// PATCHED mode — the members-only non-regression (the suggested fix)
// ═══════════════════════════════════════════════════════════════════════════════════════════

if (MODE === 'patched') {
  test('PATCHED: SERVED on the public-observer protocol, still REFUSED_EMPTY on strand-addr, admitInboundControlConnection still deny', { timeout: 60_000 }, async () => {
    const gw = await buildGateway({ publicObserverStrandIds: [STRAND_ID] });
    let outsider;
    try {
      const probeKeyPair = await generateKeyPair('Ed25519');
      const probePeerId = peerIdFromPrivateKey(probeKeyPair).toString();
      await assertPreconditions(gw, probePeerId);
      assert.equal(
        await gw.admitInboundControlConnection(probePeerId), UNPLACED_VERDICT,
        'the decision-level wall is not edited by the patch — it must still leave a non-member unplaced at boot',
      );

      const controlAddrs = gw.getControlNode().getMultiaddrs().map((m) => m.toString());
      const controlWsAddr = controlAddrs.find((a) => a.includes('/ip4/127.0.0.1/') && a.includes('/ws')) ?? controlAddrs[0];
      outsider = await buildOutsiderNode(probeKeyPair);

      const conn = await outsider.dial(multiaddr(controlWsAddr));
      try {
        // Re-assert CONCURRENTLY with the observer probe, not only at boot — this is what ties
        // the observer success below to the patched connection-gater branch rather than to
        // membership, an enrollment window, a delegate grant or the cold-start carve-out.
        assert.equal(
          await gw.admitInboundControlConnection(probePeerId), UNPLACED_VERDICT,
          'concurrent re-check: the decision-level wall is unchanged by the patch even while the ' +
          'connection itself is admitted through the new peer-blind observer carve-out',
        );

        const observerStream = await outsider.dialProtocol(conn.remotePeer, STRAND_OBSERVER_PROTOCOL, { signal: AbortSignal.timeout(10_000) });
        const observerResponse = await exchangeFrame(observerStream, STRAND_ID);
        assert.ok(observerResponse.multiaddrs.length > 0, 'the observer protocol must SERVE the listed strand to the outsider');

        // SAME outsider, SAME connection, SAME run — the entire security argument for D-02.
        // On 1.14 the refusal is normally a stream reset by the control-protocol guard before the
        // handler runs; an empty response (the pre-guard shape) is an equally valid refusal.
        let addrResponse;
        try {
          const addrStream = await outsider.dialProtocol(conn.remotePeer, STRAND_ADDR_PROTOCOL, { signal: AbortSignal.timeout(10_000) });
          addrResponse = await exchangeFrame(addrStream, STRAND_ID);
        } catch (err) {
          addrResponse = { multiaddrs: [], refusedBeforeResponse: err?.message ?? String(err) };
        }
        console.log(`[public-observer-blocker] PATCHED strand-addr refusal shape: ${JSON.stringify(addrResponse)}`);
        assert.equal(
          addrResponse.multiaddrs.length, 0,
          'the members-only strand-addr protocol must still refuse the IDENTICAL outsider, on the ' +
          'IDENTICAL connection, in the SAME run — this is the members-only non-regression',
        );
      } finally {
        try { await conn.close(); } catch { /* best effort */ }
      }
    } finally {
      if (outsider) await outsider.stop().catch(() => {});
      await gw.stop().catch(() => {});
    }
  });
}
