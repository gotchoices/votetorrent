/**
 * vote-sending-port.ts — binding over the strand sending port, which moved to
 * `packages/workflows/src/voter/vote-sending-port.ts` (phase 67 plan 22). This path stays so
 * `engine-factory` (the registration key and the factory) and `vote-send-flow` keep their imports.
 * Same two names, re-exported by name; no workflow logic lives here.
 */
export {VOTE_SENDING_PORT_ENGINE, createVoteSendingPort} from '@votetorrent/workflows/voter';
