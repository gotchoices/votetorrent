import type { LocalStorage } from '@votetorrent/vote-core'
import type { FileKvStorage } from '../vault/file-kv.js'

export function createFileLocalStorage(_kv: FileKvStorage): LocalStorage {
  throw new Error('unimplemented')
}
