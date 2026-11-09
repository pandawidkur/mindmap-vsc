import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TreeNode } from '../core/model';
import { applyChange, TextChange } from '../core/planEdit';
import { HostMessage, MapLayout, SyncMessage } from '../shared/protocol';
import { SessionPorts, SyncSession } from './SyncSession';

function setup(initial: string) {
  const state = { text: initial, version: 1 };
  const posted: HostMessage[] = [];
  const saved: { layout: MapLayout } = { layout: 'side' };
  const warnings: string[] = [];
  const confirmRemoval = vi.fn(async () => true);
  let session: SyncSession;

  const ports: SessionPorts = {
    document: {
      get version() {
        return state.version;
      },
      getText: () => state.text,
      applyChange: vi.fn(async (change: TextChange) => {
        state.text = applyChange(state.text, change);
        state.version += 1;
        session.documentChanged();
        return true;
      }),
    },
    view: { post: (message) => posted.push(message) },
    user: { confirmRemoval, warn: (message) => warnings.push(message) },
    layout: {
      get: () => saved.layout,
      set: (layout) => {
        saved.layout = layout;
      },
    },
  };
  session = new SyncSession(ports, 'FILE');

  const typeText = (text: string) => {
    state.text = text;
    state.version += 1;
    session.documentChanged();
  };
  const syncs = () => posted.filter((m): m is SyncMessage => m.type === 'sync');
  const last = () => syncs()[syncs().length - 1];
  return { saved, syncs, state, posted, warnings, ports, session, confirmRemoval, typeText, last };
}

function rename(tree: TreeNode, from: string, to: string): TreeNode {
  return {
    ...tree,
    topic: tree.topic === from ? to : tree.topic,
    children: tree.children.map((child) => rename(child, from, to)),
  };
}

describe('SyncSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers ready with the current state', async () => {
    const { session, last } = setup('# R\n\n## A\n');
    await session.handleMessage({ type: 'ready' });
    expect(last().version).toBe(1);
    expect(last().tree.children[0].topic).toBe('A');
    await expect(session.ready).resolves.toBeUndefined();
  });

  it('applies an edit based on the current version and acknowledges it', async () => {
    const { session, state, last } = setup('# R\n\ntext\n\n## A\n');
    await session.handleMessage({ type: 'ready' });
    await session.handleMessage({ type: 'edit', seq: 7, baseVersion: 1, tree: rename(last().tree, 'A', 'B') });
    expect(state.text).toBe('# R\n\ntext\n\n## B\n');
    expect(last().ack).toEqual({ seq: 7, applied: true });
    expect(last().version).toBe(2);
  });

  it('refuses an edit based on an old version and leaves the text alone', async () => {
    const { session, state, last, warnings, typeText } = setup('# R\n\n## A\n');
    await session.handleMessage({ type: 'ready' });
    const stale = rename(last().tree, 'A', 'B');

    typeText('# R\n\n## A\n\nfreshly typed\n');
    await session.handleMessage({ type: 'edit', seq: 1, baseVersion: 1, tree: stale });

    expect(state.text).toBe('# R\n\n## A\n\nfreshly typed\n');
    expect(last().ack).toEqual({ seq: 1, applied: false });
    expect(last().version).toBe(2);
    expect(warnings).toHaveLength(1);
  });

  it('sends text edits to the map after the debounce, keeping ids', async () => {
    const { session, syncs, typeText, last } = setup('# R\n\n## A\n');
    await session.handleMessage({ type: 'ready' });
    const id = last().tree.children[0].id;

    typeText('# R\n\n## Ab\n');
    typeText('# R\n\n## Abc\n');
    expect(syncs()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(200);
    expect(syncs()).toHaveLength(2);
    expect(last().tree.children[0]).toMatchObject({ id, topic: 'Abc' });
  });

  it('does not echo its own edit a second time', async () => {
    const { session, posted, last } = setup('# R\n\n## A\n');
    await session.handleMessage({ type: 'ready' });
    await session.handleMessage({ type: 'edit', seq: 1, baseVersion: 1, tree: rename(last().tree, 'A', 'B') });
    const count = posted.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(posted).toHaveLength(count);
  });

  it('keeps the ids the map chose for new nodes', async () => {
    const { session, last } = setup('# R\n');
    await session.handleMessage({ type: 'ready' });
    const tree = { ...last().tree, children: [{ id: 'from-map', topic: 'New', children: [] }] };
    await session.handleMessage({ type: 'edit', seq: 1, baseVersion: 1, tree });
    expect(last().tree.children[0].id).toBe('from-map');
  });

  it('asks before removing a section that owns text, and honours a refusal', async () => {
    const { session, state, last, confirmRemoval } = setup('# R\n\n## A\n\ntext\n');
    await session.handleMessage({ type: 'ready' });
    confirmRemoval.mockResolvedValueOnce(false);
    await session.handleMessage({ type: 'edit', seq: 1, baseVersion: 1, tree: { ...last().tree, children: [] } });
    expect(confirmRemoval).toHaveBeenCalledWith(1);
    expect(state.text).toBe('# R\n\n## A\n\ntext\n');
    expect(last().ack?.applied).toBe(false);
    expect(last().tree.children).toHaveLength(1);
  });

  it('does not ask when the removed section has no text', async () => {
    const { session, state, last, confirmRemoval } = setup('# R\n\n## A\n');
    await session.handleMessage({ type: 'ready' });
    await session.handleMessage({ type: 'edit', seq: 1, baseVersion: 1, tree: { ...last().tree, children: [] } });
    expect(confirmRemoval).not.toHaveBeenCalled();
    expect(state.text).toBe('# R\n');
  });

  it('rolls back when VS Code refuses the edit', async () => {
    const { session, ports, last, warnings } = setup('# R\n\n## A\n');
    await session.handleMessage({ type: 'ready' });
    vi.mocked(ports.document.applyChange).mockResolvedValueOnce(false);
    await session.handleMessage({ type: 'edit', seq: 1, baseVersion: 1, tree: rename(last().tree, 'A', 'B') });
    expect(last().ack?.applied).toBe(false);
    expect(last().tree.children[0].topic).toBe('A');
    expect(warnings).toHaveLength(1);
  });

  it('explains a rejected plan and restores the map', async () => {
    const { session, last, warnings } = setup('## A\n');
    await session.handleMessage({ type: 'ready' });
    await session.handleMessage({ type: 'edit', seq: 1, baseVersion: 1, tree: { ...last().tree, topic: 'Other' } });
    expect(last().ack?.applied).toBe(false);
    expect(last().tree.topic).toBe('FILE');
    expect(warnings[0]).toContain('file name');
  });

  it('processes messages one at a time', async () => {
    const { session, state, last } = setup('# R\n\n## A\n');
    await session.handleMessage({ type: 'ready' });
    const tree = last().tree;
    await Promise.all([
      session.handleMessage({ type: 'edit', seq: 1, baseVersion: 1, tree: rename(tree, 'A', 'B') }),
      session.handleMessage({ type: 'edit', seq: 2, baseVersion: 1, tree: rename(tree, 'A', 'C') }),
    ]);
    expect(state.text).toBe('# R\n\n## B\n');
    expect(last().ack).toEqual({ seq: 2, applied: false });
  });

  it('ignores malformed messages', async () => {
    const { session, posted, state } = setup('# R\n');
    for (const bad of [
      null,
      'edit',
      { type: 'nope' },
      { type: 'edit', seq: 1, baseVersion: 1 },
      { type: 'edit', seq: 1, baseVersion: 1, tree: { id: 'root', topic: 1 } },
      { type: 'edit', seq: 1, baseVersion: 1, tree: { id: 'root', topic: 'x', children: 'no' } },
      { type: 'history', action: 'format' },
    ]) {
      await session.handleMessage(bad);
    }
    expect(posted).toHaveLength(0);
    expect(state.text).toBe('# R\n');
  });

  it('forwards history requests only when a handler exists', async () => {
    const { session, ports } = setup('# R\n');
    await expect(session.handleMessage({ type: 'history', action: 'undo' })).resolves.toBeUndefined();
    ports.history = vi.fn(async () => {});
    await session.handleMessage({ type: 'history', action: 'redo' });
    expect(ports.history).toHaveBeenCalledWith('redo');
  });

  it('sends the saved layout before the first state', async () => {
    const { session, posted, saved } = setup('# R\n');
    saved.layout = 'down';
    await session.handleMessage({ type: 'ready' });
    expect(posted[0]).toEqual({ type: 'layout', layout: 'down' });
    expect(posted[1].type).toBe('sync');
  });

  it('saves a layout change and leaves the document alone', async () => {
    const { session, posted, saved, state } = setup('# R\n');
    await session.handleMessage({ type: 'setLayout', layout: 'down' });
    expect(saved.layout).toBe('down');
    expect(posted).toEqual([{ type: 'layout', layout: 'down' }]);
    expect(state).toEqual({ text: '# R\n', version: 1 });
  });

  it('toggles between the layouts', async () => {
    const { session, saved } = setup('# R\n');
    await session.toggleLayout();
    expect(saved.layout).toBe('down');
    await session.toggleLayout();
    expect(saved.layout).toBe('side');
  });

  it('ignores an unknown layout', async () => {
    const { session, saved } = setup('# R\n');
    await session.handleMessage({ type: 'setLayout', layout: 'diagonal' });
    expect(saved.layout).toBe('side');
  });

  it('does nothing after dispose', async () => {
    const { session, posted, typeText } = setup('# R\n');
    session.dispose();
    typeText('# S\n');
    await vi.advanceTimersByTimeAsync(500);
    await session.handleMessage({ type: 'ready' });
    expect(posted).toHaveLength(0);
  });
});
