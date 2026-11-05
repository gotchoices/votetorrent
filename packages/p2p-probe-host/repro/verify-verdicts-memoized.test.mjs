/**
 * `@serfab/cadre-core` 1.18.0: the same ed25519 signature is verified again, in pure JS, every time
 * the same row or record is judged.
 *
 * Upstream target: https://github.com/gotchoices/sereus (`@serfab/cadre-core`)
 *   node --test repro/verify-verdicts-memoized.test.mjs
 *
 * The device-side symptom (VoteTorrent phase 64 notes 19 E81/E82, 2026-10-28): an idle Authority's JS
 * thread (`mqt_v_js`) used 30-50% of a core, and ~100% for minutes after a rehearsal leg, on both
 * emulators. Every CDP read then waited 22-28 s behind it and a 60 s form wait timed out. A Hermes
 * CPU profile put the visible JS in `@noble/curves` ed25519 `verify`, reached from
 * `CadreNode.authorizedAmong` -> `hasAnchoredProof` -> `verifyInvitationAdmission` (three verifies per
 * invitation-admitted row on every membership refresh; cadre-node.ts names this as an accepted
 * tradeoff) and from `resolvePeerAddrs` -> `verifyPeerRecordSignature`. The rows and records are the
 * same ones, refresh after refresh, so the same (digest, signature, key) triples are re-verified.
 *
 * Fix (VoteTorrent's cadre-core patch): `peer-authorization.js` and `peer-record.js` verify through a
 * bounded memo of `verify` keyed by every input (digest, signature, public key, and the encodings).
 * ed25519 verification is a pure function of those inputs, so the memo cannot change a verdict; a
 * call that throws is not remembered. The trusted-owner question stays outside it, asked every time.
 *
 * What this asserts: (1) verdicts are unchanged: a valid record verifies, a tampered record, a forged
 * signature and a signature moved onto another record do not, also when asked repeatedly and after
 * the valid one was remembered; (2) re-verifying one record 50 times costs at most a fifth of verifying
 * 50 distinct records. Stock 1.18.0 FAILS (2): both cost about the same.
 *
 * No network, no CadreNode: the exported verifier only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { signPeerRecord, verifyPeerRecordSignature, ed25519PublicKeyFromPrivate } from '@serfab/cadre-core';

const PARTY = 'b2d3c4e5f6a7b8c9d0e1f2a3b4c5d6e7';
const N = 50;

function keyPair() {
  const privateKeyB64 = Buffer.from(randomBytes(32)).toString('base64url');
  return { privateKeyB64, publicKey: ed25519PublicKeyFromPrivate(privateKeyB64) };
}

function record(i, kp) {
  const fields = {
    peerId: `12D3KooWReproPeer${String(i).padStart(4, '0')}`,
    publicKey: kp.publicKey,
    addrs: [`/ip4/10.0.0.${i % 250}/tcp/4001/ws/p2p/relay/p2p-circuit`, `/ip4/10.0.1.${i % 250}/tcp/4002/ws`],
    updatedAt: 1793200000000 + i,
    profile: 'mobile',
  };
  return signPeerRecord(PARTY, fields, kp.privateKeyB64);
}

test('verdicts are unchanged by remembering them', () => {
  const kp = keyPair();
  const good = record(1, kp);
  const other = record(2, kp);
  const tampered = { ...good, addrs: [...good.addrs, '/ip4/6.6.6.6/tcp/1'] };
  const forged = { ...good, sig: other.sig };
  const otherKey = { ...good, publicKey: keyPair().publicKey };
  for (let round = 0; round < 3; round++) {
    assert.equal(verifyPeerRecordSignature(PARTY, good), true, `valid record, round ${round}`);
    assert.equal(verifyPeerRecordSignature(PARTY, tampered), false, `tampered addrs, round ${round}`);
    assert.equal(verifyPeerRecordSignature(PARTY, forged), false, `signature of another record, round ${round}`);
    assert.equal(verifyPeerRecordSignature(PARTY, otherKey), false, `another public key, round ${round}`);
    assert.equal(verifyPeerRecordSignature('ffffffffffffffffffffffffffffffff', good), false, `another party, round ${round}`);
  }
  assert.equal(verifyPeerRecordSignature(PARTY, { ...good, sig: '' }), false, 'missing signature');
});

test('re-verifying the same record is not paid again', () => {
  const kp = keyPair();
  const distinct = Array.from({ length: N }, (_, i) => record(100 + i, kp));
  const same = record(999, kp);
  // warm the JIT and the curve tables on unrelated records first
  for (let i = 0; i < 20; i++) verifyPeerRecordSignature(PARTY, record(5000 + i, kp));

  let t0 = process.hrtime.bigint();
  for (const r of distinct) assert.equal(verifyPeerRecordSignature(PARTY, r), true);
  const distinctNs = Number(process.hrtime.bigint() - t0);

  t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) assert.equal(verifyPeerRecordSignature(PARTY, same), true);
  const repeatNs = Number(process.hrtime.bigint() - t0);

  const ratio = distinctNs / repeatNs;
  console.log(`distinct ${N}: ${(distinctNs / 1e6).toFixed(1)} ms, same x${N}: ${(repeatNs / 1e6).toFixed(1)} ms, ratio ${ratio.toFixed(1)}`);
  assert.ok(ratio >= 5, `repeats cost ${(repeatNs / 1e6).toFixed(1)} ms vs distinct ${(distinctNs / 1e6).toFixed(1)} ms (ratio ${ratio.toFixed(1)}, want >= 5)`);
});
