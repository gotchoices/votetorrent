import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { expect } from 'aegir/chai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_PATH = join(__dirname, '..', 'scripts', 'ci-grep-guard.sh');

describe('CI grep guard', () => {
  it('passes on current builder directories (no violations)', () => {
    const result = execSync(`bash "${SCRIPT_PATH}"`, {
      cwd: join(__dirname, '..'),
      encoding: 'utf-8',
      env: { ...process.env },
    });
    expect(result).to.include('clean');
  });

  it('detects colon-prefix bind key violations', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'guard-test-'));
    const buildersDir = join(tmpDir, 'builders');
    mkdirSync(buildersDir, { recursive: true });
    writeFileSync(
      join(buildersDir, 'violation.ts'),
      `const params = { ':userId': user.id, ':networkId': net.id };\n`,
    );

    try {
      execSync(`bash "${SCRIPT_PATH}"`, {
        cwd: join(__dirname, '..'),
        encoding: 'utf-8',
        env: { ...process.env, BUILDERS_DIR: buildersDir },
      });
      // If we get here, the script exited 0 -- that is a failure
      expect.fail('Expected script to exit with non-zero code');
    } catch (err: any) {
      expect(err.status).to.equal(1);
      expect(err.stdout?.toString() || err.stderr?.toString()).to.include('PITFALL 3');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('ignores safe patterns (comments, URLs, TypeScript types, known properties)', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'guard-safe-'));
    const buildersDir = join(tmpDir, 'builders');
    mkdirSync(buildersDir, { recursive: true });
    writeFileSync(
      join(buildersDir, 'safe.ts'),
      [
        '// This is a comment with :something in it',
        'const url = "https://example.com";',
        'interface Foo extends Bar {}',
        'type MyType = { kind: "test" };',
        'import { something } from "somewhere";',
        'export { something };',
        'const x = { version: 1, code: "abc", path: "/test", message: "hello" };',
        'readonly name: string;',
      ].join('\n') + '\n',
    );

    try {
      const result = execSync(`bash "${SCRIPT_PATH}"`, {
        cwd: join(__dirname, '..'),
        encoding: 'utf-8',
        env: { ...process.env, BUILDERS_DIR: buildersDir },
      });
      expect(result).to.include('clean');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
