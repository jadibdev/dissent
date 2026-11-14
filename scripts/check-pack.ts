/**
 * Package tarball contents check (spec Phase 6, test 6.2).
 *
 * Verifies `pnpm pack --dry-run` emits only `dist/`, `README.md`, `LICENSE`,
 * and `package.json`, with no internal or dev-only directories.
 */
import { execFileSync } from 'node:child_process';

const ALLOWED_EXACT = new Set(['LICENSE', 'README.md', 'package.json']);
const ALLOWED_PREFIX = 'dist/';

function parsePackFiles(output: string): string[] {
  const lines = output.split(/\r?\n/).map(line => line.trim());
  const start = lines.indexOf('Tarball Contents');
  const end = lines.indexOf('Tarball Details');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Unexpected pnpm pack --dry-run output:\n${output}`);
  }
  return lines.slice(start + 1, end).filter(Boolean);
}

function main(): void {
  const cmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const raw = execFileSync(cmd, ['pack', '--dry-run'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const files = parsePackFiles(raw);

  const unexpected = files.filter(
    file => !ALLOWED_EXACT.has(file) && !file.startsWith(ALLOWED_PREFIX),
  );
  const missing = ['dist/index.js', 'dist/index.d.ts', ...ALLOWED_EXACT].filter(
    req => !files.includes(req),
  );

  if (unexpected.length > 0 || missing.length > 0) {
    console.error('Pack contents check FAILED:');
    if (unexpected.length > 0) console.error('  Unexpected files:', unexpected);
    if (missing.length > 0) console.error('  Missing required files:', missing);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Pack contents check passed (${files.length} files): ${files.join(', ')}`,
  );
}

main();
