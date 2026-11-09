import type MindElixir from 'mind-elixir';

function button(className: string, label: string, title: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = label;
  element.title = title;
  element.setAttribute('aria-label', title);
  // Keep focus and selection on the map when a button is pressed.
  element.addEventListener('mousedown', (event) => event.preventDefault());
  element.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return element;
}

function isEditing(): boolean {
  return document.getElementById('input-box') !== null;
}

/**
 * Toolbar and quick-add button of the selected node. They always act on the map's
 * current selection and hold no node of their own, so they cannot go stale.
 */
export function createOverlays(me: MindElixir): { update(): void } {
  const isRoot = () => me.currentNode?.parentElement?.classList.contains('me-root') ?? false;

  const quickAdd = button('mm-quick-add', '+', 'Add child (Tab)', () => void me.addChild());
  const toolbar = document.createElement('div');
  toolbar.className = 'mm-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  const addChild = button('mm-toolbar-btn', 'Child', 'Add child (Tab)', () => void me.addChild());
  const addSibling = button('mm-toolbar-btn', 'Sibling', 'Add sibling (Enter)', () => void me.insertSibling('after'));
  const remove = button('mm-toolbar-btn mm-danger', 'Delete', 'Delete node (Delete)', () => void me.removeNodes(me.currentNodes));
  toolbar.append(addChild, addSibling, remove);
  document.body.append(quickAdd, toolbar);

  const hide = () => {
    quickAdd.style.display = 'none';
    toolbar.style.display = 'none';
  };

  const update = () => {
    const node = me.currentNode;
    if (!node || !node.isConnected || isEditing()) {
      hide();
      return;
    }
    const rect = node.getBoundingClientRect();
    const onLeft = node.closest('.lhs') !== null;

    // The button sits where the new child will appear.
    quickAdd.style.display = 'flex';
    if (node.closest('.down')) {
      quickAdd.style.left = `${rect.left + rect.width / 2 - 12}px`;
      quickAdd.style.top = `${rect.bottom + 8}px`;
    } else {
      quickAdd.style.left = `${onLeft ? rect.left - 32 : rect.right + 8}px`;
      quickAdd.style.top = `${rect.top + rect.height / 2 - 12}px`;
    }

    addSibling.style.display = isRoot() ? 'none' : '';
    remove.style.display = isRoot() ? 'none' : '';
    toolbar.style.display = 'flex';
    const width = toolbar.offsetWidth;
    const maxLeft = Math.max(10, window.innerWidth - width - 10);
    toolbar.style.left = `${Math.min(maxLeft, Math.max(10, rect.left + rect.width / 2 - width / 2))}px`;
    toolbar.style.top = `${Math.max(10, rect.top - 46)}px`;
  };

  const updateNextFrame = () => requestAnimationFrame(update);
  const { bus } = me;
  bus.addListener('selectNodes', updateNextFrame);
  bus.addListener('unselectNodes', updateNextFrame);
  bus.addListener('selectNewNode', updateNextFrame);
  bus.addListener('operation', updateNextFrame);
  bus.addListener('move', update);
  bus.addListener('scale', updateNextFrame);
  bus.addListener('changeDirection', updateNextFrame);

  // The map pans and zooms with a CSS transform, which can animate.
  me.map.addEventListener('transitionend', update);
  window.addEventListener('keyup', updateNextFrame);
  window.addEventListener('mouseup', updateNextFrame);
  window.addEventListener('resize', updateNextFrame);

  hide();
  return { update };
}
