import type { VerbHandler } from '../ctl/protocol.js'
import type { VerbContext } from '../daemon/verb-context.js'
const capability: VerbHandler<VerbContext> = async () => {
  throw new Error('unimplemented')
}
export default capability
