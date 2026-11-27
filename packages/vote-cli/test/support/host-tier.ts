// The host-tier gate. Every loopback-relay spec in this package (real daemons, real CadreNodes, a real
// relay process, 550-700 MB RSS per peer) gates its top-level describe with
//   before(function () { if (!hostTierEnabled()) this.skip() })
// so the default `yarn test` stays fast and reports those cases as pending. Every gate command that
// means to RUN them sets VT_HOST_TIER=1 and asserts `0 pending`.

export const HOST_TIER_ENV = 'VT_HOST_TIER'

/** True only when the variable is exactly '1'. */
export function hostTierEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[HOST_TIER_ENV] === '1'
}
