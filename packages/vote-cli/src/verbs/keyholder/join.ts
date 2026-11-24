// RED stub (67-28 Task 1): the keyholder `join` verb, unimplemented.
import type { VerbHandler } from '../../ctl/protocol.js'
import type { VerbContext } from '../../daemon/verb-context.js'

const join: VerbHandler<VerbContext> = async () => {
  throw new Error('unimplemented')
}

export default join
