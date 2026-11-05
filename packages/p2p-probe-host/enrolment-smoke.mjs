/**
 * packages/p2p-probe-host/enrolment-smoke.mjs — the cadre-membership ceremony, cross-process.
 *
 *   cd packages/p2p-probe-host && node enrolment-smoke.mjs
 *
 * WHY. P2P-11's root cause is that the device harness never enrolled its peers: drone-A
 * refused every device with `Refusing strand-addr from non-member <peerId>`, so the strand
 * cohort could not form and replication never started. `drone.mjs` now runs owner genesis and
 * mints a multi-use cadre invitation (cadre-core 1.14+); this proves that a joiner which redeems
 * it becomes a member, against the REAL drone process and a REAL CadreNode joiner, with no
 * emulator and no Android in the loop.
 *
 * It is deliberately NOT the multipeer gate. The gate runs every node in ONE process. The whole
 * difficulty on device is that the owner and the joiner are different processes, and that is
 * exactly the seam this exercises: the drone advertises `PROOF_INVITE=` on stdout, separate
 * nodes redeem it, and the drone — which is never told any joiner's peerId — seats each one.
 *
 * It also checks the joiner's OWN seated row with real crypto: the row a redemption seats is
 * invitation-admitted (no owner signature), and `self-voucher.ts` (the device write gate) judges
 * it with `verifyInvitationAdmission` over the usage and invitation rows — exactly what is done
 * here, so a green smoke means the device gate can pass.
 *
 * Exit 0 on PASS, 1 on FAIL.
 */
import { spawn } from 'node:child_process';
import { CadreNode, decodeCadreInvitation, verifyInvitationAdmission } from '@serfab/cadre-core';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { webSockets } from '@libp2p/websockets';

const L = (...a) => console.log('[enrolment-smoke]', ...a);
const PARTY_ID = 'votetorrent';           // must match drone.mjs
const STRAND_ID = 'enrolment-smoke-strand';
const BOOT_TIMEOUT_MS = 90_000;
const ENROL_TIMEOUT_MS = 90_000;

let drone = null;
let droneB = null;
let joiner = null;
let droneOut = '';
let droneBOut = '';

/**
 * Wait until a spawned process's captured output matches `re`, or time out.
 * Read through getters, not values: the buffers grow after this is called.
 */
function waitForLine(getOut, getProc, re, ms, what) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const tick = setInterval(() => {
      const m = getOut().match(re);
      if (m) { clearInterval(tick); resolve(m); return; }
      const code = getProc()?.exitCode;
      if (code !== null && code !== undefined) {
        clearInterval(tick);
        reject(new Error(`process exited (code ${code}) before ${what}\n${getOut().slice(-2000)}`));
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(tick);
        reject(new Error(`timed out after ${ms}ms waiting for ${what}\n--- output ---\n${getOut().slice(-2000)}`));
      }
    }, 250);
  });
}

const waitForDroneLine = (re, ms, what) =>
  waitForLine(() => droneOut, () => drone, re, ms, what);

async function cleanup() {
  try { await joiner?.stop(); } catch { /* best effort */ }
  for (const p of [droneB, drone]) {
    try { p?.kill('SIGTERM'); } catch { /* best effort */ }
  }
}

/**
 * Poll `node`'s own control DB until its own CadrePeer row is present, invitation-admitted, and
 * verifies against its anchor — the device write gate's predicate (self-voucher.ts), real crypto.
 */
async function waitForSelfAdmitted(node, ms, what) {
  const selfId = node.peerId.toString();
  const deadline = Date.now() + ms;
  let last = 'no read yet';
  while (Date.now() < deadline) {
    try {
      const db = node.getControlDatabase();
      const self = (await db.queryCadrePeers()).find((r) => r.peerId === selfId);
      if (!self) {
        last = 'own CadrePeer row not replicated yet';
      } else if (!(self.vouchSig === null && self.vouchUsage != null)) {
        throw new Error(`${what}: own row is not invitation-admitted (vouchSig=${self.vouchSig}, vouchUsage=${self.vouchUsage})`);
      } else {
        const [usages, invites] = await Promise.all([db.queryCadreInviteUsages(), db.queryCadreInvites()]);
        const usage = usages.find((u) => u.usageStampId === self.vouchUsage);
        const invite = usage && invites.find((i) => i.key === usage.inviteKey);
        if (!usage || !invite) {
          last = 'usage/invitation rows not replicated yet';
        } else if (verifyInvitationAdmission(node.partyId, self, usage, invite, (k) => node.getTrustedOwnerStore().has(k))) {
          return;
        } else {
          throw new Error(`${what}: own row present but verifyInvitationAdmission REJECTS it`);
        }
      }
    } catch (e) {
      if (String(e?.message).startsWith(what)) throw e;
      last = e?.message ?? String(e);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${what}: own row never verified within ${ms}ms (last: ${last})`);
}

async function main() {
  // ── 1. Boot the REAL drone as founder (no DRONE_BOOTSTRAP_CONTROL_ADDR) ─────────────────
  // DRONE_AUTO_ACCEPT is left at its default (off), so every membership below is attributable
  // to redemption alone, never to the opt-in authorizePeer fallback.
  L('starting drone.mjs as founder ...');
  drone = spawn(process.execPath, ['drone.mjs'], {
    cwd: import.meta.dirname,
    env: { ...process.env, STRAND_ID, DRONE_STRAND_ROLE: 'found', DRONE_AUTO_ACCEPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  drone.stdout.on('data', (d) => { droneOut += d.toString(); });
  drone.stderr.on('data', (d) => { droneOut += d.toString(); });

  const [, droneAddr] = await waitForDroneLine(/PROOF_WS_ADDR=(\S+)/, BOOT_TIMEOUT_MS, 'PROOF_WS_ADDR');
  L('drone control addr =', droneAddr);

  // The invitation is minted only by a FOUNDER, and only after owner genesis — so this line
  // appearing at all is already evidence that genesis ran on a solo node.
  const [, encodedInvite] = await waitForDroneLine(/PROOF_INVITE=(\S+)/, BOOT_TIMEOUT_MS, 'PROOF_INVITE');
  const invitation = decodeCadreInvitation(encodedInvite);
  L('drone advertised a cadre invitation (', encodedInvite.length, 'chars, uses =',
    invitation.invite.totalUses, ', members =', invitation.members.length, ')');
  if (/ENROL_ARMED/.test(droneOut)) {
    throw new Error('drone armed the auto-accept fallback with DRONE_AUTO_ACCEPT=0 — membership would not be attributable to redemption');
  }

  // ── 2. Boot a joiner in a separate node, bootstrapped to the drone ──────────────────────
  // 'transaction' profile: the device peers' profile, and the one with no relay server of its
  // own — the shape that actually needs to be admitted. A stable identity is REQUIRED: the
  // redemption is signed with the key behind the joiner's peer id.
  joiner = new CadreNode({
    controlNetwork: { partyId: PARTY_ID, bootstrapNodes: [droneAddr] },
    profile: 'transaction',
    requireSignedSchemas: false,
    strandFilter: { mode: 'all' },
    network: { transports: [webSockets()], listenAddrs: [] },
    strandClusterSize: 2,
    hibernation: { enabled: false },
    privateKey: await generateKeyPair('Ed25519'),
  });
  await joiner.start();
  const joinerId = joiner.peerId?.toString();
  L('joiner peerId =', joinerId);

  // ── 3. Redeem — the WHOLE ceremony on 1.14 ──────────────────────────────────────────────
  const redeemed = await joiner.redeemCadreInvitation(invitation);
  L('joiner redeemed; admitted by', redeemed.peerId, 'at', redeemed.redeemedAt);
  if (!joiner.getTrustedOwnerStore()?.has(invitation.ownerKeys[0])) {
    throw new Error('redemption did not pin the invitation owner key into the joiner anchor');
  }

  // ── 4. The seated row reaches the joiner and verifies (the device write gate) ──────────
  await waitForSelfAdmitted(joiner, ENROL_TIMEOUT_MS, 'joiner');
  L('joiner own row is invitation-admitted and verifies against its anchor');

  // Idempotent re-redemption (a phone restarting with the invitation still injected) must be
  // accepted again without spending a second seat.
  await joiner.redeemCadreInvitation(invitation);
  L('joiner re-redemption accepted (idempotent)');

  // ── 5. A JOINER DRONE (drone-B) — the harness's other half ─────────────────────────────
  // drone-B is a second host-side process, cross-bootstrapped to drone-A, redeeming the SAME
  // invitation (multi-use). Its members need no emulator rewrite — it is a host process, so it
  // dials the drone's loopback addresses exactly as advertised.
  L('starting a joiner drone (drone-B) ...');
  droneB = spawn(process.execPath, ['drone.mjs'], {
    cwd: import.meta.dirname,
    env: {
      ...process.env,
      STRAND_ID,
      DRONE_STRAND_ROLE: 'join',
      DRONE_BOOTSTRAP_CONTROL_ADDR: droneAddr,
      DRONE_INVITE: encodedInvite,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  droneB.stdout.on('data', (d) => { droneBOut += d.toString(); });
  droneB.stderr.on('data', (d) => { droneBOut += d.toString(); });

  await waitForLine(() => droneBOut, () => droneB, /ENROL_REDEEMED|ENROL_REDEEM_FAILED.*/, BOOT_TIMEOUT_MS,
    'drone-B redemption outcome');
  if (/ENROL_REDEEM_FAILED/.test(droneBOut)) {
    throw new Error(`drone-B could not redeem the invitation:\n${droneBOut.match(/ENROL_REDEEM_FAILED.*/)[0]}`);
  }
  L('drone-B redeemed the same invitation');

  const [, droneBId] = droneBOut.match(/control peerId = (\S+)/) ?? [];
  if (!droneBId) throw new Error('could not read drone-B peerId from its output');

  // ── 6. Membership as a MEMBER sees it: the joiner (now a member) authorizes drone-B ─────
  const deadline = Date.now() + ENROL_TIMEOUT_MS;
  while (!(await joiner.isAuthorizedMember(droneBId).catch(() => false))) {
    if (Date.now() > deadline) throw new Error(`joiner never saw drone-B ${droneBId} as an authorized member`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  L('joiner authorizes drone-B — both redemptions replicated');
}

main()
  .then(async () => {
    await cleanup();
    L('ENROLMENT SMOKE: PASS');
    process.exit(0);
  })
  .catch(async (e) => {
    await cleanup();
    L('ENROLMENT SMOKE: FAIL —', e?.message ?? e);
    process.exit(1);
  });
