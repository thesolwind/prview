import esbuild from 'esbuild';
import { spawn } from 'node:child_process';

await esbuild.build({
  entryPoints: ['test/parse.test.ts', 'test/view.test.ts', 'test/base.test.ts', 'test/explain.test.ts', 'test/annotate.test.ts', 'test/anchor.test.ts'],
  outdir: 'dist/test',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  jsx: 'automatic',
  jsxImportSource: 'react',
  packages: 'external',
  logLevel: 'warning',
});

const child = spawn(
  process.execPath,
  [
    '--test',
    'dist/test/parse.test.js',
    'dist/test/view.test.js',
    'dist/test/base.test.js',
    'dist/test/explain.test.js',
    'dist/test/annotate.test.js',
    'dist/test/anchor.test.js',
    'dist/test/theme.test.js',
  ],
  { stdio: 'inherit' },
);
child.on('close', (code) => process.exit(code ?? 1));
