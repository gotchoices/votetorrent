// cadre-core `DurableSlot`s over the peer's file kv (the AsyncStorage stand-in), with the SAME key
// templates the apps use, so a CLI node and a phone of the same role persist their strand network
// state, trusted-owner anchor and bootstrap peers under one name per (store, scope, party).
//
// Source of the templates (pinned by the node-units drift spec, which reads both files as text):
//   apps/VoteTorrentAuthority/src/engines/rn-durable-slot.ts (strandNetworkState, trustedOwners)
//   apps/VoteTorrentVoter/src/engines/rn-durable-slot.ts (trustedOwners, bootstrapPeers)
//
// The fault/absent distinction is load-bearing (cadre-core's contract): `load` resolves undefined only
// for an ABSENT key; a failing read rejects, so a transient kv error never wipes an intact record.

import type { FileKvStorage } from '../vault/file-kv.js'

export type DurableSlotKind = 'trustedOwners' | 'strandNetworkState' | 'bootstrapPeers'

export interface FileDurableSlot {
  load(): Promise<string | undefined>
  save(text: string): Promise<void>
}

export function slotKey(kind: DurableSlotKind, scope: string, partyId: string): string {
  return `@votetorrent/${kind}/${scope}/${partyId}`
}

export function fileSlot(kv: FileKvStorage, key: string): FileDurableSlot {
  return {
    async load() {
      const raw = await kv.getItem(key)
      return typeof raw === 'string' ? raw : undefined
    },
    async save(text: string) {
      await kv.setItem(key, text)
    }
  }
}
