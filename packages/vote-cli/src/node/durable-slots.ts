import type { FileKvStorage } from '../vault/file-kv.js'

export type DurableSlotKind = 'trustedOwners' | 'strandNetworkState' | 'bootstrapPeers'

export interface FileDurableSlot {
  load(): Promise<string | undefined>
  save(text: string): Promise<void>
}

export function slotKey(_kind: DurableSlotKind, _scope: string, _partyId: string): string {
  throw new Error('unimplemented')
}

export function fileSlot(_kv: FileKvStorage, _key: string): FileDurableSlot {
  throw new Error('unimplemented')
}
