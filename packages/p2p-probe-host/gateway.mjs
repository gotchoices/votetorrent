#!/usr/bin/env node
// @ts-nocheck -- packages/p2p-probe-host has no tsconfig.json and no typecheck script of its
// own; this file was never typechecked until 56-11's mesh-read-origin.mjs imported startGateway
// from apps/VoteTorrentPublic, pulling it into that app's stricter checkJs graph transitively.
// Untyped by design, not by neglect -- see this file's own header for what it actually is.
/**
 * packages/p2p-probe-host/gateway.mjs — Phase 56 D-12 public-observer gateway.
 *
 * A NEW file. It is NOT a fork of `drone.mjs` and does not import from it. Exactly two things
 * are copied from `drone.mjs`, and named as such here: the `webSockets()` + `listenAddrs`
 * transport/listener construction (see `buildWsTransportAndListenAddrs` below, cf.
 * `drone.mjs:87-89`), and the `SIGINT`/`SIGTERM` graceful shutdown plus the stay-alive interval
 * (cf. `drone.mjs:427-436`). Nothing else is reused: this file carries NONE of `drone.mjs`'s
 * membership-ceremony machinery (`watchForJoiners`, `createInvite`, the `openEnrollmentWindow`
 * refresher, `dialInvite`, `DRONE_ENROL_DIR`) — D-12 rejected extending `drone.mjs` because that
 * tooling is shaped by Android-emulator loopback assumptions this gateway does not share.
 *
 * WHAT THIS GATEWAY IS. A storage-profile `CadreNode` that:
 *   1. Serves a REAL TLS WebSocket listener (`/tls/ws`) from an mkcert-issued leaf certificate
 *      that validates against a genuine CA chain — not a self-signed bypass (D-12).
 *   2. Carries the 56-04 `@serfab/cadre-core` public-observer patch, letting an unauthenticated
 *      browser peer resolve strand addresses for the strands named in its node-local, fail-closed
 *      `publicObserverStrandIds` allowlist (D-03).
 *   3. Refuses to serve unless ITS OWN resolved `@serfab/cadre-core` bytes actually carry that
 *      patch (D-05 control 4) — see `assertPatchProvenance` below.
 *   4. Proves the allowlist took effect at runtime, rather than trusting that config reached the
 *      node — see the `--self-check` mode below.
 *
 * DELIBERATE MEMBER-SEEDING DECISION — read this before touching the boot sequence.
 * This gateway seeds one member with `authorizePeer(peerId)` — an owner-signed CadrePeer voucher
 * written directly, with no invitation (56-01's seeding recipe; on cadre-core <= 1.13 the same
 * write was spelled `acceptPhone({ phonePeerId })` with no invite). It does NOT mint a cadre
 * invitation: on cadre-core 1.14 a LIVE `CadreInvite` row is the stranger window — while one is
 * held, `/sereus/cadre-invite/1.0.0` is open to strangers and their connections stay up — so an
 * invitation here would admit strangers for a reason that has nothing to do with the 56-04
 * patch. It runs no auto-accept loop and has no `DRONE_ENROL_DIR`. Without the single seeded
 * member below, `admitInboundControlConnection`'s cold-start carve-out (an empty authorized set
 * admits everyone outright) would admit EVERY stranger for the same wrong reason — which would
 * make `56-11`'s mesh-read gate pass for the wrong reason and make `56-13`'s patch-removal
 * control unable to fail. Seeding one member and asserting ZERO live cadre invitations is what
 * makes stranger admission on this gateway attributable to the patch instead. (The pre-1.14
 * equivalent asserted `enrollmentWindowUntil === 0`; 1.14 deleted the enrollment window.)
 *
 * RELAY POSTURE. `enableRelay` is a REQUIRED node-local config key with NO default — it is
 * transcribed by the operator from `56-01-WALL-PROOF.md`'s measured posture
 * (`RELAY_POSTURE=off`; `enableRelay: true` durably admitted an unauthorized peer past its
 * documented 5s expiry). It is never inherited from `drone.mjs` and never left to the storage
 * profile's implicit `relayServerEnabled()` default of `on` (`cadre-node.js:1034-1036`).
 *
 * NON-CLAIM. This gateway is proven to run a real TLS listener with a real patch and a real
 * fail-closed allowlist, on THIS host, over loopback. It is NOT proven reachable from the open
 * internet — see `doc/public-gateway-deploy.md`'s opening section.
 */
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { X509Certificate, createHash } from 'node:crypto';
import { CadreNode, PROVISIONAL_ADMISSION_DEADLINE_MS, PROVISIONAL_ADMISSION_CLOSE_TIMEOUT_MS, ed25519KeyPairFromLibp2p } from '@serfab/cadre-core';
import { webSockets } from '@libp2p/websockets';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import { createLibp2pNode } from '@optimystic/db-p2p/rn';
// The reactivity tier this gateway must be willing at to originate notifications, resolved from the substrate's own export -- never a bare `3`.
import { Tier } from '@optimystic/db-core';

const L = (...a) => console.log('[gateway]', ...a);
const __dirname = dirname(fileURLToPath(import.meta.url));

/** Print a FATAL line naming the offending key/condition and exit non-zero. Never optional. */
function fatal(message) {
  L('FATAL:', message);
  process.exit(1);
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { config: './gateway.config.json', runtimeJson: './gateway-runtime.json' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') args.config = argv[++i];
    else if (a === '--runtime-json') args.runtimeJson = argv[++i];
    else if (a === '--check-dist') args.checkDist = argv[++i];
    else if (a === '--self-check') args.selfCheck = true;
  }
  return args;
}

// ── Config load + fail-closed validation ────────────────────────────────────────────────────
/**
 * Every key is REQUIRED. Never optional-chain a precondition into a pass; never `?? default` a
 * required key. Each failure below is fatal and NAMES the offending key.
 */
function loadAndValidateConfig(configPathArg) {
  const resolvedPath = resolvePath(process.cwd(), configPathArg);
  if (!existsSync(resolvedPath)) {
    fatal(
      `--config file not found at ${resolvedPath}. See gateway.config.example.json for the ` +
        `required shape.`,
    );
  }
  let config;
  try {
    config = JSON.parse(readFileSync(resolvedPath, 'utf8'));
  } catch (e) {
    fatal(`--config file at ${resolvedPath} is not valid JSON: ${e?.message ?? e}`);
  }

  if (typeof config.partyId !== 'string' || config.partyId.length === 0) {
    fatal('config key "partyId" is required and must be a non-empty string.');
  }
  if (typeof config.listenHost !== 'string' || config.listenHost.length === 0) {
    fatal('config key "listenHost" is required and must be a non-empty string.');
  }
  if (
    !Array.isArray(config.publicObserverStrandIds) ||
    config.publicObserverStrandIds.length === 0 ||
    config.publicObserverStrandIds.some((id) => typeof id !== 'string' || id.length === 0)
  ) {
    fatal(
      'config key "publicObserverStrandIds" is required and must be a non-empty array of ' +
        'non-empty strings. An empty or absent allowlist refuses to boot: on a node whose entire ' +
        'purpose is public observation, an empty allowlist is a silently useless gateway, and a ' +
        'silently useless gateway is exactly what gets misread downstream as a fourth wall.',
    );
  }
  if (typeof config.enableRelay !== 'boolean') {
    fatal(
      'config key "enableRelay" is required and must be a boolean (present-and-false is fine — ' +
        'only ABSENT is fatal). It is never defaulted, never inherited from drone.mjs, and never ' +
        "left to the storage profile's implicit ON. Transcribe it from 56-01-WALL-PROOF.md's " +
        'measured relay posture.',
    );
  }
  // A REQUIRED node-local decision, on the `enableRelay` precedent -- no default, no fallback.
  // It becomes cadre-core's own `strandReactivity` option (see startGateway); a silent default
  // here would be exactly how a gateway ends up serving with reactivity off while a gate reports
  // a code-level failure instead of a configuration one.
  if (config.strandCohortTopic === undefined) {
    fatal(
      'config key "strandCohortTopic" is required (absent is fatal — it is the master switch ' +
        'for reactivity origination and is never defaulted). See gateway.config.example.json ' +
        'for the required shape.',
    );
  }
  if (
    typeof config.strandCohortTopic !== 'object' ||
    config.strandCohortTopic === null ||
    Array.isArray(config.strandCohortTopic)
  ) {
    fatal(
      'config key "strandCohortTopic" must be an object (present with `enabled: false` is the ' +
        'fail-closed default). See gateway.config.example.json for the required shape.',
    );
  }
  if (typeof config.strandCohortTopic.enabled !== 'boolean') {
    fatal(
      'config key "strandCohortTopic.enabled" is required and must be a boolean ' +
        '(present-and-false is fine — only an ABSENT or non-boolean value is fatal). See ' +
        'gateway.config.example.json for the required shape.',
    );
  }
  // Refused, not ignored: an operator who still sets it would believe it does something.
  // cadre-core's `strandReactivity` takes no host tuning — a reactivity root is the tail block's
  // storage group, verified at the consensus super-majority, and `cohortTopic.host.minSigs` does
  // not govern it (`strand-reactivity.d.ts`).
  if ('minSigs' in config.strandCohortTopic) {
    fatal(
      'config key "strandCohortTopic.minSigs" is no longer supported — remove it. Reactivity ' +
        "origination is cadre-core's own strandReactivity option, which takes no minSigs: the " +
        'reactivity root is verified at the consensus super-majority, not by minSigs.',
    );
  }
  if (typeof config.tls !== 'object' || config.tls === null) {
    fatal('config key "tls" is required and must be an object with "certPath" and "keyPath".');
  }
  if (typeof config.tls.certPath !== 'string' || !existsSync(resolvePath(dirname(resolvedPath), config.tls.certPath))) {
    fatal(
      `config key "tls.certPath" must name a readable file. Resolved: ` +
        `${resolvePath(dirname(resolvedPath), config.tls.certPath ?? '')}. Run ` +
        `"yarn gateway:cert" to generate one.`,
    );
  }
  if (typeof config.tls.keyPath !== 'string' || !existsSync(resolvePath(dirname(resolvedPath), config.tls.keyPath))) {
    fatal(
      `config key "tls.keyPath" must name a readable file. Resolved: ` +
        `${resolvePath(dirname(resolvedPath), config.tls.keyPath ?? '')}. Run ` +
        `"yarn gateway:cert" to generate one.`,
    );
  }

  return { config, resolvedPath, configDir: dirname(resolvedPath) };
}

// ── Copied from drone.mjs (named, per the header): webSockets() + listenAddrs construction ────
function buildWsTransportAndListenAddrs(config, configDir) {
  const certPath = resolvePath(configDir, config.tls.certPath);
  const keyPath = resolvePath(configDir, config.tls.keyPath);
  const cert = readFileSync(certPath);
  const key = readFileSync(keyPath);
  const wsTransport = webSockets({ https: { cert, key } });
  // The port MUST be 0 — control and strand nodes inherit the same resolved listen list
  // (strand-instance-manager.js:243-292's EADDRINUSE NOTE), so a fixed port makes them race to
  // bind it.
  const listenAddrs = [`/ip4/${config.listenHost}/tcp/0/tls/ws`];
  return { wsTransport, listenAddrs };
}

// The votetorrent.qsql wrapper-strip, reproduced (not imported) from drone.mjs:36-52's logic —
// cadre-core's StrandDatabase.executeSchema() wraps the sApp schema itself, so the outer
// `declare schema main { ... } apply schema main;` wrapper in votetorrent.qsql must be stripped
// before hosting, identical to what the device peers' createStrandDbFactory does.
function loadStrandSchema() {
  const raw = readFileSync(
    resolvePath(__dirname, '../vote-core/schema/votetorrent.qsql'),
    'utf8',
  );
  return raw
    .replace(/^\s*declare\s+schema\s+\w+\s*\{/, '')
    .replace(/\}\s*apply\s+schema\s+\w+\s*;\s*$/, '')
    .trim();
}

// ── D-05 control 4: boot-time provenance gate ──────────────────────────────────────────────────
//
// The token this gate checks is IMPORTED from the package under test — never copied as a
// literal — and its EXPECTED value is assembled at runtime from separate fragments, so the
// protocol literal never appears as one contiguous string anywhere in this file's own source and
// a comment-stripped grep of this file for it can never be self-satisfied
// (project_self_tripping_checker_headers — three recurrences in Phase 53; this is the fourth
// place that lesson gets applied).
const PROTOCOL_TOKEN_FRAGMENTS = ['/sereus', 'public-observer', '1.0.0'];
const EXPECTED_OBSERVER_PROTOCOL = PROTOCOL_TOKEN_FRAGMENTS.join('/');
const OBSERVER_MODULE_BASENAME = 'strand-observer-protocol.js';
const CADRE_NODE_BASENAME = 'cadre-node.js';
const GATER_BASENAME = 'membership-connection-gater.js';
// The gater-registration half of the 56-04 patch. Not fragment-split — only the protocol
// literal is required (by acceptance) to be absent from this file's contiguous source.
const GATER_POLICY_TOKEN = 'admitPublicObservers';
/** Recursively list every `*.js` file under `dir` (excludes `*.js.map` — `.js.map` never matches `.endsWith('.js')`). */
function walkJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolvePath(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Strip `/* *‍/` block comments and `//` line comments before counting occurrences. */
function stripJsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

function countOccurrences(haystack, needle) {
  if (needle.length === 0) return 0;
  return haystack.split(needle).length - 1;
}

/**
 * Walk up from `fromFile` until a `package.json` named `@serfab/cadre-core` is found.
 * Provenance is a per-workspace property (56-04 fact 5: three per-workspace copies, no root
 * copy) — this walk finds the root of the SPECIFIC copy `fromFile` was resolved from.
 */
function findPackageRoot(fromFile) {
  let dir = dirname(fromFile);
  for (let i = 0; i < 12; i++) {
    const pkgJsonPath = resolvePath(dir, 'package.json');
    if (existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
        if (pkg.name === '@serfab/cadre-core') return dir;
      } catch {
        // keep walking — a malformed intermediate package.json is not this package's root
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not find a @serfab/cadre-core package root walking up from ${fromFile}`);
}

/**
 * Run the full provenance decision matrix against an arbitrary resolved `@serfab/cadre-core`
 * package root. This is the inversion handle: `--check-dist <packageRoot>` calls this directly
 * against ANY root, including a pristine `npm pack`ed tarball — proving the check can FAIL.
 */
async function checkProvenance(packageRootAbsPath) {
  const pkgJsonPath = resolvePath(packageRootAbsPath, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    return { verdict: 'FAIL', reason: 'package-json-unreadable', packageRootAbsPath };
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  } catch (e) {
    return {
      verdict: 'FAIL',
      reason: 'package-json-unreadable',
      packageRootAbsPath,
      error: e?.message ?? String(e),
    };
  }

  // The token is IMPORTED from the resolved package's own dist bytes — never a copied literal.
  // A pristine, unpatched 0.12.0 has no such export: this import either throws or resolves to
  // `undefined`, and EITHER outcome is `token-unavailable` — it must never degrade into a
  // zero-count that reads as clean.
  const indexPath = resolvePath(packageRootAbsPath, 'dist/index.js');
  let mod;
  try {
    mod = await import(pathToFileURL(indexPath).href);
  } catch {
    mod = undefined;
  }
  const token = mod?.STRAND_OBSERVER_PROTOCOL;
  if (typeof token !== 'string' || token.length === 0) {
    return { verdict: 'FAIL', reason: 'token-unavailable', packageRootAbsPath, version: pkg.version };
  }
  if (token !== EXPECTED_OBSERVER_PROTOCOL) {
    return {
      verdict: 'FAIL',
      reason: 'token-mismatch',
      packageRootAbsPath,
      version: pkg.version,
      observedToken: token,
    };
  }

  const distDir = resolvePath(packageRootAbsPath, 'dist');
  const jsFiles = existsSync(distDir) ? walkJsFiles(distDir) : [];
  const hits = [];
  for (const file of jsFiles) {
    const stripped = stripJsComments(readFileSync(file, 'utf8'));
    const n = countOccurrences(stripped, EXPECTED_OBSERVER_PROTOCOL);
    if (n > 0) hits.push({ file, count: n });
  }
  const singleFileBasename = hits.length === 1 ? basename(hits[0].file) : undefined;
  if (hits.length !== 1 || hits[0].count !== 1 || singleFileBasename !== OBSERVER_MODULE_BASENAME) {
    return {
      verdict: 'FAIL',
      reason: 'occurrence-count',
      packageRootAbsPath,
      version: pkg.version,
      hits: hits.map((h) => ({ file: h.file, count: h.count })),
    };
  }

  const cadreNodePath = resolvePath(distDir, CADRE_NODE_BASENAME);
  const gaterPath = resolvePath(distDir, GATER_BASENAME);
  const cadreNodeSrc = existsSync(cadreNodePath) ? readFileSync(cadreNodePath, 'utf8') : '';
  const gaterSrc = existsSync(gaterPath) ? readFileSync(gaterPath, 'utf8') : '';
  if (!cadreNodeSrc.includes(GATER_POLICY_TOKEN) || !gaterSrc.includes(GATER_POLICY_TOKEN)) {
    return { verdict: 'FAIL', reason: 'gater-missing', packageRootAbsPath, version: pkg.version };
  }

  // No second provenance token: reactivity origination is cadre-core's own `strandReactivity`
  // since 1.12, so the strand-cohort-topic patch (and its `STRAND_COHORT_TOPIC_CONFIG_KEY`
  // export) is retired. EFFECT_COHORT below still proves the option took effect on the node.
  return {
    verdict: 'PASS',
    packageRootAbsPath,
    version: pkg.version,
    occurrenceCount: hits[0].count,
    occurrenceFile: hits[0].file,
    // The token AS OBSERVED from the resolved package's own export — threaded through to
    // EFFECT_REGISTERED so that rung also checks a value obtained from the package, not a
    // literal declared in this file.
    observedToken: token,
  };
}

function formatProvenanceLine(result) {
  if (result.verdict === 'PASS') {
    return (
      `PROVENANCE=PASS path=${result.packageRootAbsPath} version=${result.version} ` +
      `occurrences=${result.occurrenceCount}`
    );
  }
  return (
    `PROVENANCE=FAIL:${result.reason} path=${result.packageRootAbsPath}` +
    (result.version ? ` version=${result.version}` : '')
  );
}

/**
 * The boot-time gate. Resolves the package the RUNNING process actually loaded — never a
 * hand-picked path — walks it to its package root, asserts that root is the
 * `packages/p2p-probe-host` workspace copy (per-workspace property, 56-04 fact 5: three copies,
 * no root copy — a check against another workspace's copy proves nothing about THIS process),
 * then runs the full decision matrix. Fatal, unconditional: no result from this gateway may be
 * reported without a PROVENANCE=PASS line from the SAME process.
 */
async function assertPatchProvenanceForBoot() {
  // @serfab/cadre-core's package.json exposes only an ESM "import" export condition (no
  // "require"), so a CJS createRequire().resolve() throws "No \"exports\" main defined" —
  // import.meta.resolve is the module-system-correct way to ask "what would THIS process's own
  // import actually load" for an ESM-exports-only package (Node >=20.6, unflagged in this repo's
  // pinned Node 22 line).
  let resolvedIndexUrl;
  try {
    resolvedIndexUrl = import.meta.resolve('@serfab/cadre-core');
  } catch (e) {
    fatal(`PROVENANCE=FAIL:unresolvable — could not resolve @serfab/cadre-core from the running process: ${e?.message ?? e}`);
  }
  const resolvedIndexPath = fileURLToPath(resolvedIndexUrl);
  const packageRoot = findPackageRoot(resolvedIndexPath);
  if (!packageRoot.includes('packages/p2p-probe-host/node_modules')) {
    fatal(
      `PROVENANCE=FAIL:wrong-workspace path=${packageRoot} — resolved @serfab/cadre-core is not ` +
        `the packages/p2p-probe-host workspace copy. Provenance is a per-workspace property ` +
        `(three copies, no root copy) — a check against another workspace's copy proves nothing ` +
        `about this process.`,
    );
  }
  const result = await checkProvenance(packageRoot);
  if (result.verdict !== 'PASS') {
    fatal(formatProvenanceLine(result));
  }
  L(formatProvenanceLine(result));
  return result;
}

// ── --self-check: prove the D-03 allowlist actually took effect at runtime ─────────────────────

/** EFFECT_ALLOWLIST — the live Set off the started node, never the config object. */
function checkAllowlistRung(node, configuredIds) {
  const live = node.publicObserverStrandIds;
  if (!(live instanceof Set)) {
    throw new Error(
      'node.publicObserverStrandIds is not a Set (a plausible outcome of a future @serfab/* ' +
        'bump) — refusing to report a silently-skipped precondition as green.',
    );
  }
  if (live.size !== configuredIds.length || !configuredIds.every((id) => live.has(id))) {
    throw new Error(
      `live Set size=${live.size} members=[${[...live].join(',')}] does not match configured=` +
        `[${configuredIds.join(',')}]`,
    );
  }
  return { size: live.size, members: [...live] };
}

/**
 * EFFECT_HOSTED — for each `strandId`, `node.getStrand(id)` must be defined with a non-empty,
 * all-`/tls/ws` multiaddr list. Exported as a standalone function (mirroring
 * `processObserverRequest`'s own "exposed, not private" rationale) so it is unit-testable
 * against an arbitrary `strandIds` list, independent of what this process's own boot sequence
 * happened to pass to `addStrand` — see 56-08-SUMMARY.md's falsifiability-handle note.
 */
function checkHostedRung(node, strandIds) {
  for (const strandId of strandIds) {
    const strand = node.getStrand(strandId);
    if (!strand) {
      throw new Error(`getStrand(${strandId}) is undefined — this gateway does not host it`);
    }
    const addrs = strand.libp2pNode?.getMultiaddrs?.().map((m) => m.toString()) ?? [];
    if (addrs.length === 0) {
      throw new Error(`strand ${strandId} is hosted but has no listen multiaddrs`);
    }
    if (!addrs.every((a) => a.includes('/tls/ws'))) {
      throw new Error(`strand ${strandId} advertises a non-/tls/ws address: ${addrs.join(',')}`);
    }
  }
  return { strandIds };
}

/**
 * EFFECT_REGISTERED — the control node's own libp2p registrar lists the observer token.
 * `expectedToken` is threaded in from the provenance result's `observedToken` — obtained from
 * the resolved package's own export, not a literal declared in this file — so this rung checks
 * a value the process actually observed, not one it assumed.
 */
function checkRegisteredRung(node, expectedToken) {
  const protocols = node.getControlNode().getProtocols();
  if (!protocols.includes(expectedToken)) {
    throw new Error(
      `control node protocols do not include the observer token; registered=[${protocols.join(',')}]`,
    );
  }
  return { token: expectedToken };
}

/**
 * EFFECT_GATER — the ordering hazard's only honest observable (56-04: the gater closure is
 * built before the observer service registers, so an allowlist wired at the wrong site leaves
 * the gater reading an empty Set even though the handler is live). Stands an ephemeral,
 * anonymous outsider libp2p node and dials the gateway's own control address, holding past the
 * relay branch's partial-admission deadline. Connection-level admission ONLY — this rung
 * deliberately does not dial the observer protocol, does not probe strand-addr, and does not
 * exercise an unlisted strandId; those are 56-07's controls 2/3, not this gateway's.
 */
async function checkGaterRung(node, config) {
  const controlAddrs = node.getControlNode().getMultiaddrs().map((m) => m.toString());
  const dialAddr = controlAddrs.find((a) => a.includes('/tls/ws'));
  if (!dialAddr) throw new Error('no /tls/ws control address to dial');

  // cadre-core 1.14: a stranger this node cannot place is admitted PROVISIONALLY and closed at
  // the provisional deadline (+ a bounded graceful close). The patch's carve-out admits an
  // observer outright, with no deadline, so surviving past both is the carve-out's observable.
  // This gateway sets no `linkRoundTripMs`, so its deadline is the exported default.
  const deadlineMs = PROVISIONAL_ADMISSION_DEADLINE_MS + PROVISIONAL_ADMISSION_CLOSE_TIMEOUT_MS;
  const holdMs = deadlineMs + 3000; // comfortably past the deadline
  let outsider;
  try {
    outsider = await createLibp2pNode({
      transports: [webSockets()],
      listenAddrs: [],
      bootstrapNodes: [],
      networkName: `control-${config.partyId}`,
      fretProfile: 'edge',
    });
    const t0 = Date.now();
    let conn;
    try {
      conn = await outsider.dial(multiaddr(dialAddr));
    } catch (e) {
      throw new Error(
        `dial to ${dialAddr} failed: ${e?.message ?? e} — if this looks like a TLS error, ` +
          `confirm NODE_EXTRA_CA_CERTS names the mkcert root; a TLS failure here is NOT an ` +
          `admission refusal and must not be misattributed as one.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    const survivedMs = Date.now() - t0;
    const stillOpen =
      conn.status === 'open' || outsider.getConnections(conn.remotePeer).length > 0;
    if (!stillOpen) {
      throw new Error(
        `connection did not survive ${holdMs}ms past dial (relay deadline is ` +
          `${deadlineMs}ms incl. close; status=${conn.status}) — classify as DENIED, ` +
          `not as an unclassifiable timeout.`,
      );
    }
    if (survivedMs < deadlineMs) {
      throw new Error(
        `unclassifiable: survived only ${survivedMs}ms, less than the relay deadline ` +
          `${deadlineMs}ms — refusing to report a verdict rather than ` +
          `guess.`,
      );
    }
    return { survivedMs, provisionalDeadlineMs: deadlineMs, relayEnabled: config.enableRelay };
  } finally {
    try {
      await outsider?.stop();
    } catch {
      // best effort
    }
  }
}

/**
 * EFFECT_COHORT — proves cadre-core's `strandReactivity` took effect on the STARTED node, never
 * the config object it was fed. Reads `node.getStrand(id).libp2pNode.cohortTopicHost` for every
 * allowlisted strand.
 *
 * When `strandCohortTopic.enabled` is true, every allowlisted strand must carry a
 * `cohortTopicHost` willing at the reactivity tier (`Tier.T3`, resolved from
 * `@optimystic/db-core`'s own export).
 *
 * When `strandCohortTopic.enabled` is false, this rung asserts the OPPOSITE — a `cohortTopicHost`
 * present on any allowlisted strand is a FAILURE — so the fail-closed master switch is proven by
 * the SAME instrument, not merely believed.
 */
function checkCohortRung(node, strandCohortTopicConfig, strandIds) {
  const enabled = strandCohortTopicConfig?.enabled === true;
  const strands = {};
  for (const strandId of strandIds) {
    const strand = node.getStrand(strandId);
    if (!strand) {
      throw new Error(`getStrand(${strandId}) is undefined — cannot check its cohort-topic host`);
    }
    const host = strand.libp2pNode?.cohortTopicHost;
    if (!enabled) {
      if (host !== undefined) {
        throw new Error(
          `strandCohortTopic.enabled is false but strand ${strandId} carries a cohortTopicHost ` +
            `— the fail-closed master switch did not take effect`,
        );
      }
      strands[strandId] = { hosted: false };
      continue;
    }
    if (!host) {
      throw new Error(`strandCohortTopic.enabled is true but strand ${strandId} has no cohortTopicHost`);
    }
    const profileTiers = host.profile?.willingTiers;
    const isWillingAtReactivityTier = profileTiers instanceof Set && profileTiers.has(Tier.T3);
    if (!isWillingAtReactivityTier) {
      const observed = profileTiers instanceof Set ? [...profileTiers].join(',') : 'undefined';
      throw new Error(
        `strand ${strandId}'s cohortTopicHost is not willing at the reactivity tier — observed=${observed}`,
      );
    }
    strands[strandId] = {
      hosted: true,
      willingTiers: [...profileTiers],
    };
  }
  return { enabled, strands };
}

function resolveCaRootPath() {
  if (process.env.NODE_EXTRA_CA_CERTS) return process.env.NODE_EXTRA_CA_CERTS;
  try {
    const out = execFileSync('mkcert', ['-CAROOT'], { encoding: 'utf8' }).trim();
    return resolvePath(out, 'rootCA.pem');
  } catch {
    return null;
  }
}

function computeSpkiSha256Base64(certPath) {
  try {
    const cert = new X509Certificate(readFileSync(certPath));
    const spkiDer = cert.publicKey.export({ type: 'spki', format: 'der' });
    return createHash('sha256').update(spkiDer).digest('base64');
  } catch {
    return null;
  }
}

/**
 * Write the 56-11/56-13 handoff. On a provenance failure this is called with `status: 'refused'`
 * and no addresses, so a failed run leaves evidence that cannot be mistaken for a usable handoff.
 */
function writeHandoff(path, payload) {
  writeFileSync(path, JSON.stringify(payload, null, 2) + '\n');
  L('wrote handoff to ' + path);
}

const NON_CLAIMS = [
  'This gateway is NOT proven reachable from the open internet.',
  'This certificate is trusted only on hosts where the mkcert local CA is installed.',
];
const CONSUMER_NOTES = [
  "libp2p's browser/RN default connection gater denies loopback and private dials (spike 009's " +
    "'connection gater denied all addresses' blocker) — a browser Edge node must supply its own " +
    "denyDialMultiaddr override or it will refuse this gateway's own address.",
  'Ports are ephemeral and change every boot. Consumers MUST confirm `pid` names a live process ' +
    'before trusting `controlAddrs`/`strandAddrs` — a stale handoff pointing at a dead port is ' +
    'the same failure class as project_device_proof_bundle_provenance.',
];

async function runSelfCheck({ node, config, provenanceResult, runtimeJsonPath, controlAddr, controlAddrDns, strandAddrsByStrandId, certPath }) {
  let ok = true;
  const effects = {};

  try {
    effects.allowlist = { pass: true, ...checkAllowlistRung(node, config.publicObserverStrandIds) };
    L(`EFFECT_ALLOWLIST=PASS size=${effects.allowlist.size} members=${effects.allowlist.members.join(',')}`);
  } catch (e) {
    ok = false;
    effects.allowlist = { pass: false, error: e?.message ?? String(e) };
    L('EFFECT_ALLOWLIST=FAIL ' + effects.allowlist.error);
  }

  try {
    checkHostedRung(node, config.publicObserverStrandIds);
    effects.hosted = { pass: true, strandIds: config.publicObserverStrandIds };
    L('EFFECT_HOSTED=PASS strands=' + config.publicObserverStrandIds.join(','));
  } catch (e) {
    ok = false;
    effects.hosted = { pass: false, error: e?.message ?? String(e) };
    L('EFFECT_HOSTED=FAIL ' + effects.hosted.error);
  }

  try {
    effects.registered = { pass: true, ...checkRegisteredRung(node, provenanceResult.observedToken) };
    L('EFFECT_REGISTERED=PASS token=' + effects.registered.token);
  } catch (e) {
    ok = false;
    effects.registered = { pass: false, error: e?.message ?? String(e) };
    L('EFFECT_REGISTERED=FAIL ' + effects.registered.error);
  }

  try {
    effects.gater = { pass: true, ...(await checkGaterRung(node, config)) };
    L(
      `EFFECT_GATER=PASS survivedMs=${effects.gater.survivedMs} ` +
        `provisionalDeadlineMs=${effects.gater.provisionalDeadlineMs} relayEnabled=${effects.gater.relayEnabled}`,
    );
  } catch (e) {
    ok = false;
    effects.gater = { pass: false, error: e?.message ?? String(e) };
    L('EFFECT_GATER=FAIL ' + effects.gater.error);
  }

  try {
    effects.cohort = {
      pass: true,
      ...checkCohortRung(node, config.strandCohortTopic, config.publicObserverStrandIds),
    };
    L(
      `EFFECT_COHORT=PASS enabled=${effects.cohort.enabled} ` +
        `strands=${config.publicObserverStrandIds.join(',')}`,
    );
  } catch (e) {
    ok = false;
    effects.cohort = { pass: false, error: e?.message ?? String(e) };
    L('EFFECT_COHORT=FAIL ' + effects.cohort.error);
  }

  const payload = {
    schemaVersion: 1,
    status: ok ? 'ok' : 'refused',
    cadreCoreVersion: provenanceResult.version,
    cadreCoreResolvedPath: provenanceResult.packageRootAbsPath,
    provenance: {
      verdict: provenanceResult.verdict,
      tokenOccurrences: provenanceResult.occurrenceCount,
      checkedPath: provenanceResult.packageRootAbsPath,
    },
    controlAddrs: ok ? [controlAddr] : [],
    controlAddrsDns: ok ? [controlAddrDns] : [],
    strandAddrs: ok ? strandAddrsByStrandId : {},
    publicObserverStrandIds: config.publicObserverStrandIds,
    enableRelay: config.enableRelay,
    strandCohortTopic: config.strandCohortTopic,
    tls: {
      certPath,
      caRoot: resolveCaRootPath(),
      spkiSha256Base64: computeSpkiSha256Base64(certPath),
    },
    bootedAt: new Date().toISOString(),
    pid: process.pid,
    effects,
    nonClaims: NON_CLAIMS,
    consumerNotes: CONSUMER_NOTES,
  };
  writeHandoff(runtimeJsonPath, payload);
  return { ok, payload };
}

/**
 * `startGateway(options)` — 56-11's named export. The gateway's ENTIRE boot sequence, extracted
 * verbatim from what was `main()`'s body, structurally unchanged: same fail-closed order, same
 * `[gateway] KEY=value` lines, same provenance gate, same member-seeding decision. Nothing here is
 * new behaviour — this is a REFACTOR (one structural change: a name and a return value), not a
 * rewrite. See this file's header for the three prohibitions this export must never grow (no
 * seeding, no fixture, no new flag/config key/listening socket).
 *
 * @param {{ config?: string }} [options] `config` is the same `--config` path `parseArgs` accepts,
 *   defaulting identically.
 * @returns {Promise<{
 *   node: import('@serfab/cadre-core').CadreNode,
 *   provenance: { verdict: string, [key: string]: unknown },
 *   controlAddrs: string[],
 *   controlAddrsDns: string[],
 *   strandAddrs: Record<string, string[]>,
 *   publicObserverStrandIds: string[],
 *   enableRelay: boolean,
 *   authorizedMemberCount: number,
 *   liveCadreInvitations: number,
 *   tls: { certPath: string, caRoot: string | null, spkiSha256Base64: string | null },
 *   stop: () => Promise<void>,
 *   config: unknown,
 *   configDir: string,
 *   controlAddr: string,
 *   controlAddrDns: string,
 * }>}
 */
export async function startGateway(options = {}) {
  const { config, configDir } = loadAndValidateConfig(options.config ?? './gateway.config.json');

  // ── D-05 control 4, unconditional: no result from this gateway may be reported without a
  // PROVENANCE=PASS line from THIS process, printed before the first GATEWAY_* line. ─────────
  const provenanceResult = await assertPatchProvenanceForBoot();

  const { wsTransport, listenAddrs } = buildWsTransportAndListenAddrs(config, configDir);

  const identityKey = await generateKeyPair('Ed25519');
  const node = new CadreNode({
    // Explicit privateKey: an ephemeral libp2p key makes getIdentityOwnerKey() throw
    // ("node identity not resolved") — drone.mjs:63-72's stated reason, inherited here.
    privateKey: identityKey,
    controlNetwork: { partyId: config.partyId, bootstrapNodes: [] },
    profile: 'storage',
    requireSignedSchemas: false,
    strandFilter: { mode: 'all' },
    strandClusterSize: 2,
    hibernation: { enabled: false },
    publicObserverStrandIds: config.publicObserverStrandIds,
    // The node-local decision about whether this gateway's strand node originates reactivity
    // notifications — cadre-core's own `strandReactivity` (1.12+), fed from the gateway's
    // `strandCohortTopic` config key. `strandIds` is DERIVED from `publicObserverStrandIds`
    // rather than a second, independently-editable config key: the mesh-read origin's per-run
    // override (`mesh-read-origin.mjs`) transcribes every config key EXCEPT
    // `publicObserverStrandIds`, so a second allowlist would go stale the moment that override
    // fires — a red gate that would look like a code defect rather than config drift.
    strandReactivity: {
      enabled: config.strandCohortTopic.enabled,
      strandIds: config.publicObserverStrandIds,
    },
    network: {
      transports: [wsTransport],
      listenAddrs,
      enableRelay: config.enableRelay,
      // Deliberately no advertise-only address override: naming a fixed public port would
      // require a fixed listen port and reintroduce the control/strand EADDRINUSE collision
      // (fact 2). The reverse-proxy alternative is described in doc/public-gateway-deploy.md
      // §7 as untested here.
    },
  });

  await node.start();

  // ── Owner genesis — MUST run while the node is solo, above addStrand and above anything that
  // admits a peer (drone.mjs:202-216's ordering, inherited). ─────────────────────────────────
  // cadre-core 1.18 deleted getIdentityOwnerKey(); derive the same identity owner key here.
  const owner = ed25519KeyPairFromLibp2p(identityKey);
  await node.trustOwnerKeys([owner.publicKeyB64], 'operator');
  const controlDb = node.getControlDatabase();
  if (!controlDb) fatal('gateway has no control database after start() — cannot run owner genesis.');
  await controlDb.ensureOwnerKey(owner.publicKeyB64);
  await node.initializeSeedBootstrap(owner.privateKeyB64);
  L(`owner genesis done (ownerKey=${owner.publicKeyB64.slice(0, 12)}…)`);

  // ── Seed exactly one authorized member — see the header's "DELIBERATE MEMBER-SEEDING
  // DECISION". This gateway is never a cold-start node. ──────────────────────────────────────
  const seedMemberKey = await generateKeyPair('Ed25519');
  const seedMemberPeerId = peerIdFromPrivateKey(seedMemberKey).toString();
  await node.authorizePeer(seedMemberPeerId);
  const authorizedMembers = await node.listAuthorizedMembers();
  if (!(authorizedMembers.length >= 1)) {
    fatal(
      `gateway seeded a member but listAuthorizedMembers() reports ${authorizedMembers.length} ` +
        `— refusing to serve as a cold-start node (authorized.length === 0 would admit every ` +
        `stranger via cadre-node.js's cold-start carve-out, attributing admission to the wrong ` +
        `cause).`,
    );
  }
  const liveCadreInvitations = (await node.listCadreInvitations()).filter((s) => s.live).length;
  if (liveCadreInvitations !== 0) {
    fatal(
      `gateway holds ${liveCadreInvitations} live cadre invitation(s), expected 0 — a live ` +
        `invitation opens the cadre-invite protocol to strangers, so stranger admission could not ` +
        `be attributed to the observer allowlist.`,
    );
  }

  // ── Host every allowlisted strand ───────────────────────────────────────────────────────────
  const schema = loadStrandSchema();
  for (const strandId of config.publicObserverStrandIds) {
    await node.addStrand({
      strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o' },
      sAppConfig: {
        id: 'org.votetorrent',
        version: '1.0.0',
        schema,
        latencyHint: 'interactive',
      },
      // `mode: 'bootstrap'` was deleted from StrandConfig in cadre-core 0.11 and has been ignored
      // since; this gateway hosts each allowlisted strand solo, so it must FOUND it, or addStrand
      // waits forever for a founder that never comes.
      founder: true,
    });
  }

  // ── Machine-readable output, on the enrolment-smoke.mjs shape: [gateway] prefix, one
  // KEY=value per line, greppable. ────────────────────────────────────────────────────────────
  const controlAddrs = node.getControlNode().getMultiaddrs().map((m) => m.toString());
  const controlAddr =
    controlAddrs.find((a) => a.includes(`/ip4/${config.listenHost}/`) && a.includes('/tls/ws')) ??
    controlAddrs.find((a) => a.includes('/tls/ws')) ??
    '';
  // Rewrite, not an independently observed listen — labeled as such, mirroring the
  // 10.0.2.2 rewrite idea drone.mjs uses.
  const controlAddrDns = controlAddr.replace('/ip4/127.0.0.1/', '/dns4/localhost/');

  L('GATEWAY_CADRE_CORE_PATH=' + provenanceResult.packageRootAbsPath);
  L('GATEWAY_RELAY=' + (config.enableRelay ? 'on' : 'off'));
  L('GATEWAY_COHORT_TOPIC=' + (config.strandCohortTopic.enabled ? 'on' : 'off'));
  L('GATEWAY_AUTHORIZED_MEMBERS=' + authorizedMembers.length);
  L('GATEWAY_LIVE_CADRE_INVITATIONS=' + liveCadreInvitations);
  L('GATEWAY_CONTROL_ADDR=' + controlAddr);
  // Rewrite, not an independently observed listen — the mkcert leaf covers both names.
  L('GATEWAY_CONTROL_ADDR_DNS=' + controlAddrDns);

  const strandAddrsByStrandId = {};
  for (const strandId of config.publicObserverStrandIds) {
    const strand = node.getStrand(strandId);
    const strandAddrs = strand?.libp2pNode?.getMultiaddrs?.().map((m) => m.toString()) ?? [];
    const strandAddr = strandAddrs.find((a) => a.includes('/tls/ws')) ?? strandAddrs[0] ?? '';
    strandAddrsByStrandId[strandId] = strandAddrs;
    L(`GATEWAY_STRAND_ADDR[${strandId}]=` + strandAddr);
  }

  L('READY — public-observer gateway serving on ' + controlAddr);

  const certPath = resolvePath(configDir, config.tls.certPath);

  // ── EFFECT_COHORT, unconditionally on every boot, never only behind `--self-check` (56-19). ──
  // D-05.4 requires the ORIGIN's runtime cohort-topic effect to be provable IN THE SAME PROCESS
  // that seeds and serves a mesh-read run, and `mesh-read-origin.mjs` (56-11) calls `startGateway`
  // directly -- it never reaches `main()`'s `--self-check` branch below, so that branch alone
  // left this proof permanently unreachable from the one caller that actually needs it (measured:
  // absent from every `test:mesh-read` run before this fix). `checkCohortRung` is cheap (pure
  // reads off the already-started node, no new connection, no new libp2p node) -- unlike
  // `checkAllowlistRung`/`checkHostedRung`/`checkRegisteredRung`/`checkGaterRung`, which stay
  // reachable ONLY via `--self-check` (the last of those four stands up a second, dialing libp2p
  // node and holds a connection past a multi-second relay-admission deadline; running it on every
  // gate boot, times three for a certification run, was judged not worth the added latency and
  // surface for a proof this plan's own verification does not require of them). This scoping
  // decision is recorded, not hidden -- see `56-19-MESH-READ-CERTIFICATION.md`.
  let cohortEffect;
  try {
    cohortEffect = { pass: true, ...checkCohortRung(node, config.strandCohortTopic, config.publicObserverStrandIds) };
    L(`EFFECT_COHORT=PASS enabled=${cohortEffect.enabled} strands=${config.publicObserverStrandIds.join(',')}`);
  } catch (e) {
    cohortEffect = { pass: false, error: e?.message ?? String(e) };
    L('EFFECT_COHORT=FAIL ' + cohortEffect.error);
  }

  return Object.freeze({
    node,
    provenance: provenanceResult,
    controlAddrs: [controlAddr],
    controlAddrsDns: [controlAddrDns],
    strandAddrs: strandAddrsByStrandId,
    publicObserverStrandIds: config.publicObserverStrandIds,
    enableRelay: config.enableRelay,
    authorizedMemberCount: authorizedMembers.length,
    liveCadreInvitations,
    cohortEffect,
    tls: {
      certPath,
      caRoot: resolveCaRootPath(),
      spkiSha256Base64: computeSpkiSha256Base64(certPath),
    },
    stop: async () => {
      await node.stop();
    },
    // Carried for the CLI entry's own `--self-check` reuse below -- not part of the "at minimum"
    // contract this plan's callers rely on, but harmless to expose alongside it.
    config,
    configDir,
    controlAddr,
    controlAddrDns,
  });
}

// ── CLI entry ────────────────────────────────────────────────────────────────────────────────
// Guarded so `import { startGateway } from './gateway.mjs'` (56-11's origin process, in-process)
// never triggers this boot sequence a second time as a side effect of the import itself. Every
// fail-closed refusal, every `[gateway] KEY=` line, the provenance gate and the
// `gateway-runtime.json` emission stay exactly where they were -- this guard is the ONLY
// structural change to the CLI's own behaviour.
async function main() {
  const args = parseArgs(process.argv.slice(2));

  // ── --check-dist: the inversion handle. Runs the SAME decision matrix against an arbitrary
  // package root and exits on its verdict without booting a node. ────────────────────────────
  if (args.checkDist) {
    const packageRoot = resolvePath(process.cwd(), args.checkDist);
    const result = await checkProvenance(packageRoot);
    L(formatProvenanceLine(result));
    process.exit(result.verdict === 'PASS' ? 0 : 1);
  }

  const handle = await startGateway({ config: args.config });
  const { node, config, controlAddr, controlAddrDns, provenance: provenanceResult, strandAddrs: strandAddrsByStrandId, tls } = handle;

  // ── --self-check: prove the runtime configuration took effect, then write the handoff and
  // exit (one-shot verification run, not the long-running service). ─────────────────────────
  if (args.selfCheck) {
    const runtimeJsonPath = resolvePath(process.cwd(), args.runtimeJson);
    const { ok } = await runSelfCheck({
      node,
      config,
      provenanceResult,
      runtimeJsonPath,
      controlAddr,
      controlAddrDns,
      strandAddrsByStrandId,
      certPath: tls.certPath,
    });
    await node.stop();
    process.exit(ok ? 0 : 1);
  }

  // ── Copied from drone.mjs (named, per the header): SIGINT/SIGTERM graceful shutdown + the
  // stay-alive interval (drone.mjs:427-436). ─────────────────────────────────────────────────
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      L(`${sig} — stopping...`);
      await node.stop();
      process.exit(0);
    });
  }
  setInterval(() => {}, 1 << 30); // stay alive
}

// `process.argv[1]` is only set when Node loaded this file as the entry module -- an `import()`
// (relative or bare) never sets it to this file's path. This is the standard `require.main ===
// module` equivalent for ESM.
const isCliEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliEntry) {
  main().catch((e) => {
    L('FATAL: unhandled error:', e?.stack ?? e);
    process.exit(1);
  });
}
