// RED stub (67-28 Task 1): the keyholder `release` verb, unimplemented.
import type { VerbHandler } from '../../ctl/protocol.js'
import type { VerbContext } from '../../daemon/verb-context.js'

const release: VerbHandler<VerbContext> = async () => {
  throw new Error('unimplemented')
}

export default release
