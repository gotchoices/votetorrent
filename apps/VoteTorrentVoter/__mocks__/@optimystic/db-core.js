/**
 * Jest manual mock for @optimystic/db-core (app-layer Jest environment).
 *
 * db-core ships ESM-only (import-only exports map) over multiformats and other ESM-only deps the
 * react-native Jest preset cannot resolve. The Voter imports it only in pool-matchmaking-ports.ts, which
 * returns null before touching any of these when the strand node has no cohort-topic host, as every jest
 * node does. Each stand-in throws if a test ever reaches it, so a test that needs real matchmaking fails
 * loudly instead of passing on a stub.
 *
 * Production behavior: the real db-core (from the installed dist) is used at Metro/RN runtime.
 */
function unavailable(name) {
  return function () {
    throw new Error(`@optimystic/db-core jest mock: ${name} is not available under jest`);
  };
}

module.exports = {
  b64urlToBytes: unavailable('b64urlToBytes'),
  bytesToB64url: unavailable('bytesToB64url'),
  createMatchTopicAnchor: unavailable('createMatchTopicAnchor'),
  createRingHash: unavailable('createRingHash'),
  createTierAddressing: unavailable('createTierAddressing'),
  decodeQueryReplyV1: unavailable('decodeQueryReplyV1'),
  encodeQueryV1: unavailable('encodeQueryV1'),
  verifyProviderEntry: unavailable('verifyProviderEntry'),
};
