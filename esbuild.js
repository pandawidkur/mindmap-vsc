const esbuild = require('esbuild');
const fs = require('fs');

const isProduction = process.argv.includes('--production');
const isWatch = process.argv.includes('--watch');

async function build() {
  fs.mkdirSync('dist', { recursive: true });
  fs.copyFileSync('src/webview/style.css', 'dist/style.css');
  const extensionConfig = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    sourcemap: !isProduction,
    minify: isProduction,
  };

  const webviewConfig = {
    entryPoints: ['src/webview/main.ts'],
    bundle: true,
    outfile: 'dist/webview.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: !isProduction,
    minify: isProduction,
  };

  const parserConfig = {
    entryPoints: ['src/parser/headingTree.ts'],
    bundle: true,
    outfile: 'dist/headingTree.js',
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    sourcemap: !isProduction,
  };

  const parserBrowserConfig = {
    entryPoints: ['src/parser/headingTree.ts'],
    bundle: true,
    outfile: 'dist/headingTree.browser.js',
    format: 'iife',
    globalName: 'HeadingTree',
    platform: 'browser',
    target: 'es2022',
    sourcemap: !isProduction,
  };

  if (isWatch) {
    const extCtx = await esbuild.context(extensionConfig);
    const webCtx = await esbuild.context(webviewConfig);
    const parserCtx = await esbuild.context(parserConfig);
    const parserBrowserCtx = await esbuild.context(parserBrowserConfig);
    await Promise.all([extCtx.watch(), webCtx.watch(), parserCtx.watch(), parserBrowserCtx.watch()]);
    console.log('[esbuild] Watching for changes...');
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webviewConfig),
      esbuild.build(parserConfig),
      esbuild.build(parserBrowserConfig),
    ]);
    console.log('[esbuild] Build completed successfully.');
  }
}

build().catch((err) => {
  console.error('[esbuild] Build failed:', err);
  process.exit(1);
});
