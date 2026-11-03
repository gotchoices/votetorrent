// hr5-lib.ts - path, party and storage helpers shared by the opener, the peer process and the verbs (plan 64-62).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileKv } from './file-kv.mjs'

export const CADRE_STORE_SCOPE = 'votetorrent-cadre-node'
export const JOINED_KEY = '@votetorrent/authorityJoinedNetworks'
export const JOIN_BOOTSTRAP_KEY = '@votetorrent/authorityJoinBootstrap'
export type Role = 'officer' | 'kh-a' | 'kh-b'

export const safeScope = (scope: string): string => scope.replace(/[^a-zA-Z0-9-]/g, '_')
export const roleDir = (stateDir: string, role: string): string => join(stateDir, role)
export const asyncStorageFile = (stateDir: string, role: string): string => join(roleDir(stateDir, role), 'async-storage.json')
export const localStorageFile = (stateDir: string, role: string): string => join(roleDir(stateDir, role), 'local-storage.json')

export function readParty (stateDir: string): any {
  return JSON.parse(readFileSync(join(stateDir, 'party.json'), 'utf8'))
}

export function loadUser (stateDir: string, role: string): any | null {
  const f = join(roleDir(stateDir, role), 'user.json')
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).user : null
}

/** A LocalStorage (vote-engine) over the role's local-storage.json. */
export function roleLocalStorage (stateDir: string, role: string): any {
  const kv = fileKv(localStorageFile(stateDir, role))
  return {
    async getItem (k: string) { return kv.get(k) },
    async setItem (k: string, v: unknown) { kv.set(k, v) },
    async removeItem (k: string) { kv.remove(k) },
    async clear () { kv.clear() }
  }
}

export function slot (kv: any, key: string): any {
  return {
    async load () { const v = kv.get(key); return typeof v === 'string' ? v : undefined },
    async save (text: string) { kv.set(key, text) }
  }
}

