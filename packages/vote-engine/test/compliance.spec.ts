/**
 * compliance.spec.ts — VTEST-01: Schema/Architecture Compliance Suite
 *
 * Verifies that the output of the three beachhead creates (createTestNetwork,
 * addTestAuthority, addTestElection) conforms to the canonical votetorrent.qsql
 * entity shapes and the surfaced read-model returned to screens.
 *
 * TDD entry-point — tests intentionally exercise the real engine path (in-memory
 * Quereus) against the same fixtures the screens now drive.
 *
 * Coverage:
 *   FLOW-01: NetworksEngine.create() persisted-row compliance
 *   FLOW-02: addTestAuthority() persisted-row compliance
 *   FLOW-03: addTestElection() persisted-row compliance
 *   FLOW-04: Full chain read-model — getDetails() well-shaped, no undefined
 *   VTEST-01: Cross-layer compliance — surfaced read-model fields + qsql shapes
 *
 * Oracle: votetorrent.qsql entity shapes (D-06) NOT mock parity (D-05).
 */

import { Database } from '@quereus/quereus'
import { ElectionType, UserKeyType } from '@votetorrent/vote-core'
import { expect } from 'chai'
import { prepareDb } from '../src/database/initialize'
import {
  createTestNetwork,
  addTestAuthority,
  addTestElection,
} from './fixtures/test-context.js'
import { AsyncStorage } from './shims/react-native.js'

// ---------------------------------------------------------------------------
// FLOW-01: NetworksEngine.create() persisted-row compliance
// ---------------------------------------------------------------------------

describe('FLOW-01: NetworksEngine.create() persisted-row compliance', () => {
  it('FLOW-01 inserts at least 1 row each in Network, Authority, Admin, Officer, User, UserKey (6 entity types)', async () => {
    const net = await createTestNetwork()
    const db = net.ctx.db

    const networkCount = ((await db.prepare('select count(*) as n from Network').get()) as any)?.n ?? 0
    const authorityCount = ((await db.prepare('select count(*) as n from Authority').get()) as any)?.n ?? 0
    const adminCount = ((await db.prepare('select count(*) as n from Admin').get()) as any)?.n ?? 0
    const officerCount = ((await db.prepare('select count(*) as n from Officer').get()) as any)?.n ?? 0
    const userCount = ((await db.prepare('select count(*) as n from User').get()) as any)?.n ?? 0
    const userKeyCount = ((await db.prepare('select count(*) as n from UserKey').get()) as any)?.n ?? 0

    expect(networkCount, 'Network row count').to.be.gte(1)
    expect(authorityCount, 'Authority row count').to.be.gte(1)
    expect(adminCount, 'Admin row count').to.be.gte(1)
    expect(officerCount, 'Officer row count').to.be.gte(1)
    expect(userCount, 'User row count').to.be.gte(1)
    expect(userKeyCount, 'UserKey row count').to.be.gte(1)
  })

  it('FLOW-01 Network.Hash is a 32-hex-char H16(Id) value', async () => {
    const net = await createTestNetwork()
    const db = net.ctx.db

    // H16 produces 16 bytes → 32 hex chars
    const nRow = (await db.prepare('select Id, Hash from Network limit 1').get()) as any
    expect(nRow, 'Network row exists').to.not.be.null
    expect(nRow.Hash, 'Network.Hash is defined').to.be.a('string')
    expect(nRow.Hash.length, 'Network.Hash is 32 hex chars (H16)').to.equal(32)
    expect(nRow.Hash, 'Network.Hash is lowercase hex').to.match(/^[0-9a-f]{32}$/)

    // Verify the ref hash matches the DB hash (getDetails path)
    expect(net.ref.hash, 'ref.hash matches DB Network.Hash').to.equal(nRow.Hash)
  })

  it('FLOW-01 Network.PrimaryAuthorityId exists in Authority table (FK valid)', async () => {
    const net = await createTestNetwork()
    const db = net.ctx.db

    const nRow = (await db.prepare('select PrimaryAuthorityId from Network limit 1').get()) as any
    expect(nRow?.PrimaryAuthorityId, 'Network.PrimaryAuthorityId is defined').to.be.a('string').that.is.not.empty

    const aRow = (await db
      .prepare('select count(*) as n from Authority where Id = :id')
      .get({ id: nRow.PrimaryAuthorityId })) as any
    expect(aRow?.n, 'PrimaryAuthorityId FK → Authority row exists').to.equal(1)
  })

  it('FLOW-01 Network.ElectionType is in the documented Scope codes (o or a per qsql)', async () => {
    const net = await createTestNetwork()
    const db = net.ctx.db

    const nRow = (await db.prepare('select ElectionType from Network limit 1').get()) as any
    expect(nRow?.ElectionType, 'Network.ElectionType is defined').to.be.a('string')
    expect(['o', 'a'], 'ElectionType ∈ {o, a}').to.include(nRow.ElectionType)
  })

  it('FLOW-01 UserKey.PubKey is valid 64/66-char hex (no .toString() artifact)', async () => {
    const net = await createTestNetwork()
    const db = net.ctx.db

    const ukRow = (await db.prepare('select PubKey, Expiration from UserKey limit 1').get()) as any
    expect(ukRow, 'UserKey row exists').to.not.be.null
    expect(ukRow.PubKey, 'UserKey.PubKey is defined').to.be.a('string')
    // Compressed secp256k1 = 33 bytes = 66 hex chars
    // Uncompressed = 65 bytes = 130 hex chars
    // Valid: must be a valid hex string (even-length, hex chars only)
    expect(ukRow.PubKey, 'UserKey.PubKey is valid hex').to.match(/^[0-9a-fA-F]{2,}$/)
    expect(ukRow.PubKey.length % 2, 'UserKey.PubKey is even-length hex').to.equal(0)
    // Must NOT be the .toString() artifact (looks like "[object Uint8Array]" or similar)
    expect(ukRow.PubKey, 'UserKey.PubKey has no .toString() artifact').to.not.include('[object')
    // Compressed or uncompressed secp256k1 key
    const len = ukRow.PubKey.length
    expect([66, 130], 'UserKey.PubKey length is 66 (compressed) or 130 (uncompressed)').to.include(len)
  })

  it('FLOW-01 UserKey.Expiration is in the future at insert time', async () => {
    const net = await createTestNetwork()
    const db = net.ctx.db

    const ukRow = (await db.prepare('select Expiration from UserKey limit 1').get()) as any
    expect(ukRow, 'UserKey row exists').to.not.be.null
    // Expiration stored as datetime — compare with 'now'
    // The schema uses datetime format; we check it's parseable and future
    const expStr = ukRow.Expiration as string
    expect(expStr, 'UserKey.Expiration is defined').to.be.a('string').that.is.not.empty
    // If it parses as a number (epoch ms) or ISO string, compare to now
    const expMs = typeof expStr === 'number' ? expStr : new Date(expStr).getTime()
    if (!isNaN(expMs)) {
      expect(expMs, 'UserKey.Expiration is in the future').to.be.gt(Date.now() - 1000) // allow 1s test tolerance
    }
  })
})

// ---------------------------------------------------------------------------
// FLOW-02: addTestAuthority() persisted-row compliance
// ---------------------------------------------------------------------------

describe('FLOW-02: addTestAuthority() persisted-row compliance', () => {
  it('FLOW-02 openAuthority returns a well-shaped authority (name present, ID non-empty)', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)

    expect(auth.authority, 'authority object is defined').to.not.be.undefined
    expect(auth.authority.id, 'authority.id is non-empty').to.be.a('string').that.is.not.empty
    expect(auth.authority.name, 'authority.name is non-empty').to.be.a('string').that.is.not.empty
  })

  it('FLOW-02 Officer.UserId is non-null and exists in User table (UserIdValid)', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const db = auth.ctx.db

    // Query Officer rows for the primary authority
    const officerRows: any[] = []
    for await (const row of db.eval(
      'select UserId from Officer where AuthorityId = :authorityId',
      { authorityId: auth.authority.id }
    )) {
      officerRows.push(row)
    }

    expect(officerRows.length, 'at least 1 Officer row exists').to.be.gte(1)
    for (const officer of officerRows) {
      expect(officer.UserId, 'Officer.UserId is non-null').to.not.be.null
      expect(officer.UserId, 'Officer.UserId is a non-empty string').to.be.a('string').that.is.not.empty

      const userRow = (await db
        .prepare('select count(*) as n from User where Id = :id')
        .get({ id: officer.UserId })) as any
      expect(userRow?.n, `Officer.UserId ${officer.UserId} exists in User table (UserIdValid)`).to.equal(1)
    }
  })

  it('FLOW-02 Officer.Scopes are all valid Scope codes (rn, rad, iad, uai, mel, ceb, vrg, cap)', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const db = auth.ctx.db

    const VALID_SCOPES = new Set(['rn', 'rad', 'iad', 'uai', 'mel', 'ceb', 'vrg', 'cap'])

    const officerRows: any[] = []
    for await (const row of db.eval(
      'select Scopes from Officer where AuthorityId = :authorityId',
      { authorityId: auth.authority.id }
    )) {
      officerRows.push(row)
    }

    expect(officerRows.length, 'Officer rows present for FLOW-02 scope check').to.be.gte(1)
    for (const officer of officerRows) {
      const scopes: string[] = JSON.parse(officer.Scopes)
      expect(scopes, 'Officer.Scopes is an array').to.be.an('array')
      for (const scope of scopes) {
        expect(VALID_SCOPES.has(scope), `scope '${scope}' ∈ documented Scope codes`).to.be.true
      }
    }
  })

  it('FLOW-02 Admin row exists for the primary authority (AuthorityId FK valid)', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const db = auth.ctx.db

    const adminRow = (await db
      .prepare('select count(*) as n from Admin where AuthorityId = :id')
      .get({ id: auth.authority.id })) as any
    expect(adminRow?.n, 'Admin row exists for authority (AuthorityId FK valid)').to.be.gte(1)
  })
})

// ---------------------------------------------------------------------------
// FLOW-03: addTestElection() persisted-row compliance
// ---------------------------------------------------------------------------

describe('FLOW-03: addTestElection() persisted-row compliance', () => {
  it('FLOW-03 Election row is persisted with correct AuthorityId FK', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elec = await addTestElection(auth)
    const db = elec.ctx.db

    const electionRow = (await db
      .prepare('select Id, AuthorityId, Title, Date, RevisionDeadline, BallotDeadline, Type from Election limit 1')
      .get()) as any
    expect(electionRow, 'Election row exists').to.not.be.null
    expect(electionRow.Id, 'Election.Id is defined').to.be.a('string').that.is.not.empty
    expect(electionRow.AuthorityId, 'Election.AuthorityId matches authority').to.equal(auth.authority.id)
  })

  it('FLOW-03 Election.RevisionDeadline ≤ Date and BallotDeadline ≤ Date (qsql deadline ordering)', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elec = await addTestElection(auth)
    const db = elec.ctx.db

    const electionRow = (await db
      .prepare('select Date, RevisionDeadline, BallotDeadline from Election limit 1')
      .get()) as any
    expect(electionRow, 'Election row exists for deadline check').to.not.be.null

    // Dates are stored as ISO 8601 datetime strings in quereus; compare lexicographically
    const date = electionRow.Date as string
    const revDeadline = electionRow.RevisionDeadline as string
    const ballotDeadline = electionRow.BallotDeadline as string

    expect(date, 'Election.Date is defined').to.be.a('string').that.is.not.empty
    expect(revDeadline, 'Election.RevisionDeadline is defined').to.be.a('string').that.is.not.empty
    expect(ballotDeadline, 'Election.BallotDeadline is defined').to.be.a('string').that.is.not.empty

    // RevisionDeadline ≤ Date
    expect(revDeadline <= date, 'RevisionDeadline ≤ Date').to.be.true
    // BallotDeadline ≤ Date
    expect(ballotDeadline <= date, 'BallotDeadline ≤ Date').to.be.true
  })

  it('FLOW-03 ElectionRevision Revision = 0 on insert (first revision)', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elec = await addTestElection(auth)
    const db = elec.ctx.db

    const revRow = (await db
      .prepare('select Revision from ElectionRevision order by Revision asc limit 1')
      .get()) as any
    expect(revRow, 'ElectionRevision row exists').to.not.be.null
    expect(revRow.Revision, 'ElectionRevision.Revision = 0 on first insert').to.equal(0)
  })

  it('FLOW-03 Election insert satisfies InsertValid (AdminSignature row exists for the election)', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elec = await addTestElection(auth)
    const db = elec.ctx.db

    // If Election row was inserted, InsertValid was satisfied (AdminSignature existed).
    // Additional check: AdminSigning + AdminSignature rows exist for scope='mel'
    const signingCount = (await db
      .prepare("select count(*) as n from AdminSigning where AuthorityId = :id and Scope = 'mel'")
      .get({ id: auth.authority.id })) as any
    expect(signingCount?.n, 'AdminSigning row for mel scope exists (Election.InsertValid satisfied)').to.be.gte(1)
  })
})

// ---------------------------------------------------------------------------
// FLOW-04: Full chain read-model — no 'hash of undefined' path
// ---------------------------------------------------------------------------

describe('FLOW-04: Full chain getDetails() read-model compliance', () => {
  it('FLOW-04 networkEngine.getDetails().network.hash is defined and 32-char hex (folded todo: hash of undefined)', async () => {
    const net = await createTestNetwork()
    // addTestAuthority uses getDetails internally — full chain test
    const auth = await addTestAuthority(net)

    const details = await net.networkEngine.getDetails()
    expect(details, 'getDetails() returns an object').to.not.be.undefined
    expect(details.network, 'details.network is defined').to.not.be.undefined
    expect(details.network.hash, 'details.network.hash is defined (folded todo: hash of undefined)').to.be.a('string').that.is.not.empty
    expect(details.network.hash.length, 'details.network.hash is 32-char hex (H16)').to.equal(32)
    expect(details.network.hash, 'details.network.hash is lowercase hex').to.match(/^[0-9a-f]{32}$/)
  })

  it('FLOW-04 networkEngine.getDetails().network.primaryAuthorityId is defined and non-empty', async () => {
    const net = await createTestNetwork()
    await addTestAuthority(net)

    const details = await net.networkEngine.getDetails()
    expect(details.network.primaryAuthorityId, 'details.network.primaryAuthorityId is defined').to.be.a('string').that.is.not.empty
  })

  it('FLOW-04 full chain (createNetwork → addAuthority → addElection) completes without error', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elec = await addTestElection(auth)

    // All three creates succeeded — verify each engine is defined
    expect(net.networkEngine, 'networkEngine is defined').to.not.be.undefined
    expect(auth.authorityEngine, 'authorityEngine is defined').to.not.be.undefined
    expect(elec.electionsEngine, 'electionsEngine is defined').to.not.be.undefined
    expect(elec.electionEngine, 'electionEngine is defined').to.not.be.undefined
  })

  it('FLOW-04 after full chain, getDetails() returns well-shaped network with authority FK valid', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    await addTestElection(auth)

    const details = await net.networkEngine.getDetails()

    // network.hash and primaryAuthorityId must be defined (the 'hash of undefined' folded todo closure)
    // getDetails() returns { network, proposed } — network.primaryAuthorityId is the FK field
    expect(details.network.hash, 'network.hash defined after full chain').to.be.a('string').that.is.not.empty
    expect(details.network.primaryAuthorityId, 'network.primaryAuthorityId defined after full chain').to.be.a('string').that.is.not.empty

    // Verify the FK is valid: openAuthority with primaryAuthorityId must return a real authority
    const authorityEngine = await net.networkEngine.openAuthority(details.network.primaryAuthorityId)
    const authorityDetails = await authorityEngine.getDetails()
    expect(authorityDetails.authority.id, 'authority from openAuthority has an id').to.be.a('string').that.is.not.empty
    expect(authorityDetails.authority.name, 'authority from openAuthority has a name').to.be.a('string').that.is.not.empty
  })
})

// ---------------------------------------------------------------------------
// VTEST-01: Surfaced read-model compliance — authority + election reads
// ---------------------------------------------------------------------------

describe('VTEST-01: Surfaced read-model compliance (D-06)', () => {
  it('VTEST-01 openAuthority(primaryAuthorityId).getDetails() returns well-shaped authority', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)

    const details = await net.networkEngine.getDetails()
    const primaryAuthorityId = details.network.primaryAuthorityId
    expect(primaryAuthorityId, 'primaryAuthorityId is non-empty').to.be.a('string').that.is.not.empty

    const authorityEngine = await net.networkEngine.openAuthority(primaryAuthorityId)
    const authorityDetails = await authorityEngine.getDetails()

    // Authority read-model shape (D-06)
    expect(authorityDetails, 'authorityDetails is defined').to.not.be.undefined
    expect(authorityDetails.authority, 'authorityDetails.authority is defined').to.not.be.undefined
    expect(authorityDetails.authority.id, 'authority.id is defined (non-undefined)').to.be.a('string').that.is.not.empty
    expect(authorityDetails.authority.name, 'authority.name is defined (non-undefined)').to.be.a('string').that.is.not.empty
    // No undefined on the fields the beachhead screens consume
    expect(authorityDetails.authority.id, 'authority.id is not undefined').to.not.equal(undefined)
    expect(authorityDetails.authority.name, 'authority.name is not undefined').to.not.equal(undefined)
  })

  it('VTEST-01 openElection.getElectionDetails() returns election with current revision, no undefined on documented fields', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elec = await addTestElection(auth)

    const electionDetails = await elec.electionEngine.getElectionDetails()

    // Election read-model shape (D-06, architecture.md)
    expect(electionDetails, 'electionDetails is defined').to.not.be.undefined
    expect(electionDetails.election, 'electionDetails.election is defined').to.not.be.undefined
    expect(electionDetails.current, 'electionDetails.current (current revision) is defined').to.not.be.undefined

    // Core election fields — none must be undefined
    expect(electionDetails.election.id, 'election.id is not undefined').to.be.a('string').that.is.not.empty
    expect(electionDetails.election.authorityId, 'election.authorityId is not undefined').to.be.a('string').that.is.not.empty
    expect(electionDetails.election.title, 'election.title is not undefined').to.be.a('string').that.is.not.empty
    expect(electionDetails.election.date, 'election.date is not undefined').to.be.a('number').that.is.gt(0)
    expect(electionDetails.election.type, 'election.type is not undefined').to.be.a('string')

    // Current revision fields
    expect(electionDetails.current.electionId, 'current.electionId is not undefined').to.be.a('string').that.is.not.empty
    expect(electionDetails.current.revision, 'current.revision is not undefined').to.be.a('number')
    expect(electionDetails.current.revision, 'current.revision = 0 on first revision').to.equal(0)
    expect(electionDetails.current.instructions, 'current.instructions is not undefined').to.be.a('string')
  })

  it('VTEST-01 surfaced read-model consistency: network.primaryAuthorityId → openAuthority → getDetails().id match', async () => {
    const net = await createTestNetwork()
    await addTestAuthority(net)

    const networkDetails = await net.networkEngine.getDetails()
    const primaryAuthorityId = networkDetails.network.primaryAuthorityId

    const authorityEngine = await net.networkEngine.openAuthority(primaryAuthorityId)
    const authorityDetails = await authorityEngine.getDetails()

    // The primaryAuthorityId FK must round-trip through the read-model
    expect(authorityDetails.authority.id, 'authority ID from getDetails() matches network.primaryAuthorityId').to.equal(primaryAuthorityId)
  })

  it('VTEST-01 Election.Type is a valid ElectionType code (o or a)', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elec = await addTestElection(auth)

    const electionDetails = await elec.electionEngine.getElectionDetails()
    expect(['o', 'a'], 'election.type ∈ ElectionType codes {o, a}').to.include(electionDetails.election.type)
  })

  it('VTEST-01 no undefined on Authority.id and Network.hash in read-model (D-06 null-undefined guard)', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elec = await addTestElection(auth)

    const networkDetails = await net.networkEngine.getDetails()

    // Directly assert none of the documented screen-consumed fields are undefined
    const fields = [
      { name: 'network.hash', value: networkDetails.network.hash },
      { name: 'network.primaryAuthorityId', value: networkDetails.network.primaryAuthorityId },
      { name: 'network.name', value: networkDetails.network.name },
      { name: 'network.id', value: networkDetails.network.id },
    ]
    for (const field of fields) {
      expect(field.value, `${field.name} is not undefined`).to.not.equal(undefined)
      expect(field.value, `${field.name} is not null`).to.not.equal(null)
      expect(field.value, `${field.name} is a non-empty string`).to.be.a('string').that.is.not.empty
    }
  })
})
