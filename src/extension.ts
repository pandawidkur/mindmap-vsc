import { randomBytes } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { HistoryAction, MapLayout } from './shared/protocol';
import { SyncSession } from './sync/SyncSession';

type ViewMode = 'panel' | 'editor';

/** Exported for the integration tests, which stand in for the webview. */
export interface ExtensionApi {
  sessionFor(uri: vscode.Uri): SyncSession | undefined;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const sessions = new Map<string, SyncSession>();
  const views = new Map<vscode.WebviewPanel, SyncSession>();
  const panels = new Map<string, vscode.WebviewPanel>();

  const attach = (panel: vscode.WebviewPanel, document: vscode.TextDocument, mode: ViewMode) => {
    const key = document.uri.toString();
    const session = connectSession(panel, document, mode, context.workspaceState);
    sessions.set(key, session);
    views.set(panel, session);
    panel.onDidDispose(() => {
      views.delete(panel);
      if (sessions.get(key) === session) {
        sessions.delete(key);
      }
    });
    panel.webview.options = webviewOptions(context.extensionUri);
    panel.webview.html = renderHtml(panel.webview, context.extensionUri, mode);
  };

  const openBeside = vscode.commands.registerCommand('mindmap.openSplit', () => {
    const document = vscode.window.activeTextEditor?.document;
    if (!document || !isMarkdownDocument(document)) {
      void vscode.window.showWarningMessage('Please open an active Markdown (.md) document first.');
      return;
    }

    const key = document.uri.toString();
    const existing = panels.get(key);
    if (existing) {
      existing.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'mindmapBeside',
      `Mindmap: ${path.basename(document.fileName)}`,
      vscode.ViewColumn.Beside,
      { ...webviewOptions(context.extensionUri), retainContextWhenHidden: true }
    );
    panels.set(key, panel);
    const closeWithDocument = vscode.window.tabGroups.onDidChangeTabs(() => {
      if (!findTabGroup(document.uri)) {
        panel.dispose();
      }
    });
    panel.onDidDispose(() => {
      panels.delete(key);
      closeWithDocument.dispose();
    });
    attach(panel, document, 'panel');
  });

  const toggleLayout = vscode.commands.registerCommand('mindmap.toggleLayout', () => {
    for (const [panel, session] of views) {
      if (panel.active) {
        return session.toggleLayout();
      }
    }
    void vscode.window.showWarningMessage('Please select a mindmap first.');
    return undefined;
  });

  const customEditor = vscode.window.registerCustomEditorProvider(
    'mindmap.editor',
    {
      resolveCustomTextEditor(document, panel) {
        attach(panel, document, 'editor');
      },
    },
    {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }
  );

  context.subscriptions.push(openBeside, toggleLayout, customEditor);
  return { sessionFor: (uri) => sessions.get(uri.toString()) };
}

function isMarkdownDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'markdown' || /\.(md|markdown)$/i.test(document.fileName);
}

function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
  };
}

function findTabGroup(uri: vscode.Uri): vscode.TabGroup | undefined {
  return vscode.window.tabGroups.all.find((group) =>
    group.tabs.some(
      (tab) =>
        tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString()
    )
  );
}

/** Undo commands act on the focused editor, so the document is focused for the call. */
async function runHistoryOnDocument(
  action: HistoryAction,
  document: vscode.TextDocument,
  panel: vscode.WebviewPanel
): Promise<void> {
  await vscode.window.showTextDocument(document, {
    viewColumn: findTabGroup(document.uri)?.viewColumn ?? vscode.ViewColumn.Beside,
    preserveFocus: false,
    preview: false,
  });
  await vscode.commands.executeCommand(action);
  panel.reveal(panel.viewColumn, false);
}

function connectSession(
  panel: vscode.WebviewPanel,
  document: vscode.TextDocument,
  mode: ViewMode,
  state: vscode.Memento
): SyncSession {
  const layoutKey = `mindmap.layout:${document.uri.toString()}`;
  const title = path.basename(document.fileName, path.extname(document.fileName)) || 'Mindmap';
  const session = new SyncSession(
    {
      document: {
        get version() {
          return document.version;
        },
        getText: () => document.getText(),
        applyChange(change) {
          const edit = new vscode.WorkspaceEdit();
          edit.replace(
            document.uri,
            new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)),
            change.text
          );
          return Promise.resolve(vscode.workspace.applyEdit(edit));
        },
      },
      view: {
        post: (message) => void panel.webview.postMessage(message),
      },
      user: {
        async confirmRemoval(sections) {
          const action = 'Delete';
          const noun = sections === 1 ? 'section that contains' : 'sections that contain';
          const choice = await vscode.window.showWarningMessage(
            `Delete ${sections} ${noun} text?`,
            { modal: true, detail: 'You can bring it back with Undo.' },
            action
          );
          return choice === action;
        },
        warn: (message) => void vscode.window.showWarningMessage(message),
      },
      layout: {
        get: () => state.get<MapLayout>(layoutKey, 'side'),
        set: (layout) => void state.update(layoutKey, layout),
      },
      history:
        mode === 'panel' ? (action) => runHistoryOnDocument(action, document, panel) : undefined,
    },
    title
  );

  const messages = panel.webview.onDidReceiveMessage((message) => session.handleMessage(message));
  const changes = vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document.uri.toString() === document.uri.toString()) {
      session.documentChanged();
    }
  });
  panel.onDidDispose(() => {
    session.dispose();
    messages.dispose();
    changes.dispose();
  });
  return session;
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri, mode: ViewMode): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
  const libraryStyleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'mind-elixir.css')
  );
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'style.css'));
  const nonce = randomBytes(16).toString('base64');
  // The map library injects its stylesheet and positions nodes with inline styles.
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${libraryStyleUri}">
  <link rel="stylesheet" href="${styleUri}">
  <title>Mindmap</title>
</head>
<body data-mode="${mode}">
  <div id="map"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

export function deactivate() {}
