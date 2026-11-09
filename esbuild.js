const esbuild = require('esbuild');
const fs = require('fs');

const isProduction = process.argv.includes('--production');
const isWatch = process.argv.includes('--watch');
const withTests = process.argv.includes('--tests');

async function build() {
  fs.mkdirSync('dist', { recursive: true });
  fs.copyFileSync('src/webview/style.css', 'dist/style.css');

  const configs = [
    {
      entryPoints: ['src/extension.ts'],
      bundle: true,
      outfile: 'dist/extension.js',
      external: ['vscode'],
      format: 'cjs',
      platform: 'node',
      target: 'node18',
      sourcemap: !isProduction,
      minify: isProduction,
    },
    {
      entryPoints: ['src/webview/main.ts'],
      bundle: true,
      outfile: 'dist/webview.js',
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      sourcemap: !isProduction,
      minify: isProduction,
    },
  ];

  if (withTests) {
    configs.push({
      entryPoints: ['src/test/runTest.ts', 'src/test/suite/index.ts', 'src/test/suite/sync.itest.ts'],
      bundle: true,
      outdir: 'out/test',
      outbase: 'src/test',
      packages: 'external',
      format: 'cjs',
      platform: 'node',
      target: 'node18',
      sourcemap: true,
    });
    configs.push({
      entryPoints: ['src/test/webview/host.ts'],
      bundle: true,
      outfile: 'out/test/webview/host.js',
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
    });
  }

  if (isWatch) {
    const contexts = await Promise.all(configs.map((config) => esbuild.context(config)));
    await Promise.all(contexts.map((context) => context.watch()));
    console.log('[esbuild] Watching for changes...');
  } else {
    await Promise.all(configs.map((config) => esbuild.build(config)));
    console.log('[esbuild] Build completed successfully.');
  }
}

build().catch((err) => {
  console.error('[esbuild] Build failed:', err);
  process.exit(1);
});
