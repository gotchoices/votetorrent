// mirrors voter-invite.ts:134-160
import { writeFileSync } from 'node:fs'
import { AUTH, readParty } from './_util.ts'
export default async function (ctx: any, args: { networkKey: string, codeFile: string, fingerprintFile: string }): Promise<any> {
  const vi: any = await import(AUTH('engines/voter-invite.ts'))
  const rn: any = await import('@votetorrent/vote-engine/rn')
  const cadre: any = await import('@serfab/cadre-core')
  const party = readParty(ctx)
  const n = party.networks?.[args.networkKey]
  if (!n?.hash) throw new Error('mint: unknown network key')
  const signerKey = ctx.user?.activeKeys?.[0]?.key
  const anchor = await ctx.engine().getFoundingAnchor(n.hash, { userId: ctx.user.id, signerKey })
  await vi.ensureVoterInviteOwner(ctx.node)
  const minted = await ctx.node.createCadreInvitation({ uses: vi.VOTER_INVITE_USES, expiresInMs: vi.VOTER_INVITE_LIFETIME_MS })
  const code: string = rn.encodeNetworkJoinCode({ v: 2, invitation: minted.encoded, networkHash: anchor.networkHash, name: anchor.name, genesis: anchor.genesis, digest: anchor.digest })
  writeFileSync(args.codeFile, code + '\n', { mode: 0o600 })
  writeFileSync(args.fingerprintFile, anchor.fingerprint + '\n', { mode: 0o600 })
  const dec = rn.decodeNetworkJoinCode(code)
  if (!dec.ok) throw new Error('mint: own code does not decode: ' + dec.reason)
  const inv = cadre.decodeCadreInvitation(dec.code.invitation)
  const members: string[] = Array.isArray(inv.members) ? inv.members.map(String) : []
  return {
    v: dec.code.v, chars: code.length, fields: Object.keys(dec.code).sort().join(','), members: members.length,
    memberAddrsCircuitOnly: members.length > 0 && members.every((m) => m.includes('/p2p-circuit')),
    grantsOwnerField: inv?.invite?.grantsOwner === undefined ? 'absent' : String(inv.invite.grantsOwner),
    expiresAtPresent: Boolean(minted.invitation?.invite?.expiresAt),
    networkName8: String(anchor.name).slice(0, 8), nameEqual: anchor.name === n.name,
    fingerprintEqual: dec.fingerprint === anchor.fingerprint
  }
}
