import { applyChange } from '../../core/planEdit';
import { HistoryAction, WebviewMessage } from '../../shared/protocol';
import { SyncSession } from '../../sync/SyncSession';

/** Stands in for the extension host: a real SyncSession over an in-memory document. */
interface TestHost {
  text(): string;
  /** Simulates typing in the text editor. */
  type(text: string): void;
  history: HistoryAction[];
  warnings: string[];
  /** Answer to the "delete a section with text" question. */
  confirmRemoval: boolean;
}

const testWindow = window as unknown as {
  __doc: string;
  __host: TestHost;
  acquireVsCodeApi(): { postMessage(message: WebviewMessage): void };
};

const state = { text: testWindow.__doc, version: 1 };

const host: TestHost = {
  text: () => state.text,
  type(text) {
    state.text = text;
    state.version += 1;
    session.documentChanged();
  },
  history: [],
  warnings: [],
  confirmRemoval: true,
};

const session: SyncSession = new SyncSession(
  {
    document: {
      get version() {
        return state.version;
      },
      getText: () => state.text,
      async applyChange(change) {
        state.text = applyChange(state.text, change);
        state.version += 1;
        session.documentChanged();
        return true;
      },
    },
    view: { post: (message) => window.postMessage(message, '*') },
    user: {
      confirmRemoval: async () => host.confirmRemoval,
      warn: (message) => host.warnings.push(message),
    },
    history: async (action) => {
      host.history.push(action);
    },
  },
  'notes'
);

testWindow.__host = host;
testWindow.acquireVsCodeApi = () => ({
  postMessage: (message) => void session.handleMessage(message),
});
