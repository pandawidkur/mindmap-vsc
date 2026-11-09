import { beforeEach, describe, expect, it } from 'vitest';
import type { TreeNode } from '../core/model';
import type { SyncMessage, WebviewMessage } from '../shared/protocol';
import { SyncBridge } from './bridge';

const tree = (topic: string): TreeNode => ({
  id: 'root',
  topic: 'R',
  children: [{ id: 'a', topic, children: [] }],
});

const sync = (version: number, t: TreeNode, ack?: SyncMessage['ack']): SyncMessage => ({
  type: 'sync',
  version,
  tree: t,
  ack,
});

describe('SyncBridge', () => {
  let current: TreeNode | null;
  let posted: WebviewMessage[];
  let renders: TreeNode[];
  let editing: boolean;
  let bridge: SyncBridge;

  beforeEach(() => {
    current = null;
    posted = [];
    renders = [];
    editing = false;
    bridge = new SyncBridge({
      post: (message) => posted.push(message),
      readTree: () => current,
      render: (t) => {
        renders.push(t);
        current = t;
      },
      isEditing: () => editing,
    });
    bridge.receive(sync(1, tree('A')));
  });

  const lastEdit = () => posted[posted.length - 1] as Extract<WebviewMessage, { type: 'edit' }>;

  it('renders the first state', () => {
    expect(renders).toHaveLength(1);
  });

  it('sends a real change with the version it is based on', () => {
    current = tree('B');
    bridge.localChange();
    expect(lastEdit()).toMatchObject({ type: 'edit', baseVersion: 1, seq: 1 });
  });

  it('stays quiet when nothing changed, even if folding did', () => {
    current = { ...tree('A'), expanded: false };
    bridge.localChange();
    expect(posted).toHaveLength(0);
  });

  it('does not re-render the answer to its own edit', () => {
    current = tree('B');
    bridge.localChange();
    bridge.receive(sync(2, tree('B'), { seq: 1, applied: true }));
    expect(renders).toHaveLength(1);
  });

  it('renders when the host normalized the edit', () => {
    current = tree('B #');
    bridge.localChange();
    bridge.receive(sync(2, tree('B \\#'), { seq: 1, applied: true }));
    expect(renders).toHaveLength(2);
  });

  it('collapses changes during an edit in flight and rebases them', () => {
    current = tree('B');
    bridge.localChange();
    current = tree('C');
    bridge.localChange();
    current = tree('D');
    bridge.localChange();
    expect(posted).toHaveLength(1);

    bridge.receive(sync(2, tree('B'), { seq: 1, applied: true }));
    expect(posted).toHaveLength(2);
    expect(lastEdit()).toMatchObject({ baseVersion: 2, seq: 2 });
    expect(lastEdit().tree.children[0].topic).toBe('D');
    expect(renders).toHaveLength(1);
  });

  it('drops queued changes and shows the document when an edit is refused', () => {
    current = tree('B');
    bridge.localChange();
    current = tree('C');
    bridge.localChange();
    bridge.receive(sync(5, tree('Typed'), { seq: 1, applied: false }));
    expect(posted).toHaveLength(1);
    expect(renders[renders.length - 1].children[0].topic).toBe('Typed');
    current = tree('Next');
    bridge.localChange();
    expect(lastEdit().baseVersion).toBe(5);
  });

  it('ignores other updates while an edit is in flight', () => {
    current = tree('B');
    bridge.localChange();
    bridge.receive(sync(9, tree('Other')));
    expect(renders).toHaveLength(1);
    expect(lastEdit().baseVersion).toBe(1);
  });

  it('waits for the text box to close before rendering', () => {
    editing = true;
    bridge.receive(sync(2, tree('Typed')));
    expect(renders).toHaveLength(1);
    editing = false;
    bridge.editingEnded();
    expect(renders).toHaveLength(2);
  });

  it('uses the newest version even when rendering is deferred', () => {
    editing = true;
    bridge.receive(sync(2, tree('Typed')));
    current = tree('Renamed');
    editing = false;
    bridge.localChange();
    expect(lastEdit().baseVersion).toBe(2);
    bridge.editingEnded();
    expect(renders).toHaveLength(1);
  });
});
