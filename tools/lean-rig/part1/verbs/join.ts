import { readFileSync } from 'node:fs'
import { AUTH, recents, lastAttach } from './_util.ts'
export default async function (ctx: any, args: { codeFile: string, expectName: string, expectFingerprintFile: string }): Promise<any> {
  const rn: any = await import('@votetorrent/vote-engine/rn')
  const glue: any = await import(AUTH('engines/authority-network-join.ts'))
  const text = readFileSync(args.codeFile, 'utf8').trim()
  const dec = rn.decodeNetworkJoinCode(text)
  if (!dec.ok) return { ok: false, reason: 'preview-malformed' }
  const fp = readFileSync(args.expectFingerprintFile, 'utf8').trim()
  if (dec.code.name !== args.expectName || dec.fingerprint !== fp) return { ok: false, reason: 'preview-mismatch' }
  const engine = ctx.engine()
  const t0 = Date.now()
  const result = await Promise.race([
    glue.runAuthorityNetworkJoin({ node: ctx.node, networksEngine: engine, user: ctx.user, code: dec.code }),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: 'join-timeout' }), 420_000))
  ]) as any
  const joinMs = Date.now() - t0
  if (!result?.ok) return { ok: false, reason: result?.reason ?? 'join-failed', detail: result?.detail ?? null, joinMs }
  const done = await glue.completeAuthorityJoin({
    node: ctx.node, networkRef: result.networkRef,
    selectNetwork: async (ref: any) => { await engine.open(ref, ctx.user) },
    refreshOwnerTrust: async () => undefined
  })
  const hash = String(result.networkRef.hash)
  const ls = (await import(new URL('../hr5-lib.ts', import.meta.url).href))
  const kv = (globalThis as any).__hr5FileKv(ls.asyncStorageFile(ctx.state, ctx.role))
  const joined = JSON.parse(kv.get(ls.JOINED_KEY) ?? '[]')
  const self = String(ctx.node.peerId)
  const sv: any = await import(AUTH('engines/self-voucher.ts'))
  const r = await recents(ctx)
  return {
    outcome: result.outcome, admittedVia: result.admittedVia, joinMs, attach: lastAttach(ctx),
    isJoinedNetwork: joined.includes(hash), recent0: String(r[0]?.hash ?? '').slice(0, 8), recent0Hash: r[0]?.hash ?? null,
    isSelfVouched: await sv.isSelfVouched(ctx.node, self),
    hiddenOpenFailures: ctx.hiddenOpenFailures, trustSaved: done.trustSaved
  }
}
