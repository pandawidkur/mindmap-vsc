import MindElixir from 'mind-elixir';
import type { MindElixirData, MindElixirInstance, Operation } from 'mind-elixir';

declare function acquireVsCodeApi(): {
  postMessage: (message: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
};

const vscode = acquireVsCodeApi();

let me: MindElixirInstance | null = null;
let isUpdatingFromExtension = false;

// Canonical Miro Mindmap color palette
const MIRO_PALETTE = [
  '#4262FF', // Royal Blue
  '#7B61FF', // Iris Purple
  '#00C49F', // Mint / Teal
  '#FF7A00', // Amber
  '#FF5630', // Coral Red
  '#FFC700', // Sunflower
];

// Miro Theme Definition
const miroDarkTheme = {
  name: 'Miro-Dark',
  type: 'dark' as const,
  palette: MIRO_PALETTE,
  cssVar: {
    '--main-color': '#ffffff',
    '--main-bgcolor': '#252526',
    '--color': '#cccccc',
    '--bgcolor': '#1e1e1e',
    '--selected': '#4262FF',
    '--root-color': '#ffffff',
    '--root-bgcolor': '#4262FF',
    '--panel-color': '#cccccc',
    '--panel-bgcolor': '#252526',
    '--panel-border-color': '#333333',
  },
};

// UI Overlay Elements
let quickAddBtn: HTMLElement | null = null;
let floatingToolbar: HTMLElement | null = null;
let currentTargetTpc: HTMLElement | null = null;

function createMiroOverlays(_container: HTMLElement) {
  // 1. Quick-Add (+) Button
  quickAddBtn = document.createElement('div');
  quickAddBtn.className = 'miro-quick-add';
  quickAddBtn.innerHTML = '+';
  quickAddBtn.title = 'Add sub-branch (Tab)';
  quickAddBtn.style.display = 'none';
  document.body.appendChild(quickAddBtn);

  quickAddBtn.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    e.preventDefault();
  });

  quickAddBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!currentTargetTpc || !me) return;
    await me.addChild(currentTargetTpc as unknown as import('mind-elixir').Topic);
    hideOverlays();
  });

  // 2. Floating Context Toolbar
  floatingToolbar = document.createElement('div');
  floatingToolbar.className = 'miro-floating-toolbar';
  floatingToolbar.style.display = 'none';

  // Button: Add Child
  const addChildBtn = document.createElement('button');
  addChildBtn.className = 'miro-toolbar-btn';
  addChildBtn.innerHTML = '<span>➕</span> Child';
  addChildBtn.title = 'Add child node (Tab)';
  addChildBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!currentTargetTpc || !me) return;
    await me.addChild(currentTargetTpc as unknown as import('mind-elixir').Topic);
    hideOverlays();
  });

  // Button: Add Sibling
  const addSiblingBtn = document.createElement('button');
  addSiblingBtn.className = 'miro-toolbar-btn';
  addSiblingBtn.innerHTML = '<span>⤵</span> Sibling';
  addSiblingBtn.title = 'Add sibling node (Enter)';
  addSiblingBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!currentTargetTpc || !me) return;
    if (currentTargetTpc.parentElement?.tagName.toLowerCase() === 'me-root') {
      // Cannot add sibling to root
      return;
    }
    await me.insertSibling('after', currentTargetTpc as unknown as import('mind-elixir').Topic);
    hideOverlays();
  });

  // Divider
  const div1 = document.createElement('div');
  div1.className = 'miro-divider';

  // Color Palette Dots
  const colorContainer = document.createElement('div');
  colorContainer.style.display = 'flex';
  colorContainer.style.gap = '5px';
  colorContainer.style.alignItems = 'center';

  MIRO_PALETTE.forEach((color) => {
    const dot = document.createElement('div');
    dot.className = 'miro-color-dot';
    dot.style.backgroundColor = color;
    dot.title = `Color: ${color}`;
    dot.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!currentTargetTpc || !me) return;
      await me.reshapeNode(currentTargetTpc as unknown as import('mind-elixir').Topic, {
        branchColor: color,
      });
      // Fire operation to synchronize
      vscode.postMessage({
        type: 'mindmapChanged',
        data: me.getData(),
      });
    });
    colorContainer.appendChild(dot);
  });

  // Divider
  const div2 = document.createElement('div');
  div2.className = 'miro-divider';

  // Button: Delete
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'miro-toolbar-btn delete';
  deleteBtn.innerHTML = '<span>🗑️</span>';
  deleteBtn.title = 'Delete node (Delete)';
  deleteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!currentTargetTpc || !me) return;
    if (currentTargetTpc.parentElement?.tagName.toLowerCase() === 'me-root') {
      return; // Do not delete root
    }
    await me.removeNode(currentTargetTpc as unknown as import('mind-elixir').Topic);
    hideOverlays();
  });

  floatingToolbar.appendChild(addChildBtn);
  floatingToolbar.appendChild(addSiblingBtn);
  floatingToolbar.appendChild(div1);
  floatingToolbar.appendChild(colorContainer);
  floatingToolbar.appendChild(div2);
  floatingToolbar.appendChild(deleteBtn);

  document.body.appendChild(floatingToolbar);

  // Hide overlays on container scroll / canvas pan
  const mapContainer = document.querySelector('.map-container');
  if (mapContainer) {
    mapContainer.addEventListener('scroll', () => {
      hideOverlays();
    });
  }
}

function positionOverlays(tpc: HTMLElement) {
  if (!quickAddBtn || !floatingToolbar) return;

  currentTargetTpc = tpc;
  const tpcRect = tpc.getBoundingClientRect();
  const isRoot = tpc.parentElement?.tagName.toLowerCase() === 'me-root';
  const isLHS = tpc.closest('.lhs') !== null;

  // Viewport-relative coordinates (position: fixed)
  if (isLHS) {
    quickAddBtn.style.left = `${tpcRect.left - 32}px`;
  } else {
    quickAddBtn.style.left = `${tpcRect.right + 8}px`;
  }
  quickAddBtn.style.top = `${tpcRect.top + tpcRect.height / 2 - 12}px`;
  quickAddBtn.style.display = 'flex';

  const barWidth = 270;
  const barLeft = Math.max(10, tpcRect.left + tpcRect.width / 2 - barWidth / 2);
  const barTop = Math.max(10, tpcRect.top - 46);

  floatingToolbar.style.left = `${barLeft}px`;
  floatingToolbar.style.top = `${barTop}px`;
  floatingToolbar.style.display = 'flex';

  // If root, hide delete and sibling buttons
  const siblingBtn = floatingToolbar.children[1] as HTMLElement;
  const deleteBtn = floatingToolbar.children[5] as HTMLElement;
  if (isRoot) {
    if (siblingBtn) siblingBtn.style.display = 'none';
    if (deleteBtn) deleteBtn.style.display = 'none';
  } else {
    if (siblingBtn) siblingBtn.style.display = 'flex';
    if (deleteBtn) deleteBtn.style.display = 'flex';
  }
}

function hideOverlays() {
  if (quickAddBtn) quickAddBtn.style.display = 'none';
  if (floatingToolbar) floatingToolbar.style.display = 'none';
}

function initMindElixir(data: MindElixirData) {
  const container = document.getElementById('map');
  if (!container) {
    return;
  }

  const ME = MindElixir as unknown as new (options: unknown) => MindElixirInstance;
  const instance: MindElixirInstance = new ME({
    el: container,
    direction: (MindElixir as any).SIDE ?? 2,
    draggable: true,
    editable: true,
    contextMenu: true,
    toolBar: false, // Replace fixed toolbar with Miro floating toolbar
    keypress: true,
    newTopicName: 'New Subtopic',
    allowUndo: false,
    theme: miroDarkTheme,
  });

  me = instance;
  (window as unknown as { mindElixirInstance: MindElixirInstance }).mindElixirInstance = instance;
  instance.init(data);

  // Create Miro Overlays
  createMiroOverlays(container);

  // Hook into selection events
  instance.bus.addListener('selectNode', () => {
    if (instance.currentNode) {
      positionOverlays(instance.currentNode as unknown as HTMLElement);
    }
  });

  instance.bus.addListener('unselectNode', () => {
    hideOverlays();
  });

  // Direct click handling on node elements
  container.addEventListener('click', (e) => {
    const tpc = (e.target as HTMLElement).closest('me-tpc') as HTMLElement | null;
    if (tpc) {
      positionOverlays(tpc);
    } else {
      hideOverlays();
    }
  });

  // Hover detection on nodes for quick-add button
  container.addEventListener('mouseover', (e) => {
    const tpc = (e.target as HTMLElement).closest('me-tpc') as HTMLElement | null;
    if (tpc && !floatingToolbar?.style.display?.includes('flex')) {
      positionOverlays(tpc);
    }
  });

  // Scale and center comfortably
  requestAnimationFrame(() => {
    if (typeof instance.scale === 'function') {
      instance.scale(0.8);
    }
    instance.toCenter();
  });

  instance.bus.addListener('operation', (info: Operation) => {
    if (isUpdatingFromExtension) {
      return;
    }

    const mutatingOps = [
      'finishEdit',
      'addChild',
      'insertSibling',
      'insertParent',
      'removeNode',
      'removeNodes',
      'moveNodeIn',
      'moveNodeAfter',
      'moveNodeBefore',
      'moveUpNode',
      'moveDownNode',
      'reshapeNode',
    ];

    if (mutatingOps.includes(info.name)) {
      if (me) {
        vscode.postMessage({
          type: 'mindmapChanged',
          data: me.getData(),
        });
      }
    }
  });
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message) {
    return;
  }

  if (message.type === 'init') {
    initMindElixir(message.data);
  } else if (message.type === 'update') {
    if (!me) {
      initMindElixir(message.data);
    } else {
      isUpdatingFromExtension = true;
      try {
        me.refresh(message.data);
      } finally {
        setTimeout(() => {
          isUpdatingFromExtension = false;
        }, 50);
      }
    }
  }
});

// Signal readiness to extension host
vscode.postMessage({ type: 'ready' });
