// pool/index.ts — vote pools (spike 102): voters negotiate one block per pool through the
// authority's rendezvous, with every vote encrypted to the election key before it leaves the phone.
// Named exports only. See pool-agent.ts's header for the rules and the decisions behind them.
export { PoolAgent, POOL_MIN_BLOCK_SIZE, POOL_SIGN_TIMEOUT_MS } from './pool-agent.js'
export type { PoolAgentOptions, PoolAgentStatus, PoolOutcome } from './pool-agent.js'
export { createConsentQueue, ConsentAbandonedError, isConsentAbandonedError, POOL_MIN_PROMPT_MS } from './consent-queue.js'
export type { ConsentQueueOptions, ConsentCallControl, ConsentQueue, ConsentAbandonReason } from './consent-queue.js'
export {
  poolTopic,
  poolBlockId,
  poolBlockCid,
  consentDigest,
  formPoolBlock,
  checkFormedPoolBlock,
  commitPoolBlock
} from './pool-block.js'
export type { PoolContribution, PoolBallot, FormedPoolBlock, ConsentSignature, PoolBlockCheck } from './pool-block.js'
export {
  sealPoolEnvelope,
  openPoolEnvelope,
  poolIdentityFromRawKey,
  createPoolIdentity,
  signPoolRequest,
  verifyPoolRequest,
  ed25519PublicKeyFromPeerId,
  peerIdFromEd25519PublicKey,
  PoolEnvelopeError,
  POOL_ENVELOPE_MAX_SKEW_MS,
  POOL_REQUEST_MAX_SKEW_MS
} from './pool-envelope.js'
export type { SealedPoolEnvelope, OpenedPoolEnvelope, PoolIdentity } from './pool-envelope.js'
export { PoolRendezvous, createInMemoryRendezvousClient, poolRequests, signedFields } from './pool-rendezvous.js'
export type { PoolRendezvousClient, PoolRendezvousOptions, CoordinatorListing, RendezvousRequest, RendezvousReply } from './pool-rendezvous.js'
export { POOL_RENDEZVOUS_PROTOCOL, attachPoolRendezvous, createLibp2pRendezvousClient } from './pool-wire.js'
export { createFailoverRendezvousClient } from './pool-failover.js'
export type { FailoverRendezvousClient } from './pool-failover.js'
export { rendezvousDiscovery, ladderBucket, ladderTopic, POOL_LADDER_RUNG_BITS, POOL_LADDER_DWELL_PRESENTS, POOL_LADDER_MAX_MS, POOL_TOPIC_MAX_CHARS } from './pool-discovery.js'
export type { PoolDiscovery } from './pool-discovery.js'
export {
  matchmakingDiscovery,
  mergedDiscovery,
  encodePoolListing,
  decodePoolListing,
  POOL_MATCH_TOPIC_KIND,
  POOL_MATCH_LABEL_PREFIX,
  poolMatchTopic,
  POOL_MATCH_LISTING_TAG,
  POOL_MATCH_LISTING_MAX_AGE_MS,
  POOL_MATCH_QUERY_LIMIT,
  POOL_MATCH_COOL_OFF_MS
} from './pool-matchmaking.js'
export type { PoolMatchEntry, PoolMatchProvider, PoolMatchmakingPorts } from './pool-matchmaking.js'
