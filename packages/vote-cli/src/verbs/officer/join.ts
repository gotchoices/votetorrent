// RED stub: replaced by the implementation commit.
import type { OfficerVerbContext } from '../../network/network-verb-support.js'
export default async function join(_ctx: OfficerVerbContext, _args: Record<string, unknown>): Promise<Record<string, unknown>> {
  throw new Error('unimplemented')
}
export { default as authorityJoin } from './join.js'
