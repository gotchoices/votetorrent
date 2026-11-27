// `stop`: schedules the daemon's shutdown after the reply has been written and answers at once.

import type { VerbHandler } from '../ctl/protocol.js'
import { assertNoArgs, type VerbContext } from '../daemon/verb-context.js'

const REPLY_FLUSH_MS = 50

const stop: VerbHandler<VerbContext> = async (ctx, args) => {
  assertNoArgs(args)
  setTimeout(() => {
    void ctx.exit('stop-verb')
  }, REPLY_FLUSH_MS)
  return { stopping: true }
}

export default stop
