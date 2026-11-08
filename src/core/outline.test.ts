import { describe, it, expect } from 'vitest';
import { createModel, DocumentModel, modelToTree, TreeNode } from './model';
import { buildStructure, parseOutline } from './outline';

const labels = (source: string) => parseOutline(source).headings.map((h) => h.label);
const tree = (source: string): TreeNode => modelToTree(createModel(source, 'FILE'));
const shape = (node: TreeNode): unknown =>
  node.children.length ? [node.topic, node.children.map(shape)] : node.topic;

describe('parseOutline recognizes real headings only', () => {
  it('ignores hashes inside fenced and indented code', () => {
    expect(labels('# Doc\n\n```bash\n# install\n```\n\n    # indented\n\n## A\n')).toEqual(['Doc', 'A']);
  });

  it('ignores hashes in frontmatter but keeps its lines in the preamble', () => {
    const outline = parseOutline('---\ntitle: x\n# yaml comment\n---\n# Doc\n');
    expect(outline.headings.map((h) => h.label)).toEqual(['Doc']);
    expect(outline.preambleEndLine).toBe(4);
  });

  it('treats an unclosed --- as a thematic break, not frontmatter', () => {
    expect(labels('---\n# Doc\n')).toEqual(['Doc']);
  });

  it('reads setext headings, including multi-line ones', () => {
    const outline = parseOutline('Title\n=====\n\nTwo\nlines\n---\n');
    expect(outline.headings.map((h) => [h.label, h.level, h.style])).toEqual([
      ['Title', 1, 'setext'],
      ['Two lines', 2, 'setext'],
    ]);
  });

  it('strips closing hashes from the label', () => {
    expect(labels('# Title #\n## B ##\n')).toEqual(['Title', 'B']);
  });

  it('keeps empty headings', () => {
    expect(labels('# R\n##\n## ok\n')).toEqual(['R', '', 'ok']);
  });

  it('ignores headings nested in quotes, lists and HTML', () => {
    expect(labels('# R\n\n> # quoted\n\n- # listed\n\n<div>\n# html\n</div>\n')).toEqual(['R']);
  });

  it('gives every heading the lines up to the next one', () => {
    const outline = parseOutline('intro\n\n# A\ntext\n## B\n');
    expect(outline.preambleEndLine).toBe(2);
    expect(outline.headings.map((h) => [h.startLine, h.bodyStartLine, h.endLine])).toEqual([
      [2, 3, 4],
      [4, 5, 5],
    ]);
  });

  it('handles CRLF and a missing final line break', () => {
    const outline = parseOutline('# A\r\ntext\r\n## B');
    expect(outline.eol).toBe('\r\n');
    expect(outline.lines).toEqual(['# A\r\n', 'text\r\n', '## B']);
    expect(outline.headings.map((h) => h.label)).toEqual(['A', 'B']);
  });
});

describe('buildStructure picks the root', () => {
  it('uses a lone opening H1 as the root', () => {
    expect(buildStructure(parseOutline('# R\n## A\n')).synthetic).toBe(false);
    expect(shape(tree('# R\n## A\n### B\n## C\n'))).toEqual(['R', [['A', ['B']], 'C']]);
  });

  it('uses a synthetic root for several H1, no H1 or an H1 that is not first', () => {
    expect(shape(tree('# A\n# B\n'))).toEqual(['FILE', ['A', 'B']]);
    expect(shape(tree('## A\n### B\n'))).toEqual(['FILE', [['A', ['B']]]]);
    expect(shape(tree('## Intro\n# Title\n## B\n'))).toEqual(['FILE', ['Intro', ['Title', ['B']]]]);
    expect(shape(tree('Only text.\n'))).toBe('FILE');
  });

  it('does not flatten skipped levels away', () => {
    expect(shape(tree('# R\n### deep\n## b\n'))).toEqual(['R', ['deep', 'b']]);
  });
});

describe('reconcileIds keeps node identity across text edits', () => {
  const idsOf = (model: DocumentModel) =>
    Object.fromEntries(model.outline.headings.map((h, i) => [h.label, model.ids[i]]));

  it('keeps ids when a heading is added above', () => {
    const first = createModel('# R\n## A\n## B\n', 'FILE');
    const second = createModel('# R\n## New\n## A\n## B\n', 'FILE', first);
    expect(idsOf(second).A).toBe(idsOf(first).A);
    expect(idsOf(second).B).toBe(idsOf(first).B);
    expect(new Set(second.ids).size).toBe(4);
  });

  it('keeps the id of a heading being retyped', () => {
    const first = createModel('# R\n## A\n## B\n', 'FILE');
    const second = createModel('# R\n## Ax\n## B\n', 'FILE', first);
    expect(idsOf(second).Ax).toBe(idsOf(first).A);
    expect(idsOf(second).B).toBe(idsOf(first).B);
  });

  it('follows a section moved to another parent', () => {
    const first = createModel('# R\n## A\n### X\n## B\n', 'FILE');
    const second = createModel('# R\n## A\n## B\n### X\n', 'FILE', first);
    expect(idsOf(second).X).toBe(idsOf(first).X);
  });

  it('tells duplicates apart by their path', () => {
    const first = createModel('# R\n## A\n### Same\n## B\n### Same\n', 'FILE');
    const second = createModel('# R\n## B\n### Same\n## A\n### Same\n', 'FILE', first);
    const under = (model: DocumentModel, parent: string) =>
      modelToTree(model).children.find((c) => c.topic === parent)?.children[0].id;
    expect(under(second, 'A')).toBe(under(first, 'A'));
    expect(under(second, 'B')).toBe(under(first, 'B'));
  });

  it('never reuses the root id for another node', () => {
    const first = createModel('# R\n## A\n', 'FILE');
    const second = createModel('# R\n# S\n', 'FILE', first);
    expect(modelToTree(second).id).toBe('root');
    modelToTree(second).children.forEach((c) => expect(c.id).not.toBe('root'));
  });
});
