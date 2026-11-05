/**
 * staging-cursor-optimystic-order.spec.ts (review finding gap4/IN-01).
 *
 * The cursor walk (`insertWithCursorRetry`) pages `Cursor > :afterCursor ... order by Cursor asc
 * limit 64` and checks progress by CODE-POINT order. The in-memory vtab the other walk specs use
 * sorts the way Quereus does; the production strand is an OPTIMYSTIC-backed table. If an optimystic
 * bump ever pushes ORDER BY / range predicates down into the plugin's own storage order (a different
 * collation from Quereus BINARY), the walk would see pages that do not advance. This spec runs the
 * walk against a real optimystic table (the plugin installed under EACH app workspace, Authority and
 * Voter, on the @quereus/quereus copy that plugin itself resolves, with a `local` in-memory
 * transactor) loaded with the mirror shape (non-BMP cursor text whose UTF-16
 * order differs from code-point order), so such a bump fails a host test.
 *
 * Run this spec on EVERY optimystic bump. If the plugin cannot be loaded the spec FAILS (it never
 * skips): a guard that silently skips guards nothing.
 */

import { expect } from 'chai'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Database } from '@quereus/quereus'
import { insertWithCursorRetry } from '../src/registration/transport/p2p-staging-seam.js'
import type { StagingSqlPort } from '../src/registration/transport/p2p-staging-seam.js'

const HERE = dirname(fileURLToPath(import.meta.url))
/** WR-R2-07: BOTH apps ship the plugin; each copy is guarded, not only the Authority's. */
const APPS = ['VoteTorrentAuthority', 'VoteTorrentVoter'] as const

/** Node's bare-specifier directory lookup: the nearest `node_modules/<name>` at or above `fromDir`. */
function findPackageDir (fromDir: string, name: string): string {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (dirname(dir) === dir) throw new Error(`${name} is not resolvable from ${fromDir}`)
  }
}

function packageJson (dir: string): { version: string; exports?: { '.'?: { import?: string } }; main?: string } {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string; exports?: { '.'?: { import?: string } }; main?: string }
}

const pad = (n: number): string => String(n).padStart(16, '0')
const PREFIX = '00000000000000'

/** 63 ASCII fillers, a U+FFFD pivot, then 64 astral cursors (all 16 UTF-16 units): mirror shape. */
function collationShape (): string[] {
  const fillers = Array.from({ length: 63 }, (_, i) => `${PREFIX}x${String.fromCharCode(0x41 + i)}`)
  const pivot = `${PREFIX}${String.fromCharCode(0xFFFD)}a`
  const tail = Array.from({ length: 64 }, (_, i) => `${PREFIX}${String.fromCodePoint(0x1F600 + i)}`)
  return [...fillers, pivot, ...tail]
}

type RegisterFn = (db: Database, config: Record<string, unknown>) => {
  vtables: Array<{ name: string, module: unknown, auxData?: unknown }>
  functions: Array<{ schema: unknown }>
  dispose?: () => Promise<void>
}

for (const app of APPS) describe(`staging cursor walk over an optimystic-backed table (gap4/IN-01 guard) [${app}]`, function () {
  this.timeout(120_000)

  const pluginDir = resolve(HERE, `../../../apps/${app}/node_modules/@optimystic/quereus-plugin-optimystic`)
  const pluginPathForMessage = `apps/${app}/node_modules/@optimystic/quereus-plugin-optimystic/dist/index.js`

  let db: Database
  let dispose: (() => Promise<void>) | undefined
  let version = 'unknown'

  before(async () => {
    let register: RegisterFn
    try {
      const mod = (await import(pathToFileURL(join(pluginDir, 'dist/index.js')).href)) as { register: RegisterFn }
      register = mod.register
    } catch (err) {
      throw new Error(`optimystic quereus plugin could not be loaded from ${pluginPathForMessage}: ${(err as Error).message}`)
    }
    // WR-R2-07: the Database comes from the SAME @quereus/quereus copy the plugin resolves (the
    // combination an app ships), never from vote-engine's own copy, so the plugin's vtable and
    // instanceof checks run against the engine that plans the query.
    const pluginQuereusDir = findPackageDir(join(pluginDir, 'dist'), '@quereus/quereus')
    const pluginQuereus = packageJson(pluginQuereusDir)
    const entry = pluginQuereus.exports?.['.']?.import ?? pluginQuereus.main ?? 'dist/src/index.js'
    const { Database: PluginDatabase } = (await import(pathToFileURL(join(pluginQuereusDir, entry)).href)) as { Database: new () => Database }
    // ...and that copy must be the version vote-engine itself is tested against.
    const engineQuereus = packageJson(findPackageDir(HERE, '@quereus/quereus'))
    expect(pluginQuereus.version, `${app}'s plugin resolves @quereus/quereus ${pluginQuereus.version}, vote-engine uses ${engineQuereus.version}`).to.equal(engineQuereus.version)

    db = new PluginDatabase()
    const plugin = register(db, { default_transactor: 'local', default_key_network: 'test' })
    for (const v of plugin.vtables) db.registerModule(v.name, v.module as never, v.auxData as never)
    for (const f of plugin.functions) db.registerFunction(f.schema as never)
    dispose = plugin.dispose?.bind(plugin)
    version = packageJson(pluginDir).version
    await db.exec(`
      create table RegistrationRequestStaging (
        StrandId text,
        Cursor text,
        Payload text null,
        primary key (StrandId, Cursor)
      ) using optimystic('tree://vote-engine-test/${app}/registration-staging', transactor='local', keyNetwork='test')
    `)
  })

  after(async () => {
    await dispose?.()
  })

  function port (): StagingSqlPort {
    return {
      async query<T> (sql: string, params: Record<string, unknown>): Promise<T[]> {
        const out: T[] = []
        for await (const row of db.eval(sql, params as never)) out.push(row as unknown as T)
        return out
      },
      async mutate (sql: string, params: Record<string, unknown>): Promise<void> {
        await db.exec(sql, params as never)
      },
      async close (): Promise<void> {},
      describe: () => `optimystic-local@${version} (${app})`
    }
  }

  it('W-4: the walk allocates the next free code-point cursor on the mirror shape', async () => {
    const strandId = 'strand-mirror'
    for (const c of [pad(1), pad(2), ...collationShape()]) {
      await db.exec('insert into RegistrationRequestStaging (StrandId, Cursor, Payload) values (:strandId, :cursor, null)', { strandId, cursor: c } as never)
    }
    const out = await insertWithCursorRetry(port(), {
      table: 'RegistrationRequestStaging',
      strandId,
      insertSql: 'insert into RegistrationRequestStaging (StrandId, Cursor, Payload) values (\'strand-mirror\', :cursor, null)',
      params: {},
      identity: { sql: 'select Cursor from RegistrationRequestStaging where StrandId = :strandId and Payload = \'never\'', params: { strandId } },
      onIdentityConflict: () => 'idempotent',
      where: 'optimystic-order-guard'
    })
    expect(out).to.deep.equal({ cursor: pad(3), idempotent: false })
  })

  it('W-5: records the plan of the walk page query against the optimystic table', async () => {
    const plan: string[] = []
    for await (const row of db.eval(
      'select * from query_plan(\'select Cursor from RegistrationRequestStaging where StrandId = :strandId and Cursor > :afterCursor and Cursor <= :capCursor order by Cursor asc limit 64\')'
    )) plan.push(`${(row as { node_type: string }).node_type}: ${(row as { detail: string }).detail}`)
    // Evidence only: the behaviour leg (W-4) is the guard; the plan text explains it.
    // eslint-disable-next-line no-console
    console.log(`[optimystic ${version} ${app}] walk page plan:\n${plan.join('\n')}`)
    expect(plan.length).to.be.greaterThan(0)
  })
})
