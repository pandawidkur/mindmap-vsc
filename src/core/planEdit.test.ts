import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createModel, DocumentModel, modelToTree, TreeNode } from './model';
import { applyChange, planTreeEdit } from './planEdit';

const TITLE = 'FILE';

function clone(tree: TreeNode): TreeNode {
  return JSON.parse(JSON.stringify(tree));
}

function find(node: TreeNode, topic: string): TreeNode {
  if (node.topic === topic) {
    return node;
  }
  for (const child of node.children) {
    try {
      return find(child, topic);
    } catch {
      // Keep looking in the next branch.
    }
  }
  throw new Error(`No node "${topic}"`);
}

function parentOf(root: TreeNode, topic: string): TreeNode {
  if (root.children.some((c) => c.topic === topic)) {
    return root;
  }
  for (const child of root.children) {
    try {
      return parentOf(child, topic);
    } catch {
      // Keep looking in the next branch.
    }
  }
  throw new Error(`No parent of "${topic}"`);
}

function edit(source: string, mutate: (tree: TreeNode) => void) {
  const model = createModel(source, TITLE);
  const tree = clone(modelToTree(model));
  mutate(tree);
  return { model, plan: planTreeEdit(model, tree) };
}

function run(source: string, mutate: (tree: TreeNode) => void): string {
  const { plan } = edit(source, mutate);
  if (plan.kind !== 'change') {
    throw new Error(`Expected a change, got ${JSON.stringify(plan)}`);
  }
  return applyChange(source, plan.change);
}

function newNode(id: string, topic: string): TreeNode {
  return { id, topic, children: [] };
}

const DOC = `---
title: x
# yaml comment
---
Intro paragraph.

# Doc

Important paragraph.

- item

\`\`\`bash
# install deps
\`\`\`

## A ##

Text of A.

### A1

Text of A1.

## B

Text of B.
`;

describe('planTreeEdit keeps everything it was not asked to change', () => {
  it('does nothing for an untouched tree', () => {
    expect(edit(DOC, () => {}).plan.kind).toBe('noop');
  });

  it('renames only the heading text', () => {
    const output = run(DOC, (t) => {
      find(t, 'A').topic = 'Alpha';
    });
    expect(output).toBe(DOC.replace('## A ##', '## Alpha ##'));
  });

  it('produces a change limited to the renamed text', () => {
    const { plan } = edit(DOC, (t) => {
      find(t, 'B').topic = 'Beta';
    });
    expect(plan.kind === 'change' && plan.change.text).toBe('eta');
  });

  it('adds a child at the end of its parent section', () => {
    const output = run(DOC, (t) => {
      find(t, 'A').children.push(newNode('new1', 'A2'));
    });
    expect(output).toBe(DOC.replace('Text of A1.\n\n', 'Text of A1.\n\n### A2\n\n'));
  });

  it('removes a section together with its body and reports it', () => {
    const { plan } = edit(DOC, (t) => {
      const a = parentOf(t, 'A');
      a.children = a.children.filter((c) => c.topic !== 'A');
    });
    expect(plan.kind === 'change' && plan.removedWithBody).toBe(2);
    if (plan.kind === 'change') {
      const output = applyChange(DOC, plan.change);
      expect(output).not.toContain('Text of A');
      expect(output).toContain('Important paragraph.');
      expect(output).toContain('Text of B.');
    }
  });

  it('does not report a removed heading that owned no text', () => {
    const { plan } = edit('# R\n\n## A\n\n## B\n', (t) => {
      t.children = t.children.filter((c) => c.topic !== 'A');
    });
    expect(plan.kind === 'change' && plan.removedWithBody).toBe(0);
  });

  it('moves a section and shifts the levels of its subtree', () => {
    const output = run('# R\n\n## A\n\na\n\n### A1\n\na1\n\n## B\n\nb\n', (t) => {
      const a = find(t, 'A');
      t.children = t.children.filter((c) => c !== a);
      find(t, 'B').children.push(a);
    });
    expect(output).toBe('# R\n\n## B\n\nb\n\n### A\n\na\n\n#### A1\n\na1\n');
  });

  it('reorders siblings', () => {
    const output = run('# R\n\n## A\n\na\n\n## B\n\nb\n', (t) => {
      t.children.reverse();
    });
    expect(output).toBe('# R\n\n## B\n\nb\n\n## A\n\na\n');
  });

  it('wraps a node in a new parent', () => {
    const output = run('# R\n\n## A\n\na\n\n## B\n', (t) => {
      const a = find(t, 'A');
      t.children[0] = { id: 'p', topic: 'P', children: [a] };
    });
    expect(output).toBe('# R\n\n## P\n\n### A\n\na\n\n## B\n');
  });

  it('keeps CRLF line endings', () => {
    const source = '# R\r\n\r\ntext\r\n\r\n## A\r\n';
    const output = run(source, (t) => {
      t.children.push(newNode('n', 'B'));
    });
    expect(output).toBe('# R\r\n\r\ntext\r\n\r\n## A\r\n\r\n## B\r\n');
  });

  it('keeps setext headings until their level changes', () => {
    const source = 'Root\n====\n\nSub\n---\n\ntext\n';
    expect(
      run(source, (t) => {
        find(t, 'Sub').topic = 'Renamed';
      })
    ).toBe('Root\n====\n\nRenamed\n---\n\ntext\n');
    expect(
      run(source, (t) => {
        const sub = find(t, 'Sub');
        t.children = [newNode('n', 'P')];
        t.children[0].children.push(sub);
      })
    ).toBe('Root\n====\n\n## P\n\n### Sub\n\ntext\n');
  });

  it('adds a final line break when appending after an unterminated line', () => {
    const output = run('# R\n\ntext', (t) => {
      t.children.push(newNode('n', 'A'));
    });
    expect(output).toBe('# R\n\ntext\n\n## A\n');
  });

  it('does not leave a gap when the last section is removed', () => {
    const output = run('# R\n\n## A\n\na\n\n## B\n\nb\n', (t) => {
      t.children = t.children.filter((c) => c.topic !== 'B');
    });
    expect(output).toBe('# R\n\n## A\n\na\n');
  });

  it('flattens topics to one line and escapes closing hashes', () => {
    const output = run('# R\n\n## A\n', (t) => {
      find(t, 'A').topic = 'one\ntwo #';
    });
    expect(output).toBe('# R\n\n## one two \\#\n');
  });
});

describe('planTreeEdit with a synthetic root', () => {
  it('never writes the synthetic root', () => {
    const output = run('## A\n\ntext\n', (t) => {
      t.children.push(newNode('n', 'B'));
    });
    expect(output).toBe('## A\n\ntext\n\n## B\n');
  });

  it('uses H2 for the first node of a document without headings', () => {
    const output = run('Just text.\n', (t) => {
      t.children.push(newNode('n', 'First'));
    });
    expect(output).toBe('Just text.\n\n## First\n');
    expect(modelToTree(createModel(output, TITLE)).topic).toBe(TITLE);
  });

  it('refuses to rename the synthetic root', () => {
    const { plan } = edit('## A\n', (t) => {
      t.topic = 'Other';
    });
    expect(plan).toEqual({ kind: 'rejected', reason: 'synthetic-root-rename' });
  });

  it('lets a lone remaining H1 become the root', () => {
    const { plan } = edit('# A\n\na\n\n# B\n', (t) => {
      t.children = t.children.filter((c) => c.topic !== 'B');
    });
    expect(plan.kind).toBe('change');
    if (plan.kind === 'change') {
      expect(modelToTree(plan.model).id).toBe('root');
      expect(modelToTree(plan.model).topic).toBe('A');
    }
  });
});

describe('planTreeEdit refuses what it cannot do safely', () => {
  it('blocks nesting below H6', () => {
    const { plan } = edit('# 1\n## 2\n### 3\n#### 4\n##### 5\n###### 6\n', (t) => {
      find(t, '6').children.push(newNode('n', '7'));
    });
    expect(plan).toEqual({ kind: 'rejected', reason: 'depth-limit' });
  });

  it('blocks a move that would push a subtree below H6', () => {
    const { plan } = edit('# R\n## A\n### A1\n#### A2\n##### A3\n###### A4\n## B\n### B1\n', (t) => {
      const b = find(t, 'B');
      t.children = t.children.filter((c) => c !== b);
      find(t, 'A4').children.push(b);
    });
    expect(plan).toEqual({ kind: 'rejected', reason: 'depth-limit' });
  });

  it('refuses a move that an unclosed code fence would swallow', () => {
    const { plan } = edit('# R\n\n## A\n\n## B\n\n```\ncode\n', (t) => {
      t.children.reverse();
    });
    expect(plan).toEqual({ kind: 'rejected', reason: 'verification-failed' });
  });

  it('refuses a setext rename that would stop being a heading', () => {
    const { plan } = edit('Root\n====\n\nSub\n---\n', (t) => {
      find(t, 'Sub').topic = '- item';
    });
    expect(plan).toEqual({ kind: 'rejected', reason: 'verification-failed' });
  });

  it('rejects duplicate ids and a replaced root', () => {
    expect(
      edit('# R\n## A\n', (t) => {
        t.children.push(clone(t.children[0]));
      }).plan
    ).toEqual({ kind: 'rejected', reason: 'invalid-tree' });
    expect(
      edit('# R\n', (t) => {
        t.id = 'other';
      }).plan
    ).toEqual({ kind: 'rejected', reason: 'invalid-tree' });
  });
});

describe('planTreeEdit properties', () => {
  interface Section {
    depth: number;
    body: boolean;
  }

  const sections = fc.array(
    fc.record({ depth: fc.integer({ min: 1, max: 4 }), body: fc.boolean() }),
    { minLength: 1, maxLength: 12 }
  );
  const eols = fc.constantFrom('\n', '\r\n');

  function render(items: Section[], eol: string): string {
    const parts = ['# Root', 'Root body.'];
    items.forEach((item, i) => {
      parts.push(`${'#'.repeat(item.depth + 1)} H${i}`);
      if (item.body) {
        parts.push(`Body ${i}.`);
      }
    });
    return parts.join(eol + eol) + eol;
  }

  function nodes(tree: TreeNode): TreeNode[] {
    return [tree, ...tree.children.flatMap(nodes)];
  }

  function bodyLines(text: string): string[] {
    return text.split(/\r?\n/).filter((line) => line.startsWith('Body ') || line === 'Root body.');
  }

  function subtreeTopics(node: TreeNode): Set<string> {
    return new Set(nodes(node).map((n) => n.topic));
  }

  const check = (mutate: (tree: TreeNode, pick: number, model: DocumentModel) => void) =>
    fc.property(sections, eols, fc.nat(), (items, eol, pick) => {
      const source = render(items, eol);
      const model = createModel(source, TITLE);
      const tree = clone(modelToTree(model));
      mutate(tree, pick, model);

      const plan = planTreeEdit(model, tree);
      if (plan.kind === 'rejected') {
        expect(plan.reason).toBe('depth-limit');
        return;
      }
      if (plan.kind === 'noop') {
        return;
      }

      const output = applyChange(source, plan.change);
      // The planned model is what a fresh parse of the output sees.
      const reparsed = createModel(output, TITLE);
      expect(reparsed.outline.headings).toEqual(plan.model.outline.headings);

      // Every surviving body line is there, exactly once.
      const removed = new Set(nodes(createModelTree(source)).map((n) => n.topic));
      nodes(tree).forEach((n) => removed.delete(n.topic));
      const expectedBodies = bodyLines(source).filter(
        (line) => !removed.has(line.replace(/^Body (\d+)\.$/, 'H$1'))
      );
      expect(bodyLines(output).sort()).toEqual(expectedBodies.sort());

      // Line endings are never mixed.
      if (eol === '\r\n') {
        expect(output.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
      } else {
        expect(output).not.toContain('\r');
      }
    });

  function createModelTree(source: string): TreeNode {
    return modelToTree(createModel(source, TITLE));
  }

  it('rename touches nothing but the heading', () => {
    fc.assert(
      fc.property(sections, eols, fc.nat(), (items, eol, pick) => {
        const source = render(items, eol);
        const model = createModel(source, TITLE);
        const tree = clone(modelToTree(model));
        const all = nodes(tree).slice(1);
        const target = all[pick % all.length];
        const oldTopic = target.topic;
        target.topic = 'Renamed';
        const plan = planTreeEdit(model, tree);
        expect(plan.kind).toBe('change');
        if (plan.kind === 'change') {
          expect(applyChange(source, plan.change)).toBe(
            source.replace(new RegExp(`(#+ )${oldTopic}(\\r?\\n)`), '$1Renamed$2')
          );
        }
      }),
      { numRuns: 200 }
    );
  });

  it('add keeps all text', () => {
    fc.assert(
      check((tree, pick) => {
        const all = nodes(tree);
        all[pick % all.length].children.push(newNode('added', 'Added'));
      }),
      { numRuns: 200 }
    );
  });

  it('remove drops only the removed subtree', () => {
    fc.assert(
      check((tree, pick) => {
        const all = nodes(tree).slice(1);
        const target = all[pick % all.length];
        const parent = parentOf(tree, target.topic);
        parent.children = parent.children.filter((c) => c !== target);
      }),
      { numRuns: 200 }
    );
  });

  it('move keeps all text', () => {
    fc.assert(
      check((tree, pick) => {
        const all = nodes(tree).slice(1);
        const target = all[pick % all.length];
        const parent = parentOf(tree, target.topic);
        const blocked = subtreeTopics(target);
        const destinations = nodes(tree).filter((n) => !blocked.has(n.topic));
        const destination = destinations[(pick >> 3) % destinations.length];
        parent.children = parent.children.filter((c) => c !== target);
        destination.children.splice(pick % (destination.children.length + 1), 0, target);
      }),
      { numRuns: 300 }
    );
  });
});
