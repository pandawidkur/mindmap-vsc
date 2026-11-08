import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
  const workspace = mkdtempSync(path.join(tmpdir(), 'mindmap-itest-'));
  await runTests({
    version: process.env.VSCODE_TEST_VERSION,
    extensionDevelopmentPath: path.resolve(__dirname, '../..'),
    extensionTestsPath: path.resolve(__dirname, 'suite/index.js'),
    launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust'],
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
