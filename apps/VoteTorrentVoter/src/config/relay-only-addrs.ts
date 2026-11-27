// relay-only-addrs.ts — binding. The F2 decision (spike 100: a phone publishes only relay-circuit addresses to its
// cadre) now lives in the shared builder `@votetorrent/workflows` common/cadre-node-options.ts, which wires it as the voter's inviteAddressResolver.
export { relayOnlyAddrs } from '@votetorrent/workflows';
