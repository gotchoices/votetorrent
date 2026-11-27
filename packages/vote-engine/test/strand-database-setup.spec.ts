/**
 * Why every strand database needs `registerVoteTorrentFunctions` BEFORE its schema applies.
 *
 * Quereus 5.6 refuses a CHECK that calls an unregistered function at CREATE TABLE
 * (quereus `bug-unknown-function-not-caught-at-declaration`); up to 5.4 such a CHECK was accepted and
 * only failed on its first write. cadre-core applies the sApp schema inside the strand build
 * (`StrandDatabase.initialize` -> `connectToStrand`), which registers the crypto plugin and nothing of
 * ours, so `registerDbPlugins` after the strand opened is too late: creating or joining any network
 * failed with `Function not found: SignatureValidP256/3`. The VoteTorrent cadre-core patch
 * (strand-database-setup) adds `CadreNodeConfig.strandDatabaseSetup` / `StrandDatabaseConfig.databaseSetup`,
 * and every embedder passes `registerVoteTorrentFunctions` there.
 *
 * This spec reproduces the strand build's order on a plain Database (crypto plugin, then the schema)
 * and pins both directions, so a quereus release that changes the rule shows up here.
 */
import { expect } from 'chai'
import { Database, registerPlugin } from '@quereus/quereus'
import cryptoPlugin from '@optimystic/quereus-plugin-crypto/plugin'
import { VOTETORRENT_SCHEMA_SQL } from '../src/database/schema-sql.js'
import { registerVoteTorrentFunctions } from '../src/database/initialize.js'

async function schemaApply (setup?: (db: Database) => Promise<void>): Promise<unknown> {
  const db = new Database()
  try {
    if (setup) await setup(db)
    // connectToStrand's own registration (quereus-plugin-sereus connect.js), default config.
    await registerPlugin(db, cryptoPlugin)
    await db.exec(VOTETORRENT_SCHEMA_SQL)
    return undefined
  } catch (error) {
    return error
  } finally {
    await db.close()
  }
}

describe('strand database setup: VoteTorrent functions before the schema (quereus 5.6 CHECK gate)', function () {
  this.timeout(60_000)

  it('without registerVoteTorrentFunctions, the schema is refused at CREATE TABLE for an unregistered function', async () => {
    const error = await schemaApply()
    expect(error, 'the schema applied although no VoteTorrent function was registered').to.be.instanceOf(Error)
    expect(String((error as Error).message) + String((error as Error).cause ?? '')).to.match(/Function not found: (SignatureValid|SignatureValidP256|isISODatetime)\//i)
  })

  it('with registerVoteTorrentFunctions first, the whole schema applies', async () => {
    const error = await schemaApply(registerVoteTorrentFunctions)
    expect(error, String((error as Error | undefined)?.message)).to.equal(undefined)
  })
})
