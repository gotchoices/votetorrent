/**
 * threshold-scope-coverage.spec.ts — 62-13 (D-12): the permanent per-scope coverage audit.
 *
 * Pure file-system and import assertions — no DB, no fixture. Scans `votetorrent.qsql` and
 * `packages/vote-engine/src` — never this file itself — so it cannot trip on its own prose.
 *
 * Verdict, one line per `view Scope` code:
 *   ceb — covered. Producer: ElectionEngine's ballot-confirmation submit. Spec: threshold-ceb.spec.ts.
 *   vrg — covered. Producer: the registrant-approval inbox seed pass. Spec: threshold-vrg.spec.ts.
 *   rad — covered. Producer: AuthorityEngine's administration proposal. Spec: threshold-rad.spec.ts.
 *   rn  — an extension table exists; no production code inserts a Task of that type. Listed
 *         tasks fall back to a base task with no Task path.
 *   uai — same shape as rn, for authority-information revisions.
 *   mel — same shape as rn, shared by two extension tables (election creation and revision).
 *   iad — no extension table at all. No Task path exists for inviting other authorities.
 *   cap — no extension table at all. No Task path exists for configuring authority peers.
 *   ik  — no extension table at all. No Task path exists for keyholder invites.
 */

import { expect } from 'chai'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SIGNATURE_TYPE_SCOPE } from '../src/signing/fan-out.js'

const testDir = dirname(fileURLToPath(import.meta.url))
const QSQL_PATH = join(testDir, '../../vote-core/schema/votetorrent.qsql')
const SRC_DIR = join(testDir, '../src')

// The two scope groups this audit's permanent gate recognizes (D-12: "every scope with a Task
// path" is concretely ceb/vrg/rad). A new scope, or a scope moving between groups without this
// file being updated deliberately, fails A1.
const COVERED_SCOPES = ['ceb', 'vrg', 'rad'] as const
const NO_TASK_PATH_SCOPES = ['rn', 'uai', 'mel', 'iad', 'cap', 'ik'] as const

// A3: the per-file manifest of `insert into Task (... SignatureType ...)` sites. A new site in
// any OTHER file — a bypass of the shared fanOutSignatureTasks helper — fails this gate.
const SIGNATURE_TASK_PRODUCERS: Record<string, number> = {
  'signing/fan-out.ts': 1,
  'election/election-engine.ts': 1,
  'tasks/signature-tasks-engine.ts': 1,
  'elections/elections-engine.ts': 1,
}

function stripComments (text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('--'))
    })
    .join('\n')
}

function walkTsFiles (dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(full))
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

describe('D-12 threshold scope coverage audit', () => {
  it('A1: the qsql Scope view codes equal COVERED_SCOPES union NO_TASK_PATH_SCOPES, no overlap', () => {
    const qsql = readFileSync(QSQL_PATH, 'utf8')
    const scopeViewMatch = qsql.match(/view Scope as([\s\S]*?);/)
    expect(scopeViewMatch, 'A1: could not locate the `view Scope as ... ;` block in votetorrent.qsql').to.not.be.null
    const scopeBlock = scopeViewMatch![1]!
    const codes = Array.from(scopeBlock.matchAll(/select '([a-z]+)' as Code/g)).map((m) => m[1]!).sort()
    const expected = [...COVERED_SCOPES, ...NO_TASK_PATH_SCOPES].slice().sort()
    expect(codes, 'A1: Scope codes must equal COVERED_SCOPES union NO_TASK_PATH_SCOPES').to.deep.equal(expected)

    const overlap = COVERED_SCOPES.filter((s) => (NO_TASK_PATH_SCOPES as readonly string[]).includes(s))
    expect(overlap, 'A1: no overlap between COVERED_SCOPES and NO_TASK_PATH_SCOPES').to.deep.equal([])
  })

  it('A2: the extension-table-to-scope map matches SIGNATURE_TYPE_SCOPE and the no-producer/no-path scope lists', () => {
    const qsql = readFileSync(QSQL_PATH, 'utf8')

    const tableStarts: Array<{ name: string; index: number }> = []
    const tableRe = /table (\w+SignatureTaskExtension) \(/g
    let match: RegExpExecArray | null
    while ((match = tableRe.exec(qsql)) !== null) {
      tableStarts.push({ name: match[1]!, index: match.index })
    }
    expect(tableStarts.length, 'A2: expected 7 *SignatureTaskExtension tables').to.equal(7)

    const extractedMap: Record<string, { signatureType: string; scope: string }> = {}
    for (let i = 0; i < tableStarts.length; i++) {
      const start = tableStarts[i]!.index
      const nextTableIdx = qsql.indexOf('\n\ttable ', start + 1)
      const block = nextTableIdx === -1 ? qsql.slice(start) : qsql.slice(start, nextTableIdx)
      const sigTypeMatch = block.match(/T\.SignatureType = '([a-z-]+)'/)
      const scopeMatch = block.match(/A\.Scope = '([a-z]+)'/)
      expect(sigTypeMatch, `A2: ${tableStarts[i]!.name} missing a T.SignatureType = '...' clause`).to.not.be.null
      expect(scopeMatch, `A2: ${tableStarts[i]!.name} missing an A.Scope = '...' clause`).to.not.be.null
      extractedMap[tableStarts[i]!.name] = { signatureType: sigTypeMatch![1]!, scope: scopeMatch![1]! }
    }

    const expectedMap: Record<string, { signatureType: string; scope: string }> = {
      NetworkSignatureTaskExtension: { signatureType: 'network', scope: 'rn' },
      AuthoritySignatureTaskExtension: { signatureType: 'authority', scope: 'uai' },
      AdminSignatureTaskExtension: { signatureType: 'admin', scope: 'rad' },
      ElectionSignatureTaskExtension: { signatureType: 'election', scope: 'mel' },
      ElectionRevisionSignatureTaskExtension: { signatureType: 'election-revision', scope: 'mel' },
      BallotSignatureTaskExtension: { signatureType: 'ballot', scope: 'ceb' },
      RegistrantSignatureTaskExtension: { signatureType: 'registrant', scope: 'vrg' },
    }
    expect(extractedMap, 'A2: extension-table-to-scope map').to.deep.equal(expectedMap)

    for (const [signatureType, scope] of Object.entries(SIGNATURE_TYPE_SCOPE)) {
      const extName = Object.keys(expectedMap).find((n) => expectedMap[n]!.signatureType === signatureType)
      expect(extName, `A2: no extension table found for SIGNATURE_TYPE_SCOPE['${signatureType}']`).to.not.be.undefined
      expect(expectedMap[extName!]!.scope, `A2: schema scope for '${signatureType}' must equal the helper's scope`).to.equal(scope)
    }

    const scopesWithExtension = new Set(Object.values(extractedMap).map((v) => v.scope))
    for (const s of ['rn', 'uai', 'mel']) {
      expect(scopesWithExtension.has(s), `A2: ${s} must appear as the scope of at least one extension table`).to.equal(true)
    }
    for (const s of ['iad', 'cap', 'ik']) {
      expect(scopesWithExtension.has(s), `A2: ${s} must appear in NO extension-table block`).to.equal(false)
    }
  })

  it('A3: insert-into-Task(SignatureType) producers equal SIGNATURE_TASK_PRODUCERS — no other file has one', () => {
    const files = walkTsFiles(SRC_DIR)
    const insertRe = /insert\s+into\s+Task\s*\(([^)]*)\)/gi
    const counts: Record<string, number> = {}
    for (const file of files) {
      const text = stripComments(readFileSync(file, 'utf8'))
      const matches = Array.from(text.matchAll(insertRe)).filter((m) => (m[1] ?? '').includes('SignatureType'))
      if (matches.length > 0) {
        const rel = relative(SRC_DIR, file).split('\\').join('/')
        counts[rel] = matches.length
      }
    }
    expect(counts, 'A3: signature-Task producer manifest').to.deep.equal(SIGNATURE_TASK_PRODUCERS)
  })

  it('A4 ceb: election-engine.ts fans out through the shared helper with signatureType ballot', () => {
    const text = stripComments(readFileSync(join(SRC_DIR, 'election/election-engine.ts'), 'utf8'))
    expect(text.includes('fanOutSignatureTasks('), 'A4 ceb: fanOutSignatureTasks( call').to.equal(true)
    expect(text.includes("signatureType: 'ballot'"), "A4 ceb: signatureType: 'ballot'").to.equal(true)
  })

  it('A4 vrg: signature-tasks-engine.ts fans out through the shared helper with signatureType registrant', () => {
    const text = stripComments(readFileSync(join(SRC_DIR, 'tasks/signature-tasks-engine.ts'), 'utf8'))
    expect(text.includes('fanOutSignatureTasks('), 'A4 vrg: fanOutSignatureTasks( call').to.equal(true)
    expect(text.includes("signatureType: 'registrant'"), "A4 vrg: signatureType: 'registrant'").to.equal(true)
  })

  it('rad: proposeAdmin fans out through the shared helper', () => {
    const text = stripComments(readFileSync(join(SRC_DIR, 'authority/authority-engine.ts'), 'utf8'))
    expect(text.includes('fanOutSignatureTasks('), 'A4 rad: fanOutSignatureTasks( call').to.equal(true)
    expect(text.includes("signatureType: 'admin'"), "A4 rad: signatureType: 'admin'").to.equal(true)
    const directTaskInserts = Array.from(text.matchAll(/insert\s+into\s+Task\s*\(/gi)).length
    expect(directTaskInserts, 'A4 rad: no direct signature-Task insert — only the shared helper').to.equal(0)
  })

  it('A5: each covered scope has a threshold-2 end-to-end spec driving completeSignature at least twice', () => {
    const specs: Array<[string, string]> = [
      ['ceb', 'threshold-ceb.spec.ts'],
      ['vrg', 'threshold-vrg.spec.ts'],
      ['rad', 'threshold-rad.spec.ts'],
    ]
    for (const [scope, filename] of specs) {
      const text = readFileSync(join(testDir, filename), 'utf8')
      expect(text.includes('createThresholdAuthority('), `A5 ${scope}: ${filename} must use createThresholdAuthority(`).to.equal(true)
      const completeSignatureCalls = Array.from(text.matchAll(/completeSignature\(/g)).length
      expect(completeSignatureCalls, `A5 ${scope}: ${filename} must call completeSignature( at least twice`).to.be.at.least(2)
    }
  })
})
