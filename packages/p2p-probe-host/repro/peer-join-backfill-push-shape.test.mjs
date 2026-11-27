/**
 * `@serfab/cadre-core` 1.18.0 x `@optimystic/db-p2p` 1.19.0: the peer-join block catch-up pushes
 * the OLD `BlockTransferClient.pushBlocks` argument shape to the NEW signature.
 *
 * Upstream target: https://github.com/gotchoices/sereus (`@serfab/cadre-core`)
 *   node --test repro/peer-join-backfill-push-shape.test.mjs
 *
 * The device-side symptom (VoteTorrent debug `h9-late-joiner-block-catch-up`, 2026-10-26): hosts
 * that join a running party late log `peer-join block catch-up to peer ... has failed 3 times in a
 * row`, take 15-47 s to join, and either hit `RegistrationRequestStaging: Missing block` or stage a
 * request the officer's Sync Now needs ~15 min to intake. The push that fails is
 * `message too large: ... encodes to 8854083 bytes, over the 8388608-byte request limit`, and the
 * pushes that do go out are answered `missing` for the block ids '0','1','2',...
 *
 * Cause: cadre-core 1.18.0 (peer range `@optimystic/db-p2p ^1.18.0`) calls
 *   client.pushBlocks(blockIds, buffers, 'replication', certification, deadlines)
 * which was db-p2p 1.18.0's signature (base64 `blockData`). db-p2p 1.19.0 changed it to
 *   pushBlocks(blocks, reason, certification, deadlines)   // blocks: Record<BlockId, IBlock>
 * so the id ARRAY is read as the block map (its keys are the indexes '0','1',...), the buffer ARRAY is
 * read as the `reason`, and every Uint8Array in it is JSON-encoded as an object of byte offsets.
 * Nothing in the catch-up lands on the joiner, ever.
 *
 * What this asserts: for a store of three small blocks, the request the catch-up hands the
 * block-transfer client names the REAL block ids, carries each block as the block itself, carries
 * reason 'replication', carries each block's meta, and is a few KiB. Stock 1.18.0 against 1.19.0
 * FAILS (keys '0','1','2'; reason is an array); a call in the 1.19.0 shape passes.
 *
 * No network: the client's `processMessage` is captured, so this checks what the catch-up SENDS,
 * not what a live receiver does with it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PeerJoinBackfill } from '@serfab/cadre-core';
import { BlockTransferClient } from '@optimystic/db-p2p';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';

const PREFIX = '/optimystic/strand-repro';

const makeBlock = (id) => ({ header: { id, type: 'TB', collectionId: 'coll-1' }, rows: [`row-of-${id}`], pad: 'x'.repeat(600) });

test('peer-join catch-up pushes in the block-transfer client\'s current call shape', async () => {
  const ids = ['block-a', 'block-b', 'block-c'];
  const blocks = new Map(ids.map((id) => [id, makeBlock(id)]));
  const storage = {
    async *listBlockIds() { for (const id of ids) yield id; },
    async getMetadata(id) { return { latest: { rev: 1, actionId: `action-${id}` } }; },
    async getBlockProof() { return undefined; },
    async getMaterializedBlock(id) { return blocks.get(id); },
  };

  const sent = [];
  const original = BlockTransferClient.prototype.processMessage;
  BlockTransferClient.prototype.processMessage = async function capture(message) {
    sent.push(structuredClone(message));
    return { missing: [] };
  };
  try {
    const peerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519'));
    const backfill = new PeerJoinBackfill({
      label: 'repro',
      libp2p: {},
      peerNetwork: {},
      storage,
      protocolPrefix: PREFIX,
    });
    const result = await backfill.catchUpPeer(peerId);

    assert.equal(sent.length, 1, 'three small blocks fit one push');
    const request = sent[0];
    assert.equal(request.reason, 'replication', `reason is the string 'replication', got ${JSON.stringify(request.reason)?.slice(0, 80)}`);
    assert.deepEqual(Object.keys(request.blocks ?? {}).sort(), [...ids].sort(), 'the request names the real block ids');
    for (const id of ids) {
      assert.deepEqual(request.blocks[id], blocks.get(id), `block ${id} travels as the block itself`);
      assert.equal(request.blockMeta?.[id]?.rev, 1, `block ${id} carries its meta`);
    }
    const wireBytes = JSON.stringify(request).length;
    assert.ok(wireBytes < 8 * 1024, `three ~700 byte blocks encode to a few KiB, got ${wireBytes} bytes`);
    assert.equal(result.accepted, 3, 'all three were accepted by the (stubbed) receiver');
  } finally {
    BlockTransferClient.prototype.processMessage = original;
  }
});
