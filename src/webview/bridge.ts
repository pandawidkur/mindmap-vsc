import type { TreeNode } from '../core/model';
import type { SyncMessage, WebviewMessage } from '../shared/protocol';

export interface BridgePorts {
  post(message: WebviewMessage): void;
  /** The tree currently on the map, or null before the first render. */
  readTree(): TreeNode | null;
  render(tree: TreeNode): void;
  /** True while a node's inline text box is open; rendering would destroy it. */
  isEditing(): boolean;
}

/** Text and shape of a tree; folding is view state and does not count as a change. */
export function treeSignature(tree: TreeNode | null): string {
  const strip = (node: TreeNode): unknown => [node.id, node.topic, node.children.map(strip)];
  return JSON.stringify(tree && strip(tree));
}

/**
 * The map's half of the sync protocol. At most one edit is in flight; changes made
 * meanwhile collapse into the next edit, sent with the version the answer brings,
 * so a quick succession of edits is not refused as stale.
 */
export class SyncBridge {
  private version = -1;
  private seq = 0;
  private inFlight: number | null = null;
  private dirty = false;
  private deferred: TreeNode | null = null;
  private known = treeSignature(null);

  constructor(private readonly ports: BridgePorts) {}

  receive(message: SyncMessage): void {
    if (this.inFlight !== null && message.ack?.seq !== this.inFlight) {
      // The answer to the edit in flight is coming and will carry the newest state.
      return;
    }
    this.version = message.version;

    if (message.ack) {
      this.inFlight = null;
      const resend = message.ack.applied && this.dirty;
      this.dirty = false;
      if (resend) {
        this.known = treeSignature(message.tree);
        this.send();
        return;
      }
    }
    this.show(message.tree);
  }

  /** Call whenever the map may have changed; no real change means no message. */
  localChange(): void {
    if (treeSignature(this.ports.readTree()) === this.known) {
      return;
    }
    if (this.inFlight !== null) {
      this.dirty = true;
      return;
    }
    this.send();
  }

  /** Call when the inline text box closes, to show what arrived meanwhile. */
  editingEnded(): void {
    if (this.deferred) {
      this.show(this.deferred);
    }
  }

  private send(): void {
    const tree = this.ports.readTree();
    if (!tree) {
      return;
    }
    if (treeSignature(tree) === this.known) {
      return;
    }
    this.deferred = null;
    this.known = treeSignature(tree);
    this.seq += 1;
    this.inFlight = this.seq;
    this.ports.post({ type: 'edit', seq: this.seq, baseVersion: this.version, tree });
  }

  private show(tree: TreeNode): void {
    if (this.ports.isEditing()) {
      this.deferred = tree;
      return;
    }
    this.deferred = null;
    this.known = treeSignature(tree);
    if (this.known !== treeSignature(this.ports.readTree())) {
      this.ports.render(tree);
    }
  }
}
