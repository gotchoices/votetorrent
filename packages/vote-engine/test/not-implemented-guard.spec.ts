import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { expect } from 'aegir/chai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_PATH = join(__dirname, '..', 'scripts', 'not-implemented-guard.sh');

describe('ENG-07 not-implemented guard', () => {
  it('passes on current src (no non-allowlisted violations)', () => {
    const result = execSync(`bash "${SCRIPT_PATH}"`, {
      cwd: join(__dirname, '..'),
      encoding: 'utf-8',
      env: { ...process.env },
    });
    expect(result).to.include('clean');
  });

  it('detects a non-allowlisted Not implemented throw', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'eng07-test-'));
    writeFileSync(
      join(tmpDir, 'violation.ts'),
      [
        'class FooEngine {',
        '  async fooBar(): Promise<void> {',
        '    throw new Error(\'Not implemented\');',
        '  }',
        '}',
      ].join('\n') + '\n',
    );

    try {
      execSync(`bash "${SCRIPT_PATH}"`, {
        cwd: join(__dirname, '..'),
        encoding: 'utf-8',
        env: { ...process.env, SRC_DIR: tmpDir },
      });
      // If we get here, the script exited 0 — that is a failure
      expect.fail('Expected script to exit with non-zero code');
    } catch (err: any) {
      expect(err.status).to.equal(1);
      const output = (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? '');
      expect(output).to.include('ENG-07 VIOLATION');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // WR-03: a `/* ... Not implemented ... */` block comment is NOT filtered by
  // the line-leading `//` comment filter, so a deferred note inside a block
  // comment is reported as a violation. This pins the deliberate decision that
  // block comments do not silently suppress the guard.
  it('WR-03: flags a Not implemented literal inside a block comment', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'eng07-block-'));
    writeFileSync(
      join(tmpDir, 'block-comment.ts'),
      [
        'class FooEngine {',
        '  /*',
        '   * TODO: Not implemented yet — deferred.',
        '   */',
        '  async fooBar(): Promise<void> {}',
        '}',
      ].join('\n') + '\n',
    );

    try {
      execSync(`bash "${SCRIPT_PATH}"`, {
        cwd: join(__dirname, '..'),
        encoding: 'utf-8',
        env: { ...process.env, SRC_DIR: tmpDir },
      });
      expect.fail('Expected script to flag the block-comment Not implemented');
    } catch (err: any) {
      expect(err.status).to.equal(1);
      const output = (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? '');
      expect(output).to.include('ENG-07 VIOLATION');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // WR-04 (residual, documented): a real violation within 5 lines BELOW an
  // allowlisted async signature is still allowlisted away — the proximity
  // window, not the regex, causes this. Closing it requires nearest-preceding-
  // async resolution (a larger, riskier bash rewrite) and is deferred; this fix
  // addresses the substring false-positive only (see the test below).

  // WR-04: the substring/`.*` looseness is gone — `connectDeviceLater(` must NOT
  // be allowlisted by the `connectDevice` entry. A throw inside connectDeviceLater
  // is therefore reported.
  it('WR-04: does not allowlist a substring-named function (connectDeviceLater)', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'eng07-substr-'));
    writeFileSync(
      join(tmpDir, 'substring.ts'),
      [
        'class UserEngine {',
        '  async connectDeviceLater(deviceId: string): Promise<void> {',
        '    throw new Error(\'Not implemented\');',
        '  }',
        '}',
      ].join('\n') + '\n',
    );

    try {
      execSync(`bash "${SCRIPT_PATH}"`, {
        cwd: join(__dirname, '..'),
        encoding: 'utf-8',
        env: { ...process.env, SRC_DIR: tmpDir },
      });
      expect.fail('Expected script to report the connectDeviceLater violation');
    } catch (err: any) {
      expect(err.status).to.equal(1);
      const output = (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? '');
      expect(output).to.include('ENG-07 VIOLATION');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('allows allowlisted throws and FeatureNotAvailableError', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'eng07-allow-'));

    // File 1: allowlisted function with raw 'Not implemented' throw (legacy pattern)
    writeFileSync(
      join(tmpDir, 'allowlisted.ts'),
      [
        'class UserEngine {',
        '  async connectDevice(deviceId: string): Promise<void> {',
        '    throw new Error(\'Not implemented\');',
        '  }',
        '}',
      ].join('\n') + '\n',
    );

    // File 2: FeatureNotAvailableError usage — the literal 'Not implemented' does NOT appear here
    writeFileSync(
      join(tmpDir, 'typed-error.ts'),
      [
        'export class FeatureNotAvailableError extends Error {',
        '  constructor(message: string) { super(message); this.name = \'FeatureNotAvailableError\'; }',
        '}',
        'class AnotherEngine {',
        '  async someMethod(): Promise<void> {',
        '    throw new FeatureNotAvailableError(\'someMethod — available in Phase 99\');',
        '  }',
        '}',
      ].join('\n') + '\n',
    );

    try {
      const result = execSync(`bash "${SCRIPT_PATH}"`, {
        cwd: join(__dirname, '..'),
        encoding: 'utf-8',
        env: { ...process.env, SRC_DIR: tmpDir },
      });
      expect(result).to.include('clean');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
