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

function initMindElixir(data: MindElixirData) {
  const container = document.getElementById('map');
  if (!container) {
    return;
  }

  const isDark = document.body.classList.contains('vscode-dark');

  const ME = MindElixir as any;
  const instance: MindElixirInstance = new ME({
    el: container,
    direction: ME.SIDE ?? 2,
    draggable: true,
    editable: true,
    contextMenu: true,
    toolBar: true,
    keypress: true,
    newTopicName: 'New Subtopic',
    allowUndo: false, // Undo/redo handled by VS Code text document history
    theme: isDark ? ME.DARK_THEME : ME.THEME,
  });

  me = instance;
  instance.init(data);

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
