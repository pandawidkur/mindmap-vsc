import MindElixir from 'mind-elixir';
import type { MindElixirInstance } from 'mind-elixir';
import type { TreeNode } from '../core/model';
import type { HostMessage, WebviewMessage } from '../shared/protocol';
import { SyncBridge } from './bridge';
import { createOverlays } from './overlays';
import { buildTheme, onThemeChange } from './theme';

declare function acquireVsCodeApi(): { postMessage(message: WebviewMessage): void };

const vscode = acquireVsCodeApi();
/** The side-by-side panel is not tied to the document, so undo must be requested. */
const handlesHistory = document.body.dataset.mode === 'panel';

let me: MindElixirInstance | null = null;
let overlays: { update(): void } | null = null;

interface RawNode {
  id: string;
  topic: string;
  expanded?: boolean;
  /** Which side of the root a top-level branch is on. */
  direction?: number;
  children?: RawNode[];
}

function toTree(node: RawNode): TreeNode {
  return {
    id: node.id,
    topic: node.topic,
    expanded: node.expanded,
    children: (node.children ?? []).map(toTree),
  };
}

function readTree(): TreeNode | null {
  return me ? toTree(me.getData().nodeData as RawNode) : null;
}

function isEditing(): boolean {
  return document.getElementById('input-box') !== null;
}

/**
 * Copies what only the map knows, folding and branch sides, from the nodes on screen.
 * The document stores neither. Without a side, the library would deal the branches out
 * again by their order, so they could jump across the root on any text edit.
 */
function withCurrentViewState(tree: TreeNode, current: RawNode | null): RawNode {
  const onScreen = new Map<string, RawNode>();
  const record = (node: RawNode) => {
    onScreen.set(node.id, node);
    node.children?.forEach(record);
  };
  if (current) {
    record(current);
  }
  const apply = (node: TreeNode): RawNode => {
    const previous = onScreen.get(node.id);
    const merged: RawNode = {
      ...node,
      expanded: previous ? previous.expanded : true,
      children: node.children.map(apply),
    };
    if (previous?.direction !== undefined) {
      merged.direction = previous.direction;
    }
    return merged;
  };
  return apply(tree);
}

/** Runs a redraw, then selects again the node that was selected, if it still exists. */
function keepingSelection(instance: MindElixirInstance, redraw: () => void): void {
  const selected = instance.currentNode?.nodeObj.id;
  redraw();
  if (selected === undefined) {
    return;
  }
  try {
    instance.selectNode(instance.findEle(selected));
  } catch {
    instance.unselectNode();
  }
}

function createMap(tree: TreeNode): void {
  const container = document.getElementById('map');
  if (!container) {
    return;
  }
  const instance: MindElixirInstance = new MindElixir({
    el: container,
    direction: MindElixir.SIDE,
    draggable: true,
    editable: true,
    // Links are not offered, and neither are summaries (see style.css): Markdown cannot store them.
    contextMenu: { focus: false, link: false },
    toolBar: false,
    // Cut is switched off: it deletes a section, and paste brings back only its heading.
    keypress: { x: () => {} },
    newTopicName: 'New node',
    allowUndo: false,
    theme: buildTheme(),
  });
  me = instance;
  instance.init({ nodeData: tree });
  overlays = createOverlays(instance);

  instance.bus.addListener('operation', (operation: { name: string }) => {
    bridge.localChange();
    if (operation.name.startsWith('moveNode')) {
      // A dropped branch can land outside the view; the library only reveals on selection.
      requestAnimationFrame(() => {
        instance.currentNode?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
    }
  });
  onThemeChange(() => {
    keepingSelection(instance, () => instance.changeTheme(buildTheme(), true));
    overlays?.update();
  });

  requestAnimationFrame(() => {
    instance.scale(0.8);
    instance.toCenter();
  });
}

const bridge = new SyncBridge({
  post: (message) => vscode.postMessage(message),
  readTree,
  render(tree) {
    if (!me) {
      createMap(tree);
      return;
    }
    const instance = me;
    const merged = withCurrentViewState(tree, instance.getData().nodeData as RawNode);
    keepingSelection(instance, () =>
      instance.refresh({ nodeData: merged as Parameters<typeof instance.init>[0]['nodeData'] })
    );
    overlays?.update();
  },
  isEditing,
});

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  if (event.data?.type === 'sync') {
    bridge.receive(event.data);
  }
});

// `blur` does not bubble but can be captured. The box removes itself in its own blur
// handler, which runs after this one, so the check has to wait a task.
document.addEventListener(
  'blur',
  (event) => {
    if ((event.target as Element | null)?.id === 'input-box') {
      setTimeout(() => {
        bridge.editingEnded();
        overlays?.update();
      });
    }
  },
  true
);

if (handlesHistory) {
  window.addEventListener(
    'keydown',
    (event) => {
      if (isEditing() || !(event.metaKey || event.ctrlKey)) {
        return;
      }
      const key = event.key.toLowerCase();
      const redo = (key === 'z' && event.shiftKey) || key === 'y';
      if (key === 'z' || redo) {
        event.preventDefault();
        event.stopPropagation();
        vscode.postMessage({ type: 'history', action: redo ? 'redo' : 'undo' });
      }
    },
    true
  );
}

vscode.postMessage({ type: 'ready' });
