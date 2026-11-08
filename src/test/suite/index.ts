import * as path from 'path';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 30_000 });
  mocha.addFile(path.resolve(__dirname, 'sync.itest.js'));
  return new Promise((resolve, reject) => {
    mocha.run((failures) =>
      failures > 0 ? reject(new Error(`${failures} integration tests failed.`)) : resolve()
    );
  });
}
