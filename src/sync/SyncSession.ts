import { createModel, DocumentModel, modelToTree, TreeNode } from '../core/model';
import { planTreeEdit, RejectionReason, TextChange } from '../core/planEdit';
import {
  HistoryAction,
  HostMessage,
  MapLayout,
  parseWebviewMessage,
  WebviewMessage,
} from '../shared/protocol';

const TEXT_EDIT_DEBOUNCE_MS = 200;

export interface SessionPorts {
  document: {
    readonly version: number;
    getText(): string;
    applyChange(change: TextChange): Promise<boolean>;
  };
  view: { post(message: HostMessage): void };
  user: {
    confirmRemoval(sections: number): Promise<boolean>;
    warn(message: string): void;
  };
  /** The saved layout, kept outside the document so its text stays clean. */
  layout: {
    get(): MapLayout;
    set(layout: MapLayout): void;
  };
  /** Runs undo or redo on the document; absent when VS Code routes those natively. */
  history?: (action: HistoryAction) => Promise<void>;
}

const REJECTION_MESSAGES: Record<RejectionReason, string> = {
  'invalid-tree': 'The map sent an invalid structure, so the edit was not applied.',
  'synthetic-root-rename':
    'This title comes from the file name, because the document has no single top heading.',
  'depth-limit': 'Markdown headings stop at level 6, so this node cannot go deeper.',
  'verification-failed':
    'This edit would change the document structure in an unexpected way, so it was not applied.',
};

const STALE_MESSAGE = 'The document changed while you edited the map, so that edit was not applied.';
const APPLY_FAILED_MESSAGE = 'VS Code could not apply the edit to the document.';

/**
 * Keeps one map view and one document consistent. The document version decides
 * what is current: a map edit based on an older version is refused, never merged,
 * and the map is told the actual state in reply.
 */
export class SyncSession {
  private model: DocumentModel;
  private sentVersion = -1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private markReady!: () => void;
  /** Resolves once the webview has loaded and received its first state. */
  readonly ready = new Promise<void>((resolve) => {
    this.markReady = resolve;
  });

  constructor(
    private readonly ports: SessionPorts,
    private readonly title: string
  ) {
    this.model = createModel(ports.document.getText(), title);
  }

  /** Handles a raw message from the webview; malformed ones are dropped. */
  handleMessage(raw: unknown): Promise<void> {
    const message = parseWebviewMessage(raw);
    return message ? this.enqueue(() => this.dispatch(message)) : Promise.resolve();
  }

  /** Call on every change of the document, whoever made it. */
  documentChanged(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.enqueue(async () => {
        if (this.ports.document.version !== this.sentVersion) {
          this.post();
        }
      });
    }, TEXT_EDIT_DEBOUNCE_MS);
  }

  get layout(): MapLayout {
    return this.ports.layout.get();
  }

  /** Switches between the two layouts, as the map's own button does. */
  toggleLayout(): Promise<void> {
    const next = this.ports.layout.get() === 'side' ? 'down' : 'side';
    return this.handleMessage({ type: 'setLayout', layout: next });
  }

  /** The state last derived from the document. */
  snapshot(): { version: number; tree: TreeNode } {
    this.refreshModel();
    return { version: this.ports.document.version, tree: modelToTree(this.model) };
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(() => (this.disposed ? undefined : task()));
    return this.queue;
  }

  private async dispatch(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.ports.view.post({ type: 'layout', layout: this.ports.layout.get() });
        this.post();
        this.markReady();
        return;
      case 'setLayout':
        this.ports.layout.set(message.layout);
        this.ports.view.post({ type: 'layout', layout: message.layout });
        return;
      case 'history':
        await this.ports.history?.(message.action);
        return;
      case 'edit':
        this.post({ seq: message.seq, applied: await this.applyEdit(message.baseVersion, message.tree) });
        return;
    }
  }

  private async applyEdit(baseVersion: number, tree: TreeNode): Promise<boolean> {
    const { document, user } = this.ports;
    if (baseVersion !== document.version) {
      user.warn(STALE_MESSAGE);
      return false;
    }

    this.refreshModel();
    const plan = planTreeEdit(this.model, tree);
    if (plan.kind === 'noop') {
      return true;
    }
    if (plan.kind === 'rejected') {
      user.warn(REJECTION_MESSAGES[plan.reason]);
      return false;
    }

    if (plan.removedWithBody > 0) {
      if (!(await user.confirmRemoval(plan.removedWithBody))) {
        return false;
      }
      if (baseVersion !== document.version) {
        user.warn(STALE_MESSAGE);
        return false;
      }
    }

    // Set first: the change event for this edit fires before applyChange resolves.
    const previous = this.model;
    this.model = plan.model;
    if (!(await document.applyChange(plan.change))) {
      this.model = previous;
      user.warn(APPLY_FAILED_MESSAGE);
      return false;
    }
    return true;
  }

  private refreshModel(): void {
    const text = this.ports.document.getText();
    if (text !== this.model.outline.source) {
      this.model = createModel(text, this.title, this.model);
    }
  }

  private post(ack?: { seq: number; applied: boolean }): void {
    this.refreshModel();
    this.sentVersion = this.ports.document.version;
    this.ports.view.post({
      type: 'sync',
      version: this.sentVersion,
      tree: modelToTree(this.model),
      ack,
    });
  }
}
