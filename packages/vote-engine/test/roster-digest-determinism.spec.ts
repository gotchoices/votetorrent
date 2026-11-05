import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { expect } from 'aegir/chai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const AUTHORITY_ENGINE_PATH = join(
  __dirname,
  '..',
  'src',
  'authority',
  'authority-engine.ts',
);

/**
 * roster-digest determinism (CR-02): a non-inert guard against locale-sensitive
 * comparison primitives creeping back into authority-engine.ts's digest-input
 * serialization path (57-12).
 *
 * The banned-identifier list below is assembled at RUNTIME from string
 * fragments so that THIS FILE'S OWN SOURCE TEXT never contains any banned
 * identifier as a contiguous literal. Phase 53 recorded three separate
 * recurrences of a checker that stayed permanently green because its own
 * comment quoted the exact pattern it grepped for -- building the list from
 * fragments means this scanner is safe to point at itself.
 */

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function buildBannedIdentifiers(): string[] {
  const locale = 'locale';
  const Compare = 'Compare';
  const to = 'to';
  const Locale = 'Locale';
  const Upper = 'Upper';
  const Lower = 'Lower';
  const Case = 'Case';
  const Str = 'String';
  const Intl = 'Intl';
  const dot = '.';
  return [
    locale + Compare,
    to + Locale + Upper + Case,
    to + Locale + Lower + Case,
    to + Locale + Str,
    Intl + dot,
  ];
}

const BANNED_IDENTIFIERS = buildBannedIdentifiers();

function findBannedIdentifiers(strippedSource: string): string[] {
  return BANNED_IDENTIFIERS.filter((id) => strippedSource.includes(id));
}

describe('roster-digest determinism (CR-02)', () => {
  it('authority-engine.ts contains no locale-sensitive comparison primitive in executable source', () => {
    const source = readFileSync(AUTHORITY_ENGINE_PATH, 'utf-8');
    const stripped = stripComments(source);
    const found = findBannedIdentifiers(stripped);
    expect(
      found,
      `found banned locale-sensitive identifiers in authority-engine.ts: ${found.join(', ')}`,
    ).to.have.length(0);
  });

  it('the scan is not inert: it detects a planted primitive', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'roster-digest-guard-'));
    const plantedFile = join(tmpDir, 'planted.ts');
    // Assembled at runtime by buildBannedIdentifiers() above -- never a
    // contiguous literal in this file's own source text.
    const planted = BANNED_IDENTIFIERS[0]!;
    try {
      writeFileSync(
        plantedFile,
        `const ordered = a.proposedName.${planted}(b.proposedName);\n`,
      );
      const source = readFileSync(plantedFile, 'utf-8');
      const stripped = stripComments(source);
      const found = findBannedIdentifiers(stripped);
      expect(found).to.deep.equal([planted]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('the scan ignores a primitive that appears only inside a comment', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'roster-digest-guard-comment-'));
    const plantedFile = join(tmpDir, 'commented.ts');
    const planted = BANNED_IDENTIFIERS[0]!;
    try {
      const body =
        [
          `// this file only mentions ${planted} inside a comment, never executable code`,
          `/* a block comment also mentions ${planted} here */`,
          `const ordered = a.proposedName < b.proposedName ? -1 : 1;`,
        ].join('\n') + '\n';
      writeFileSync(plantedFile, body);
      const source = readFileSync(plantedFile, 'utf-8');
      const stripped = stripComments(source);
      const found = findBannedIdentifiers(stripped);
      expect(found).to.have.length(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
