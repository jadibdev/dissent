/**
 * Edge-runtime import check (spec Phase 6, test 6.1 / invariant I16).
 *
 * Bundles Layer B (`canonical/`, `compare/`, `findings.ts`) and Layer C
 * (`adjudicate.ts`, `receipt.ts`, `render/`) with `platform: 'neutral'` via
 * Rolldown and asserts zero external packages, zero `node:` built-ins, and zero
 * runtime `'ai'` imports.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { Rolldown } from 'tsdown';

function collectNonTestTsFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectNonTestTsFiles(full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test-d.ts')
    ) {
      files.push(full);
    }
  }
  return files;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const entryFiles = [
    ...collectNonTestTsFiles(path.join(root, 'src', 'canonical')),
    ...collectNonTestTsFiles(path.join(root, 'src', 'compare')),
    ...collectNonTestTsFiles(path.join(root, 'src', 'render')),
    path.join(root, 'src', 'findings.ts'),
    path.join(root, 'src', 'adjudicate.ts'),
    path.join(root, 'src', 'receipt.ts'),
    // oxlint-disable-next-line unicorn/no-array-sort -- fresh array; toSorted needs ES2023 lib.
  ].sort();

  const forbiddenExternal: string[] = [];
  const warnings: string[] = [];

  const bundle = await Rolldown.rolldown({
    input: entryFiles,
    platform: 'neutral',
    external(id) {
      if (id.startsWith('.') || path.isAbsolute(id)) {
        return false;
      }
      forbiddenExternal.push(id);
      return true;
    },
    onwarn(warning, defaultHandler) {
      if (warning.code === 'UNRESOLVED_IMPORT') {
        warnings.push(
          `${warning.code}: ${warning.exporter ?? warning.message}`,
        );
      } else {
        defaultHandler(warning);
      }
    },
  });

  const { output } = await bundle.generate({ format: 'esm' });
  await bundle.close();

  const chunkFileNames = new Set(
    output.filter(item => item.type === 'chunk').map(item => item.fileName),
  );
  const chunkImports: string[] = [];
  for (const item of output) {
    if (item.type !== 'chunk') continue;
    for (const imp of item.imports) {
      if (
        !chunkFileNames.has(imp) &&
        !imp.startsWith('./') &&
        !imp.startsWith('../')
      ) {
        chunkImports.push(`${item.fileName} -> ${imp}`);
      }
    }
    for (const dyn of item.dynamicImports) {
      if (
        !chunkFileNames.has(dyn) &&
        !dyn.startsWith('./') &&
        !dyn.startsWith('../')
      ) {
        chunkImports.push(`${item.fileName} -> dynamic(${dyn})`);
      }
    }
  }

  if (
    forbiddenExternal.length > 0 ||
    warnings.length > 0 ||
    chunkImports.length > 0
  ) {
    console.error('Edge import check FAILED:');
    if (forbiddenExternal.length > 0) {
      console.error('  External imports:', [...new Set(forbiddenExternal)]);
    }
    if (warnings.length > 0) {
      console.error('  Unresolved warnings:', warnings);
    }
    if (chunkImports.length > 0) {
      console.error('  Non-relative chunk imports:', chunkImports);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Edge import check passed: ${entryFiles.length} Layer B/C entry modules bundled with 0 external or node: imports.`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
