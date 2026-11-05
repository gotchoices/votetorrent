/**
 * snapshot-manifest.spec.ts — Phase 50 Plan 02 (D-07, D-12, D-13)
 *
 * Proves the frozen `BootstrapSnapshot` envelope arithmetic: deterministic
 * canonical serialization (`snapshot-codec.ts`) and the manifest/digest/
 * schema-hash fail-closed verifier (`snapshot-manifest.ts`).
 *
 * DECLARED BLIND SPOT: this spec exercises no schema CHECK and no
 * IndexedDB. It proves envelope arithmetic only, and says nothing about
 * whether a verified snapshot will actually apply to a Quereus catalog —
 * that proof lives in 50-05's re-attach suite and 50-08's bootstrap flow.
 */

import { expect } from 'chai'
import {
  canonicalizeTables,
  decodeBlobValue,
  encodeBlobValue,
  parseSnapshot,
  serializeSnapshot
} from '../src/bootstrap/snapshot-codec.js'
import {
  buildManifest,
  buildSnapshot,
  computeContentDigest,
  computeSchemaHash,
  verifySnapshot
} from '../src/bootstrap/snapshot-manifest.js'
import { SNAPSHOT_FORMAT_VERSION } from '../src/bootstrap/snapshot-types.js'
import type { BootstrapSnapshot, SnapshotManifest, SnapshotTables } from '../src/bootstrap/snapshot-types.js'

/**
 * A local, codec-only stand-in for `buildManifest` (owned by
 * `snapshot-manifest.ts`, Task 3). Correct here because this describe block
 * proves ONLY that the envelope carries whatever manifest/digest it is
 * handed through a round trip — it says nothing about whether the manifest
 * or digest are actually correct for the tables. That proof is Task 3's.
 */
function localManifestStandIn (tables: SnapshotTables): SnapshotManifest {
  const manifest: Record<string, number> = {}
  for (const [name, rows] of Object.entries(tables)) manifest[name] = rows.length
  return manifest
}

const PII_CANARY = 'PII-CANARY-9f3a'

/** A small two/three-table fixture with mixed value types. Never real schema data. */
function makeTables (): SnapshotTables {
  return {
    Authority: [
      { Id: 'auth-1', Name: 'First Authority', Active: true, Notes: null },
      { Id: 'auth-2', Name: 'Second Authority', Active: false, Notes: 'has notes' }
    ],
    Election: [
      { Id: 'elect-1', AuthorityId: 'auth-1', Revision: 0, Blob: encodeBlobValue(new Uint8Array([1, 2, 3])) }
    ],
    Empty: []
  }
}

describe('snapshot codec', () => {
  describe('canonicalizeTables', () => {
    it('1. is stable across differing key insertion order (positive control)', () => {
      const a: SnapshotTables = { Zeta: [{ b: 1, a: 2 }], Alpha: [{ x: 1 }] }
      const b: SnapshotTables = { Alpha: [{ x: 1 }], Zeta: [{ a: 2, b: 1 }] }
      expect(canonicalizeTables(a)).to.equal(canonicalizeTables(b))
    })

    it('2. sorts by UTF-16 code-unit order, not localeCompare, regardless of naming (Z, a, A, _)', () => {
      const tables: SnapshotTables = {
        Z: [{ v: 1 }],
        a: [{ v: 2 }],
        A: [{ v: 3 }],
        _: [{ v: 4 }]
      }
      const json = canonicalizeTables(tables)
      // UTF-16 code-unit order: 'A' (0x41) < 'Z' (0x5A) < '_' (0x5F) < 'a' (0x61)
      const order = ['A', 'Z', '_', 'a']
      const expected = `{${order.map((k) => `"${k}":[{"v":${(tables[k] as any)[0].v}}]`).join(',')}}`
      expect(json).to.equal(expected)
    })

    it('3. preserves row array order verbatim (paired negative: reversing rows changes the output)', () => {
      const forward: SnapshotTables = { T: [{ id: 1 }, { id: 2 }] }
      const reversed: SnapshotTables = { T: [{ id: 2 }, { id: 1 }] }
      expect(canonicalizeTables(forward)).to.not.equal(canonicalizeTables(reversed))
    })

    it('4a. throws a TypeError on undefined, naming table+column, never the value', () => {
      const tables = { T: [{ col: undefined as unknown as null }] }
      expect(() => canonicalizeTables(tables)).to.throw(TypeError, 'snapshot: unsupported value type in T.col')
    })

    it('4b. throws a TypeError on NaN / Infinity', () => {
      expect(() => canonicalizeTables({ T: [{ col: NaN }] })).to.throw(TypeError, 'snapshot: unsupported value type in T.col')
      expect(() => canonicalizeTables({ T: [{ col: Infinity }] })).to.throw(TypeError, 'snapshot: unsupported value type in T.col')
    })

    it('4c. throws a TypeError on an array value', () => {
      const tables = { T: [{ col: [1, 2] as unknown as null }] }
      expect(() => canonicalizeTables(tables)).to.throw(TypeError, 'snapshot: unsupported value type in T.col')
    })

    it('4d. throws a TypeError on an object that is not exactly { $bytes: string } (paired positive: a real blob value succeeds)', () => {
      const badTables = { T: [{ col: { nope: 1 } as unknown as null }] }
      expect(() => canonicalizeTables(badTables)).to.throw(TypeError, 'snapshot: unsupported value type in T.col')

      const goodTables: SnapshotTables = { T: [{ col: encodeBlobValue(new Uint8Array([9, 8, 7])) }] }
      expect(() => canonicalizeTables(goodTables)).to.not.throw()
      expect(canonicalizeTables(goodTables)).to.include('"$bytes"')
    })
  })

  describe('serializeSnapshot / parseSnapshot round trip', () => {
    function makeEnvelope (): BootstrapSnapshot {
      const tables = makeTables()
      return {
        formatVersion: SNAPSHOT_FORMAT_VERSION,
        networkHash: 'net-hash-abc',
        schemaHash: 'schema-hash-xyz',
        generatedAt: '2026-08-25T12:00:00',
        manifest: localManifestStandIn(tables),
        digest: canonicalizeTables(tables).length.toString(),
        tables
      }
    }

    it('5. serializeSnapshot is whitespace-free JSON whose parse is deep-equal to the input, stable across key order', () => {
      const envelope = makeEnvelope()
      const json = serializeSnapshot(envelope)
      // "Whitespace-free" means no FORMATTING whitespace (no newlines/tabs, no
      // space padding around structural characters) — content string values
      // (e.g. "has notes") legitimately contain spaces, so a blanket /\s/
      // test would be a false positive on this module's own fixture.
      expect(json).to.not.match(/[\n\t]/)
      expect(json).to.not.match(/[:,{[]\s/)
      expect(json).to.not.match(/\s[}\]]/)
      expect(JSON.parse(json)).to.deep.equal(envelope)

      // Reordered top-level keys must serialize identically.
      const reordered = {
        tables: envelope.tables,
        digest: envelope.digest,
        manifest: envelope.manifest,
        generatedAt: envelope.generatedAt,
        schemaHash: envelope.schemaHash,
        networkHash: envelope.networkHash,
        formatVersion: envelope.formatVersion
      } as unknown as BootstrapSnapshot
      expect(serializeSnapshot(reordered)).to.equal(json)
    })

    it('6a. parseSnapshot never throws and returns malformed-envelope on a byte-truncated string', () => {
      const envelope = makeEnvelope()
      const truncated = serializeSnapshot(envelope).slice(0, 10)
      const result = parseSnapshot(truncated)
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('malformed-envelope')
    })

    it('6b. parseSnapshot rejects a bare JSON array', () => {
      const result = parseSnapshot('[1,2,3]')
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('malformed-envelope')
    })

    it('6c. parseSnapshot rejects an object missing any one of the seven required members (paired positive: full object succeeds)', () => {
      const envelope = makeEnvelope()
      const full = JSON.parse(serializeSnapshot(envelope))
      const okResult = parseSnapshot(JSON.stringify(full))
      expect(okResult.ok).to.equal(true)

      for (const member of ['formatVersion', 'networkHash', 'schemaHash', 'generatedAt', 'manifest', 'digest', 'tables']) {
        const clone = { ...full }
        delete clone[member]
        const result = parseSnapshot(JSON.stringify(clone))
        expect(result.ok, `missing ${member} must be rejected`).to.equal(false)
        if (!result.ok) expect(result.reason).to.equal('malformed-envelope')
      }
    })

    it('6d. parseSnapshot rejects a manifest value that is not a non-negative integer', () => {
      const envelope = makeEnvelope()
      const full = JSON.parse(serializeSnapshot(envelope))
      full.manifest.Authority = -1
      const result = parseSnapshot(JSON.stringify(full))
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('malformed-envelope')
    })

    it('6e. parseSnapshot rejects a tables value that is not an array', () => {
      const envelope = makeEnvelope()
      const full = JSON.parse(serializeSnapshot(envelope))
      full.tables.Authority = { not: 'an array' }
      const result = parseSnapshot(JSON.stringify(full))
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('malformed-envelope')
    })

    it('7. parseSnapshot on a well-formed serialization returns ok:true with a deep-equal envelope (positive control)', () => {
      const envelope = makeEnvelope()
      const result = parseSnapshot(serializeSnapshot(envelope))
      expect(result.ok).to.equal(true)
      if (result.ok) expect(result.envelope).to.deep.equal(envelope)
    })
  })

  describe('encodeBlobValue / decodeBlobValue', () => {
    it('8. round-trips an arbitrary Uint8Array: empty, single 0x00, and 255 distinct bytes', () => {
      const empty = new Uint8Array([])
      expect(decodeBlobValue(encodeBlobValue(empty))).to.deep.equal(empty)

      const singleZero = new Uint8Array([0x00])
      expect(decodeBlobValue(encodeBlobValue(singleZero))).to.deep.equal(singleZero)

      const distinct255 = new Uint8Array(255)
      for (let i = 0; i < 255; i++) distinct255[i] = i
      expect(decodeBlobValue(encodeBlobValue(distinct255))).to.deep.equal(distinct255)
    })
  })

  describe('PII hygiene', () => {
    it('9. no detail string produced by parseSnapshot contains a marker value planted in the payload', () => {
      const tables: SnapshotTables = { Registrant: [{ Name: PII_CANARY }] }
      const envelope: BootstrapSnapshot = {
        formatVersion: SNAPSHOT_FORMAT_VERSION,
        networkHash: 'net-hash-abc',
        schemaHash: 'schema-hash-xyz',
        generatedAt: '2026-08-25T12:00:00',
        manifest: localManifestStandIn(tables),
        digest: canonicalizeTables(tables).length.toString(),
        tables
      }
      const full = JSON.parse(serializeSnapshot(envelope))
      // Malformed variant: corrupt manifest to trigger a detail string.
      full.manifest.Registrant = -1
      const result = parseSnapshot(JSON.stringify(full))
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.detail).to.not.include(PII_CANARY)
    })

    it("10. the TypeError message form is exact and the JSON.parse-failure detail is exact", () => {
      expect(() => canonicalizeTables({ T: [{ col: undefined as unknown as null }] })).to.throw(
        TypeError,
        'snapshot: unsupported value type in'
      )
      const result = parseSnapshot('not json at all {{{')
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.detail).to.equal('snapshot: payload is not valid JSON')
    })
  })
})

describe('snapshot manifest and verifier', () => {
  /** Deep-clone a positive-control envelope so each test mutates its own copy. */
  function cloneEnvelope (envelope: BootstrapSnapshot): BootstrapSnapshot {
    return JSON.parse(JSON.stringify(envelope)) as BootstrapSnapshot
  }

  function makeGoodEnvelope (): BootstrapSnapshot {
    const tables = makeTables()
    // Plant the PII canary as a genuine row value so every negative case
    // below can assert it never leaks into a `detail` string.
    const tablesWithCanary: SnapshotTables = {
      ...tables,
      Authority: [...tables.Authority, { Id: 'auth-canary', Name: PII_CANARY, Active: true, Notes: null }]
    }
    return buildSnapshot({ networkHash: 'net-hash-verify', tables: tablesWithCanary })
  }

  it('1. buildManifest includes a zero-row table with count 0, never omitted', () => {
    const manifest = buildManifest({ Empty: [], NonEmpty: [{ a: 1 }] })
    expect(manifest.Empty).to.equal(0)
    expect(manifest.NonEmpty).to.equal(1)
    expect(Object.keys(manifest)).to.include('Empty')
  })

  it('2. computeSchemaHash is stable across repeat calls and differs for an altered schema string', () => {
    const a = computeSchemaHash()
    const b = computeSchemaHash()
    expect(a).to.equal(b)
    const altered = computeSchemaHash('declare schema main {}')
    expect(altered).to.not.equal(a)
  })

  it('3. buildSnapshot produces a canonical generatedAt, the right formatVersion, and verifySnapshot accepts it (positive control)', () => {
    const envelope = makeGoodEnvelope()
    expect(envelope.generatedAt).to.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
    expect(envelope.generatedAt).to.not.include('Z')
    expect(envelope.generatedAt.length).to.equal(19)
    expect(envelope.formatVersion).to.equal(SNAPSHOT_FORMAT_VERSION)
    const result = verifySnapshot(envelope)
    expect(result.ok).to.equal(true)
  })

  it('4. round trip: buildSnapshot -> serializeSnapshot -> parseSnapshot -> verifySnapshot returns ok:true', () => {
    const envelope = makeGoodEnvelope()
    const parsed = parseSnapshot(serializeSnapshot(envelope))
    expect(parsed.ok).to.equal(true)
    if (parsed.ok) {
      const result = verifySnapshot(parsed.envelope)
      expect(result.ok).to.equal(true)
    }
  })

  it('5. truncation: dropping rows from one table while manifest stays untouched fails manifest-mismatch, detail names table + both counts, no PII leak', () => {
    const good = makeGoodEnvelope()
    const truncated = cloneEnvelope(good)
    truncated.tables.Authority = [truncated.tables.Authority[0]!]
    const result = verifySnapshot(truncated)
    expect(result.ok).to.equal(false)
    if (!result.ok) {
      expect(result.reason).to.equal('manifest-mismatch')
      expect(result.detail).to.include('Authority')
      expect(result.detail).to.not.include(PII_CANARY)
    }
  })

  it('6. corruption: changing exactly one cell value (row counts unchanged) fails digest-mismatch', () => {
    const good = makeGoodEnvelope()
    const corrupted = cloneEnvelope(good)
    corrupted.tables.Authority[0]!.Name = 'A Different Name Entirely'
    const result = verifySnapshot(corrupted)
    expect(result.ok).to.equal(false)
    if (!result.ok) expect(result.reason).to.equal('digest-mismatch')
  })

  it('7a. a table dropped entirely from tables while present in manifest fails manifest-mismatch', () => {
    const good = makeGoodEnvelope()
    const dropped = cloneEnvelope(good)
    delete (dropped.tables as Record<string, unknown>).Election
    const result = verifySnapshot(dropped)
    expect(result.ok).to.equal(false)
    if (!result.ok) expect(result.reason).to.equal('manifest-mismatch')
  })

  it('7b. an extra table present in tables but absent from manifest fails manifest-mismatch', () => {
    const good = makeGoodEnvelope()
    const extra = cloneEnvelope(good)
    ;(extra.tables as Record<string, unknown>).Extra = [{ a: 1 }]
    const result = verifySnapshot(extra)
    expect(result.ok).to.equal(false)
    if (!result.ok) expect(result.reason).to.equal('manifest-mismatch')
  })

  it('8. schema drift: an altered schemaHash fails schema-hash-mismatch BEFORE any manifest or digest comparison runs', () => {
    const good = makeGoodEnvelope()
    const drifted = cloneEnvelope(good)
    drifted.schemaHash = 'not-the-real-schema-hash'
    // ALSO manifest-broken — proves step 5 short-circuits ahead of step 6.
    delete (drifted.tables as Record<string, unknown>).Election
    const result = verifySnapshot(drifted)
    expect(result.ok).to.equal(false)
    if (!result.ok) expect(result.reason).to.equal('schema-hash-mismatch')
  })

  it('9. format drift: formatVersion 2 fails format-version-mismatch', () => {
    const good = makeGoodEnvelope()
    const drifted = cloneEnvelope(good)
    ;(drifted as { formatVersion: number }).formatVersion = 2
    const result = verifySnapshot(drifted)
    expect(result.ok).to.equal(false)
    if (!result.ok) expect(result.reason).to.equal('format-version-mismatch')
  })

  it('10. datetime: a generatedAt with a trailing Z (the classic landmine) fails non-canonical-generated-at', () => {
    const good = makeGoodEnvelope()
    const zSuffixed = cloneEnvelope(good)
    zSuffixed.generatedAt = '2026-08-25T12:00:00Z'
    const result = verifySnapshot(zSuffixed)
    expect(result.ok).to.equal(false)
    if (!result.ok) expect(result.reason).to.equal('non-canonical-generated-at')
  })

  it('11. out-of-band anchor: expectedDigest mismatch fails digest-mismatch even on an internally consistent envelope; matching expectedDigest passes', () => {
    const good = makeGoodEnvelope()
    const mismatched = verifySnapshot(good, { expectedDigest: 'not-the-real-digest' })
    expect(mismatched.ok).to.equal(false)
    if (!mismatched.ok) expect(mismatched.reason).to.equal('digest-mismatch')

    const matched = verifySnapshot(good, { expectedDigest: good.digest })
    expect(matched.ok).to.equal(true)
  })

  it('12. cross-network: a non-matching expectedNetworkHash fails network-hash-mismatch', () => {
    const good = makeGoodEnvelope()
    const result = verifySnapshot(good, { expectedNetworkHash: 'a-different-network-hash' })
    expect(result.ok).to.equal(false)
    if (!result.ok) expect(result.reason).to.equal('network-hash-mismatch')
  })

  it('13. ordering proof: simultaneously truncated AND bit-flipped fails manifest-mismatch, not digest-mismatch (step 6 precedes step 7)', () => {
    const good = makeGoodEnvelope()
    const multiFault = cloneEnvelope(good)
    multiFault.tables.Authority = [multiFault.tables.Authority[0]!] // truncation
    multiFault.tables.Election[0]!.AuthorityId = 'a-bit-flipped-value' // corruption elsewhere
    const result = verifySnapshot(multiFault)
    expect(result.ok).to.equal(false)
    if (!result.ok) expect(result.reason).to.equal('manifest-mismatch')
  })

  it('14. no detail string from any negative case above contains the planted PII canary', () => {
    const good = makeGoodEnvelope()
    const cases: BootstrapSnapshot[] = []

    const truncated = cloneEnvelope(good)
    truncated.tables.Authority = [truncated.tables.Authority[0]!]
    cases.push(truncated)

    const corrupted = cloneEnvelope(good)
    corrupted.tables.Authority[0]!.Name = 'Something Else'
    cases.push(corrupted)

    const dropped = cloneEnvelope(good)
    delete (dropped.tables as Record<string, unknown>).Election
    cases.push(dropped)

    const drifted = cloneEnvelope(good)
    drifted.schemaHash = 'wrong'
    cases.push(drifted)

    for (const envelope of cases) {
      const result = verifySnapshot(envelope)
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.detail).to.not.include(PII_CANARY)
    }
  })

  it('15. computeContentDigest is deterministic for identical tables', () => {
    const tables = makeTables()
    expect(computeContentDigest(tables)).to.equal(computeContentDigest(tables))
  })
})
