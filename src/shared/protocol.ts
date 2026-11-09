import type { TreeNode } from '../core/model';

export type HistoryAction = 'undo' | 'redo';

/** How the map is laid out: branches to both sides, or growing downward. */
export type MapLayout = 'side' | 'down';

export type WebviewMessage =
  | { type: 'ready' }
  /** The map changed; `baseVersion` is the document version it was based on. */
  | { type: 'edit'; seq: number; baseVersion: number; tree: TreeNode }
  | { type: 'history'; action: HistoryAction }
  | { type: 'setLayout'; layout: MapLayout };

export interface SyncMessage {
  type: 'sync';
  version: number;
  tree: TreeNode;
  /** Set when this message answers an edit from the map. */
  ack?: { seq: number; applied: boolean };
}

export type HostMessage = SyncMessage | { type: 'layout'; layout: MapLayout };

const MAX_NODES = 50_000;
const MAX_DEPTH = 64;
const MAX_TOPIC_LENGTH = 10_000;

/** Copies a tree from the webview, keeping only known fields; null if malformed. */
function parseTree(raw: unknown): TreeNode | null {
  let count = 0;
  const parse = (value: unknown, depth: number): TreeNode | null => {
    if (typeof value !== 'object' || value === null || depth > MAX_DEPTH || ++count > MAX_NODES) {
      return null;
    }
    const { id, topic, children } = value as Record<string, unknown>;
    if (typeof id !== 'string' || id === '' || typeof topic !== 'string' || topic.length > MAX_TOPIC_LENGTH) {
      return null;
    }
    const list = children ?? [];
    if (!Array.isArray(list)) {
      return null;
    }
    const parsed: TreeNode[] = [];
    for (const child of list) {
      const node = parse(child, depth + 1);
      if (!node) {
        return null;
      }
      parsed.push(node);
    }
    return { id, topic, children: parsed };
  };
  return parse(raw, 0);
}

/** Validates a message from the webview, which the host does not take on trust. */
export function parseWebviewMessage(raw: unknown): WebviewMessage | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const message = raw as Record<string, unknown>;
  switch (message.type) {
    case 'ready':
      return { type: 'ready' };
    case 'history':
      return message.action === 'undo' || message.action === 'redo'
        ? { type: 'history', action: message.action }
        : null;
    case 'setLayout':
      return message.layout === 'side' || message.layout === 'down'
        ? { type: 'setLayout', layout: message.layout }
        : null;
    case 'edit': {
      const tree = parseTree(message.tree);
      return tree && Number.isInteger(message.seq) && Number.isInteger(message.baseVersion)
        ? { type: 'edit', seq: message.seq as number, baseVersion: message.baseVersion as number, tree }
        : null;
    }
    default:
      return null;
  }
}
