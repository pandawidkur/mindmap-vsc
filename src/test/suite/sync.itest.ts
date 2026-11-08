import * as assert from 'assert';
import { readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TreeNode } from '../../core/model';
import type { ExtensionApi } from '../../extension';
import type { SyncSession } from '../../sync/SyncSession';

const workspaceRoot = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
let fileCounter = 0;

async function waitFor<T>(read: () => T | undefined | false, what: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = read();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function api(): Promise<ExtensionApi> {
  const extension = vscode.extensions.all.find((e) => e.packageJSON.name === 'mindmap-vsc')!;
  return extension.activate() as Promise<ExtensionApi>;
}

function createFile(content: string): vscode.Uri {
  const file = path.join(workspaceRoot(), `doc${++fileCounter}.md`);
  writeFileSync(file, content);
  return vscode.Uri.file(file);
}

async function connected(uri: vscode.Uri): Promise<SyncSession> {
  const extension = await api();
  const session = await waitFor(() => extension.sessionFor(uri), 'the session');
  await session.ready;
  return session;
}

async function openBeside(content: string) {
  const uri = createFile(content);
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand('mindmap.openSplit');
  return { uri, document, session: await connected(uri) };
}

async function openAsEditor(content: string) {
  const uri = createFile(content);
  await vscode.commands.executeCommand('vscode.openWith', uri, 'mindmap.editor');
  const document = await vscode.workspace.openTextDocument(uri);
  return { uri, document, session: await connected(uri) };
}

function renamed(tree: TreeNode, from: string, to: string): TreeNode {
  return {
    ...tree,
    topic: tree.topic === from ? to : tree.topic,
    children: tree.children.map((child) => renamed(child, from, to)),
  };
}

function renameEdit(session: SyncSession, from: string, to: string) {
  const { version, tree } = session.snapshot();
  return session.handleMessage({
    type: 'edit',
    seq: 1000 + version,
    baseVersion: version,
    tree: renamed(tree, from, to),
  });
}

function mapTabs(): number {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputWebview).length;
}

const DOC = '# Root\n\nImportant paragraph.\n\n```bash\n# not a heading\n```\n\n## Alpha\n\nBody.\n';

suite('Mindmap in a real editor', () => {
  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('a Markdown file opens as text unless the map is asked for', async () => {
    const uri = createFile(DOC);
    await vscode.commands.executeCommand('vscode.open', uri);
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(input instanceof vscode.TabInputText);
    assert.strictEqual(mapTabs(), 0);
  });

  test('the webview loads and reports ready, in both modes', async () => {
    const beside = await openBeside(DOC);
    assert.strictEqual(beside.session.snapshot().tree.children[0].topic, 'Alpha');
    const editor = await openAsEditor('# Other\n');
    assert.strictEqual(editor.session.snapshot().tree.topic, 'Other');
  });

  test('a map edit changes only the heading and marks the document dirty', async () => {
    const { document, session } = await openBeside(DOC);
    await renameEdit(session, 'Alpha', 'Beta');
    assert.strictEqual(document.getText(), DOC.replace('## Alpha', '## Beta'));
    assert.strictEqual(document.isDirty, true);
  });

  test('undo and redo work from the side-by-side map', async () => {
    const { document, session } = await openBeside(DOC);
    await renameEdit(session, 'Alpha', 'Beta');
    await session.handleMessage({ type: 'history', action: 'undo' });
    assert.strictEqual(document.getText(), DOC);
    await session.handleMessage({ type: 'history', action: 'redo' });
    assert.strictEqual(document.getText(), DOC.replace('## Alpha', '## Beta'));
  });

  test('history keeps the map open and in front', async () => {
    const { session } = await openBeside(DOC);
    await renameEdit(session, 'Alpha', 'Beta');
    await session.handleMessage({ type: 'history', action: 'undo' });
    await waitFor(
      () => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputWebview,
      'the map to come back to the front'
    );
  });

  test('undo and redo work in the custom editor', async () => {
    const { document, session } = await openAsEditor(DOC);
    await renameEdit(session, 'Alpha', 'Beta');
    assert.strictEqual(document.getText(), DOC.replace('## Alpha', '## Beta'));
    await vscode.commands.executeCommand('undo');
    await waitFor(() => document.getText() === DOC, 'undo in the custom editor');
    await vscode.commands.executeCommand('redo');
    await waitFor(() => document.getText() !== DOC, 'redo in the custom editor');
  });

  test('text typed before a map edit arrives is not overwritten', async () => {
    const { document, session } = await openBeside(DOC);
    const { version, tree } = session.snapshot();

    const typing = new vscode.WorkspaceEdit();
    typing.insert(document.uri, document.positionAt(DOC.length), 'Freshly typed.\n');
    await vscode.workspace.applyEdit(typing);

    await session.handleMessage({
      type: 'edit',
      seq: 1,
      baseVersion: version,
      tree: renamed(tree, 'Alpha', 'Beta'),
    });
    assert.ok(document.getText().endsWith('Freshly typed.\n'));
    assert.ok(document.getText().includes('## Alpha'));
  });

  test('a text edit reaches the map and keeps the node id', async () => {
    const { document, session } = await openBeside(DOC);
    const before = session.snapshot().tree.children[0].id;

    const typing = new vscode.WorkspaceEdit();
    const offset = DOC.indexOf('Alpha') + 'Alpha'.length;
    typing.insert(document.uri, document.positionAt(offset), 'X');
    await vscode.workspace.applyEdit(typing);

    const after = session.snapshot().tree.children[0];
    assert.strictEqual(after.topic, 'AlphaX');
    assert.strictEqual(after.id, before);
  });

  test('CRLF files stay CRLF on disk', async () => {
    const source = '# Root\r\n\r\nText.\r\n\r\n## Alpha\r\n';
    const { uri, document, session } = await openBeside(source);
    assert.strictEqual(document.eol, vscode.EndOfLine.CRLF);
    await renameEdit(session, 'Alpha', 'Beta');
    await document.save();
    assert.strictEqual(readFileSync(uri.fsPath, 'utf8'), source.replace('Alpha', 'Beta'));
  });

  test('autosave writes the edit with all the body text', async () => {
    const config = vscode.workspace.getConfiguration('files');
    await config.update('autoSave', 'afterDelay', vscode.ConfigurationTarget.Global);
    await config.update('autoSaveDelay', 50, vscode.ConfigurationTarget.Global);
    try {
      const { uri, session } = await openBeside(DOC);
      await renameEdit(session, 'Alpha', 'Beta');
      await waitFor(() => readFileSync(uri.fsPath, 'utf8').includes('## Beta'), 'autosave');
      assert.strictEqual(readFileSync(uri.fsPath, 'utf8'), DOC.replace('## Alpha', '## Beta'));
    } finally {
      await config.update('autoSave', undefined, vscode.ConfigurationTarget.Global);
      await config.update('autoSaveDelay', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('the command opens one panel per document', async () => {
    const { document } = await openBeside(DOC);
    assert.strictEqual(mapTabs(), 1);
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    await vscode.commands.executeCommand('mindmap.openSplit');
    assert.strictEqual(mapTabs(), 1);
  });

  test('closing the document closes its panel', async () => {
    const { uri, document } = await openBeside(DOC);
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await waitFor(() => mapTabs() === 0, 'the panel to close');
    const extension = await api();
    assert.strictEqual(extension.sessionFor(uri), undefined);
  });
});
