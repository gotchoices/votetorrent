// register-hr5-hooks.mjs - registers hr5-hooks.mjs once per process (a globalThis flag), so a process that already runs
// spike 108's hook (plan 64-63) can load it after that one.
import { register } from 'node:module'
import { fileURLToPath } from 'node:url'
import { fileKv } from './file-kv.mjs'

if (!globalThis.__hr5HooksRegistered) {
  globalThis.__hr5HooksRegistered = true
  globalThis.__hr5FileKv = fileKv
  const here = new URL('./', import.meta.url)
  const repo = new URL('../../../', here)
  register('./hr5-hooks.mjs', {
    parentURL: import.meta.url,
    data: {
      anchor: new URL('./hr5-open.ts', here).href,
      s62: here.href,
      authSrc: new URL('apps/VoteTorrentAuthority/src/', repo).href,
      voterSrc: new URL('apps/VoteTorrentVoter/src/', repo).href,
      rnEntry: new URL('packages/vote-engine/src/rn-entry.ts', repo).href
    }
  })
}
void fileURLToPath
