/**
 * access-trail-visit-invariants — the executable form of Phase 47's D-14
 * accepted-loss decision and D-01's framing (T-47-02, T-47-03).
 *
 * The D-14 accepted-loss decision is a DECISION, and the only way a
 * decision survives future edits is if quietly reversing it turns a test
 * red. A reviewer reading a diff that adds an `AsyncStorage` write "so we
 * don't lose the row" would very likely wave it through as an improvement.
 * This suite makes that edit fail a Phase 47-named test that says, in its
 * own name, that the loss is accepted.
 *
 * D-01 FRAMING, RESTATED ONCE: the trail records app-mediated reveals
 * only, for accountability, deterrence and regulatory posture, and is not
 * a security control.
 *
 * These assertions are STRUCTURAL, not behavioral -- Tasks 1 and 2 own
 * behavior, and duplicating it here would make this suite the place people
 * edit when behavior changes, which is exactly what would erode the gate.
 * Both source files are read with `fs.readFileSync` and comment-stripped
 * before matching (mirroring `private-tier-invariants.test.tsx`'s idiom),
 * so a header comment can never self-invalidate a gate.
 */

import * as fs from 'fs'
import * as path from 'path'

const ACCESS_TRAIL_VISIT_PATH = path.join(__dirname, '../access-trail-visit.ts')
const USE_ACCESS_TRAIL_VISIT_PATH = path.join(__dirname, '../useAccessTrailVisit.ts')

/**
 * Strips `//` line comments and `/* ... *\/` block comments (including
 * doc-comment header blocks) from a source string, so a prose mention of a
 * forbidden token inside a comment can never trip -- or hide a trip of -- a
 * gate meant to catch it in real code.
 */
function stripComments (source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

function readRaw (filePath: string): string {
  return fs.readFileSync(filePath, 'utf8')
}

function readStripped (filePath: string): string {
  return stripComments(readRaw(filePath))
}

const VISIT_RAW = readRaw(ACCESS_TRAIL_VISIT_PATH)
const VISIT_STRIPPED = readStripped(ACCESS_TRAIL_VISIT_PATH)
const HOOK_RAW = readRaw(USE_ACCESS_TRAIL_VISIT_PATH)
const HOOK_STRIPPED = readStripped(USE_ACCESS_TRAIL_VISIT_PATH)

describe('access-trail-visit-invariants — D-14 accepted loss, D-01 framing (T-47-02/T-47-03)', () => {
  it('the accepted-loss decision is written into the source, not only into the plan', () => {
    // This is the one assertion that deliberately reads the comments
    // rather than stripping them: the decision lives in prose, and its
    // absence would mean a future reader finds an unexplained empty catch.
    expect(VISIT_RAW).toContain('acceptable loss')
    expect(VISIT_RAW).toContain('no retry')
    expect(VISIT_RAW).toContain('not a security control')
  })

  it('neither file builds a retry queue', () => {
    for (const source of [VISIT_STRIPPED, HOOK_STRIPPED]) {
      expect(source).not.toMatch(/retryQueue/i)
      expect(source).not.toMatch(/\bretry\(/)
      expect(source).not.toMatch(/pendingWrites/i)
      expect(source).not.toMatch(/\bqueue\b/i)
      expect(source).not.toMatch(/backoff/i)
    }
  })

  it('neither file persists anything before the flush', () => {
    for (const source of [VISIT_STRIPPED, HOOK_STRIPPED]) {
      expect(source).not.toMatch(/AsyncStorage/)
      expect(source).not.toMatch(/MMKV/i)
      expect(source).not.toMatch(/localStorage/)
      expect(source).not.toMatch(/writeFile/)
      expect(source).not.toMatch(/\bfs\./)
    }
  })

  it('neither file schedules deferred work', () => {
    for (const source of [VISIT_STRIPPED, HOOK_STRIPPED]) {
      expect(source).not.toMatch(/setTimeout/)
      expect(source).not.toMatch(/setInterval/)
      expect(source).not.toMatch(/requestAnimationFrame/)
      expect(source).not.toMatch(/InteractionManager/)
    }
  })

  it('neither file writes to the debug console', () => {
    for (const source of [VISIT_STRIPPED, HOOK_STRIPPED]) {
      expect((source.match(/console\s*\./g) ?? []).length).toBe(0)
    }
  })

  it('the pure module is genuinely pure', () => {
    expect(VISIT_STRIPPED).not.toMatch(/^import\b/m)
    expect(VISIT_STRIPPED).not.toMatch(/require\(/)
    expect(VISIT_STRIPPED).not.toMatch(/\bReact\b/)
    expect(VISIT_STRIPPED).not.toMatch(/react-native/)
    expect(VISIT_STRIPPED).not.toMatch(/@votetorrent\//)
  })

  it('the visit boundary is mount/unmount, never focus', () => {
    expect(HOOK_STRIPPED).not.toMatch(/useFocusEffect/)
    expect(HOOK_STRIPPED).not.toMatch(/useIsFocused/)
    expect(HOOK_STRIPPED).not.toMatch(/addListener\(\s*['"]focus/)
    expect(HOOK_STRIPPED).not.toMatch(/addListener\(\s*['"]blur/)
    expect((HOOK_STRIPPED.match(/AppState\.addEventListener/g) ?? []).length).toBe(1)
  })

  it('the hook does not re-implement the accumulator', () => {
    expect(HOOK_STRIPPED).not.toMatch(/new Set\b/)
    expect(HOOK_STRIPPED).toMatch(/createAccessTrailVisit/)
    expect(HOOK_STRIPPED).toMatch(/shouldFlushForAppState/)
  })

  it('no second names-only sanitizer exists on the app side', () => {
    for (const source of [VISIT_STRIPPED, HOOK_STRIPPED]) {
      expect(source).not.toMatch(/sanitize/i)
      expect(source).not.toMatch(/allowlist/i)
      expect(source).not.toMatch(/PrivateDetails/)
    }
  })

  it('neither file describes the trail as a control over access (T-47-03)', () => {
    // Built from fragments rather than the literal phrases so THIS file's
    // own source text can never accidentally satisfy the same negative-
    // claim gate it enforces -- Task 3's acceptance criteria runs the
    // identical grep against every file this plan authors, including this
    // one, so the phrases below must never appear contiguous in source.
    const pattern = new RegExp(
      [
        'prevents' + ' ',
        'blocks' + ' ' + 'access',
        'restricts' + ' ' + 'access',
        'protects' + ' ' + 'access',
        'stops (unauthorized|an officer)'
      ].join('|'),
      'i'
    )
    for (const source of [VISIT_RAW, HOOK_RAW]) {
      expect((source.match(pattern) ?? []).length).toBe(0)
    }
  })

  it('neither file holds a registrant identity, a viewer identity, or an engine handle', () => {
    for (const source of [VISIT_STRIPPED, HOOK_STRIPPED]) {
      expect(source).not.toMatch(/registrantId/)
      expect(source).not.toMatch(/viewerUserId/)
      expect(source).not.toMatch(/getEngine/)
      expect(source).not.toMatch(/IRegistrationEngine/)
    }
  })
})
