# Mindmap Markdown (`mindmap-vsc`)

Visual mindmap editor extension for VS Code with real-time bidirectional Markdown heading synchronization. Reverse of Markmap: create and restructure mindmaps visually while your structured Markdown outline generates live beside the canvas.

## Features

- **Live Bidirectional Synchronization**: Edits on the mindmap update the `.md` text buffer immediately; edits in the `.md` text editor refresh the mindmap without layout jitter.
- **Side-by-Side Split Workspace**: One click or keybinding automatically splits the editor into two panes: interactive mindmap on the side, pure Markdown on the other.
- **Custom Editor Support**: Right-click any `.md` file in the VS Code file explorer and select `Open With... -> Mindmap Editor`.
- **Pure Heading Skeleton Architecture**: Map node depths strictly to Markdown headings (`#`, `##`, `###`, `####`, etc.) for deterministic 1:1 round-trip idempotency.
- **Native Undo/Redo & Dirty State**: Mindmap modifications apply standard `vscode.WorkspaceEdit` operations into the document buffer, preserving native `Cmd+Z` / `Ctrl+Z` history and file save status.
- **Adaptive VS Code Theming**: Automatically adapts colors and nodes to Dark, Light, and High Contrast themes using VS Code CSS variables.
- **Keyboard-Driven Mindmapping**:
  - `Tab`: Add child sub-branch
  - `Enter`: Add sibling branch
  - `Delete` / `Backspace`: Remove selected branch
  - `Drag & Drop`: Reorganize hierarchy and branch order
  - `Scroll / Drag Canvas`: Infinite pan & zoom

## Shortcuts

- `Cmd+Alt+M` (macOS) / `Ctrl+Alt+M` (Windows/Linux): Open Mindmap Beside active Markdown document.
- Icon on editor tab bar: Click the hierarchy icon on the top right of any `.md` editor.

## Development & Testing

1. Install dependencies:
   ```bash
   npm install
   ```
2. Build extension and webview:
   ```bash
   npm run build
   ```
3. Run unit tests:
   ```bash
   npm test
   ```
4. Debug in VS Code:
   Press `F5` to start the **Extension Development Host**. Open any `.md` file and click **Open Mindmap Beside** (`Cmd+Alt+M`).
