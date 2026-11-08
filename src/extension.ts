import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { markdownToTree, treeToMarkdown, MindmapData } from './parser/headingTree';

export function activate(context: vscode.ExtensionContext) {
  // Command: Open Mindmap Beside (Automatic Split)
  const openSplitCommand = vscode.commands.registerCommand(
    'mindmap.openSplit',
    async () => {
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor || !isMarkdownDocument(activeEditor.document)) {
        vscode.window.showWarningMessage(
          'Please open an active Markdown (.md) document first.'
        );
        return;
      }

      const document = activeEditor.document;
      const fileName = path.basename(document.fileName);

      const panel = vscode.window.createWebviewPanel(
        'mindmapBeside',
        `Mindmap: ${fileName}`,
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.file(path.join(context.extensionPath, 'dist')),
            vscode.Uri.file(path.join(context.extensionPath, 'src', 'webview')),
          ],
        }
      );

      panel.webview.html = getWebviewContent(
        panel.webview,
        context.extensionUri
      );

      setupSyncBridge(panel, document, context);
    }
  );

  // Register Custom Text Editor Provider ("Open With -> Mindmap Editor")
  const customEditorProvider = vscode.window.registerCustomEditorProvider(
    'mindmap.editor',
    new MindmapCustomEditorProvider(context),
    {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
      supportsMultipleEditorsPerDocument: true,
    }
  );

  context.subscriptions.push(openSplitCommand, customEditorProvider);
}

function isMarkdownDocument(document: vscode.TextDocument): boolean {
  return (
    document.languageId === 'markdown' ||
    document.fileName.endsWith('.md') ||
    document.fileName.endsWith('.markdown')
  );
}

class MindmapCustomEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, 'dist')),
        vscode.Uri.file(path.join(this.context.extensionPath, 'src', 'webview')),
      ],
    };

    webviewPanel.webview.html = getWebviewContent(
      webviewPanel.webview,
      this.context.extensionUri
    );

    setupSyncBridge(webviewPanel, document, this.context);
  }
}

function setupSyncBridge(
  panel: vscode.WebviewPanel,
  document: vscode.TextDocument,
  context: vscode.ExtensionContext
) {
  let isUpdatingFromWebview = false;
  let debounceTimer: NodeJS.Timeout | null = null;
  const defaultTitle = path.basename(
    document.fileName,
    path.extname(document.fileName)
  ) || 'Mindmap';

  // Listen to messages from Webview
  const messageSubscription = panel.webview.onDidReceiveMessage(
    async (message) => {
      if (!message) {
        return;
      }

      if (message.type === 'ready') {
        const text = document.getText();
        const treeData = markdownToTree(text, { defaultTitle });
        panel.webview.postMessage({ type: 'init', data: treeData });
      } else if (message.type === 'mindmapChanged') {
        const treeData = message.data as MindmapData;
        const newMarkdown = treeToMarkdown(treeData);

        if (newMarkdown.trim() !== document.getText().trim()) {
          isUpdatingFromWebview = true;
          try {
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(
              document.positionAt(0),
              document.positionAt(document.getText().length)
            );
            edit.replace(document.uri, fullRange, newMarkdown);
            await vscode.workspace.applyEdit(edit);
          } finally {
            setTimeout(() => {
              isUpdatingFromWebview = false;
            }, 100);
          }
        }
      }
    }
  );

  // Listen to edits in the VS Code Markdown document
  const docSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document.uri.toString() !== document.uri.toString()) {
      return;
    }
    if (isUpdatingFromWebview) {
      return;
    }

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      const text = document.getText();
      const treeData = markdownToTree(text, { defaultTitle });
      panel.webview.postMessage({ type: 'update', data: treeData });
    }, 200);
  });

  panel.onDidDispose(() => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    messageSubscription.dispose();
    docSubscription.dispose();
  });
}

function getWebviewContent(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js')
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'src', 'webview', 'style.css')
  );

  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' 'unsafe-eval'; img-src ${webview.cspSource} data: https:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Mindmap</title>
</head>
<body>
  <div id="map"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export function deactivate() {}
