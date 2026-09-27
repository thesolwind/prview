import esbuild from 'esbuild';

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  jsx: 'automatic',
  jsxImportSource: 'react',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
  banner: { js: '#!/usr/bin/env node' },
};

if (process.argv.includes('--watch')) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}

if (process.argv.includes('--preview')) {
  await esbuild.build({ ...options, entryPoints: ['src/dev/preview.tsx'], outfile: 'dist/preview.js' });
}
