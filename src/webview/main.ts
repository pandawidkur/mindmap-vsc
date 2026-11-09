import MindElixir from 'mind-elixir';
import type { TreeNode } from '../core/model';
import type { HostMessage, MapLayout, WebviewMessage } from '../shared/protocol';
import { SyncBridge } from './bridge';
import { createOverlays } from './overlays';
import { buildTheme, onThemeChange } from './theme';

declare function acquireVsCodeApi(): { postMessage(message: WebviewMessage): void };

const vscode = acquireVsCodeApi();
/** The side-by-side panel is not tied to the document, so undo must be requested. */
const handlesHistory = document.body.dataset.mode === 'panel';

let me: MindElixir | null = null;
let layout: MapLayout = 'side';
let overlays: { update(): void } | null = null;
/** True while the library draws the map for the first time, which takes a moment. */
let starting = false;
/** The newest state that arrived during that moment. */
let pendingTree: TreeNode | null = null;

interface RawNode {
  id: string;
  topic: string;
  expanded?: boolean;
  /** Which side of the root a top-level branch is on. */
  direction?: 0 | 1;
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

/** Runs a redraw, then selects again the nodes that were selected, if they still exist. */
function keepingSelection(instance: MindElixir, redraw: () => void): void {
  const selected = instance.currentNodes.map((node) => node.nodeObj.id);
  redraw();
  const found = selected.flatMap((id) => {
    try {
      return [instance.findEle(id)];
    } catch {
      // The node is gone, or inside a folded branch.
      return [];
    }
  });
  // Not selectNode: that also pans to the node, and an update must not move the view.
  if (found.length > 0) {
    instance.selectNodes(found);
  }
}

/** Pans just enough to show a node that ended up partly outside the view. */
function reveal(instance: MindElixir, node: HTMLElement): void {
  const margin = 8;
  const box = node.getBoundingClientRect();
  const view = instance.container.getBoundingClientRect();
  const overflow = (start: number, end: number, viewStart: number, viewEnd: number) => {
    if (start < viewStart + margin) {
      return viewStart + margin - start;
    }
    return end > viewEnd - margin ? viewEnd - margin - end : 0;
  };
  const dx = overflow(box.left, box.right, view.left, view.right);
  const dy = overflow(box.top, box.bottom, view.top, view.bottom);
  if (dx !== 0 || dy !== 0) {
    instance.move(dx, dy);
  }
}

function setLayout(next: MapLayout): void {
  layout = next;
  updateLayoutButton();
  if (me && (me.direction === MindElixir.DOWN) !== (next === 'down')) {
    const instance = me;
    keepingSelection(instance, () => (next === 'down' ? instance.initDown() : instance.initSide()));
    overlays?.update();
  }
}

const layoutButton = document.createElement('button');
layoutButton.type = 'button';
layoutButton.className = 'mm-layout';
layoutButton.addEventListener('mousedown', (event) => event.preventDefault());
layoutButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'setLayout', layout: layout === 'side' ? 'down' : 'side' });
});
document.body.append(layoutButton);

function updateLayoutButton(): void {
  const label = layout === 'side' ? 'Top-down layout' : 'Side layout';
  layoutButton.textContent = label;
  layoutButton.setAttribute('aria-label', `Switch to ${label.toLowerCase()}`);
}
updateLayoutButton();

function showTree(instance: MindElixir, tree: TreeNode): void {
  const merged = withCurrentViewState(tree, instance.getData().nodeData as RawNode);
  keepingSelection(instance, () => instance.refresh({ nodeData: merged }));
  overlays?.update();
}

function createMap(tree: TreeNode): void {
  const container = document.getElementById('map');
  if (!container) {
    return;
  }
  const instance = new MindElixir({
    el: container,
    direction: layout === 'down' ? MindElixir.DOWN : MindElixir.SIDE,
    editable: true,
    // Links are not offered, and neither are summaries (see style.css): Markdown cannot store them.
    contextMenu: { focus: false, link: false },
    toolBar: false,
    keypress: true,
    // Dragging the canvas with the left button pans; the right button selects an area.
    mouseSelectionButton: 2,
    newTopicName: 'New node',
    allowUndo: false,
    theme: buildTheme(),
  });
  starting = true;
  void instance.init({ nodeData: withCurrentViewState(tree, null) }).then(() => {
    starting = false;
    me = instance;
    instance.bus.addListener('operation', (operation) => {
      bridge.localChange();
      if (operation.name.startsWith('moveNodes')) {
        // A dropped branch can land outside the view; the library only reveals far-off nodes.
        requestAnimationFrame(() => {
          if (instance.currentNode) {
            reveal(instance, instance.currentNode);
          }
        });
      }
    });
    overlays = createOverlays(instance);
    instance.scale(0.8);
    instance.toCenter();
    if (pendingTree) {
      showTree(instance, pendingTree);
      pendingTree = null;
    }
    setLayout(layout);
  });

  onThemeChange(() => {
    keepingSelection(instance, () => instance.changeTheme(buildTheme(), true));
    overlays?.update();
  });
}

const bridge = new SyncBridge({
  post: (message) => vscode.postMessage(message),
  readTree,
  render(tree) {
    if (me) {
      showTree(me, tree);
    } else if (starting) {
      pendingTree = tree;
    } else {
      createMap(tree);
    }
  },
  isEditing,
});

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  if (event.data?.type === 'sync') {
    bridge.receive(event.data);
  } else if (event.data?.type === 'layout') {
    setLayout(event.data.layout);
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

// Cut deletes a section, and paste would bring back only its heading. Inside the text box
// of a node, cut is ordinary text editing and stays available.
document.addEventListener(
  'cut',
  (event) => {
    if ((event.target as Element | null)?.id !== 'input-box') {
      event.preventDefault();
      event.stopImmediatePropagation();
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
