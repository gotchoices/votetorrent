// `vt keyholder join`: the keyholder joins the officer's network from a voter join code read out of a
// 0600 file (CONTEXT "Workflow coverage": Keyholder = join network). The body IS 67-24's shared
// authority join (`authorityJoin` from the officer verbs: preview, `runAuthorityNetworkJoin`,
// `completeAuthorityJoin`, the token-gated identity); this module adds only the keyholder-side
// argument check (inline secrets refused, absolute code and fingerprint paths, a 1..128-char
// expected name) and returns the delegate's result unchanged. Nothing of the join is re-implemented.

import type { VerbHandler } from '../../ctl/protocol.js'
import type { VerbContext } from '../../daemon/verb-context.js'
import { authorityJoin } from '../officer/join.js'
import { parseKeyholderArgs } from './keyholder-args.js'

const SPEC = {
  codeFile: { kind: 'abs-path', required: true },
  expectName: { kind: 'text', required: true },
  expectFingerprintFile: { kind: 'abs-path', required: true },
  networkHash: { kind: 'network', required: true },
  tokenFile: { kind: 'abs-path' },
  userName: { kind: 'text' },
  timeoutMs: { kind: 'int', min: 10_000, max: 900_000 }
} as const

const join: VerbHandler<VerbContext> = async (ctx, args) => {
  parseKeyholderArgs('join', args, SPEC)
  return authorityJoin(ctx, args)
}

export default join
