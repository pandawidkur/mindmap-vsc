import { DocumentModel, modelToTree, ROOT_ID, TreeNode } from './model';
import {
  buildStructure,
  Heading,
  hasBody,
  Outline,
  parseOutline,
  stripEol,
  StructureNode,
} from './outline';

const MAX_LEVEL = 6;
/** Parent marker of a node that does not exist in the document yet. */
const NEW_NODE = -2;

/** A single replacement of `source.slice(start, end)` with `text`. */
export interface TextChange {
  start: number;
  end: number;
  text: string;
}

export type RejectionReason =
  | 'invalid-tree'
  | 'synthetic-root-rename'
  | 'depth-limit'
  | 'verification-failed';

export type EditPlan =
  | { kind: 'noop' }
  | { kind: 'rejected'; reason: RejectionReason }
  | {
      kind: 'change';
      change: TextChange;
      /** Model describing the document once the change is applied. */
      model: DocumentModel;
      /** Removed headings that still owned text; the user should confirm these. */
      removedWithBody: number;
    };

/** The topic as a single line, which is all a heading can hold. */
function normalizeTopic(topic: string): string {
  return topic.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/** Escapes a trailing run of `#` that would otherwise close an ATX heading. */
function encodeTopic(topic: string): string {
  return normalizeTopic(topic).replace(/(^|[ \t])(#+)$/, '$1\\$2');
}

function hashes(level: number): string {
  return '#'.repeat(level);
}

/** Splits an ATX line around its marker and text, leaving any closing hashes out. */
function atxParts(line: string): { indent: string; textStart: number; textEnd: number; hashesEnd: number } {
  const prefix = line.match(/^( {0,3})#{1,6}/) as RegExpMatchArray;
  const hashesEnd = prefix[0].length;
  const rest = line.trimEnd().slice(hashesEnd);
  const closing = rest.match(/(?:^|[ \t]+)#+$/);
  const inner = closing ? rest.slice(0, closing.index) : rest;
  const textStart = hashesEnd + (inner.length - inner.trimStart().length);
  const textEnd = Math.max(textStart, hashesEnd + inner.trimEnd().length);
  return { indent: prefix[1], textStart, textEnd, hashesEnd };
}

/** Renders a heading, reusing its original bytes unless its level or text changed. */
function renderHeading(
  outline: Outline,
  heading: Heading,
  level: number,
  newText: string | null
): string {
  const raw = outline.lines.slice(heading.startLine, heading.bodyStartLine);
  if (level === heading.level && newText === null) {
    return raw.join('');
  }

  if (heading.style === 'setext') {
    return level === heading.level
      ? `${newText}${outline.eol}${raw[raw.length - 1]}`
      : `${hashes(level)} ${newText ?? heading.label}${outline.eol}`;
  }

  const line = stripEol(raw[0]);
  const eol = raw[0].slice(line.length);
  const { indent, textStart, textEnd, hashesEnd } = atxParts(line);
  let beforeClosing: string;
  if (newText === null) {
    beforeClosing = line.slice(hashesEnd, textEnd);
  } else if (textStart === textEnd) {
    beforeClosing = ` ${newText}`;
  } else {
    beforeClosing = line.slice(hashesEnd, textStart) + newText;
  }
  return `${indent}${hashes(level)}${beforeClosing}${line.slice(textEnd)}${eol}`;
}

function collectIds(node: TreeNode, into: string[] = []): string[] {
  into.push(node.id);
  node.children.forEach((child) => collectIds(child, into));
  return into;
}

/** Trims the replacement to what differs, without cutting a CRLF or a surrogate pair. */
function minimalChange(before: string, after: string): TextChange {
  const splitsUnit = (text: string, index: number) => {
    const previous = text.charCodeAt(index - 1);
    return (
      (previous === 13 && text.charCodeAt(index) === 10) ||
      (previous >= 0xd800 && previous <= 0xdbff)
    );
  };

  const limit = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < limit && before[prefix] === after[prefix]) {
    prefix++;
  }
  while (prefix > 0 && (splitsUnit(before, prefix) || splitsUnit(after, prefix))) {
    prefix--;
  }

  let suffix = 0;
  while (
    suffix < limit - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  while (
    suffix > 0 &&
    (splitsUnit(before, before.length - suffix) || splitsUnit(after, after.length - suffix))
  ) {
    suffix--;
  }

  return { start: prefix, end: before.length - suffix, text: after.slice(prefix, after.length - suffix) };
}

interface Chunk {
  /** Original heading index, or NEW_NODE for a node created on the map. */
  heading: number;
  text: string;
}

/** Walks the requested tree and renders each node as a chunk of the new document. */
class ChunkBuilder {
  readonly chunks: Chunk[] = [];
  private readonly indexById: Map<string, number>;
  private readonly parentOf = new Map<number, number>();

  constructor(
    private readonly outline: Outline,
    ids: string[],
    root: StructureNode
  ) {
    this.indexById = new Map(ids.map((id, i) => [id, i]));
    const record = (node: StructureNode) =>
      node.children.forEach((child) => {
        this.parentOf.set(child.heading, node.heading);
        record(child);
      });
    record(root);
  }

  /** Emits an existing heading with its body, returning the topic it will parse back to. */
  emitExisting(heading: number, topic: string, level: number): string {
    const source = this.outline.headings[heading];
    const normalized = normalizeTopic(topic);
    const renamed = normalized !== source.label;
    const parsedTopic = renamed ? encodeTopic(normalized) : source.label;
    this.chunks.push({
      heading,
      text:
        renderHeading(this.outline, source, level, renamed ? parsedTopic : null) +
        this.outline.lines.slice(source.bodyStartLine, source.endLine).join(''),
    });
    return parsedTopic;
  }

  /** Emits the children of `node`; returns false when they would pass the H6 limit. */
  emitChildren(
    node: TreeNode,
    nodeHeading: number,
    level: number,
    levelDelta: number,
    target: TreeNode
  ): boolean {
    if (node.children.length > 0 && level >= MAX_LEVEL) {
      return false;
    }
    const stayed = (heading: number | undefined): heading is number =>
      heading !== undefined && this.parentOf.get(heading) === nodeHeading;

    let previousLevel: number | null = null;
    return node.children.every((child, position) => {
      const heading = this.indexById.get(child.id);

      let desired: number;
      if (stayed(heading)) {
        desired = this.outline.headings[heading].level + levelDelta;
      } else if (previousLevel !== null) {
        desired = previousLevel;
      } else {
        const follower = this.indexById.get(node.children[position + 1]?.id);
        // An H1 under a synthetic root could turn into the root itself, hence H2.
        const fallback = nodeHeading === -1 ? 2 : level + 1;
        desired = stayed(follower)
          ? this.outline.headings[follower].level + levelDelta
          : fallback;
      }
      // Sibling levels must never rise, or a later sibling would nest under an earlier one.
      const childLevel = Math.max(level + 1, Math.min(desired, previousLevel ?? MAX_LEVEL, MAX_LEVEL));
      previousLevel = childLevel;

      let parsedTopic: string;
      if (heading !== undefined) {
        parsedTopic = this.emitExisting(heading, child.topic, childLevel);
      } else {
        parsedTopic = encodeTopic(child.topic);
        this.chunks.push({
          heading: NEW_NODE,
          text: `${hashes(childLevel)} ${parsedTopic}`.trimEnd() + this.outline.eol,
        });
      }

      const childTarget: TreeNode = { id: child.id, topic: parsedTopic, children: [] };
      target.children.push(childTarget);
      const delta = heading !== undefined ? childLevel - this.outline.headings[heading].level : 0;
      return this.emitChildren(child, heading ?? NEW_NODE, childLevel, delta, childTarget);
    });
  }
}

/** Concatenates chunks; a blank line is added only where neighbours were not adjacent. */
function assemble(outline: Outline, chunks: Chunk[]): string {
  let text = outline.lines.slice(0, outline.preambleEndLine).join('');
  let previous = -1;
  for (const chunk of chunks) {
    const adjacent = chunk.heading >= 0 && chunk.heading === previous + 1;
    if (!adjacent && text.trim() !== '') {
      if (!/[\r\n]$/.test(text)) {
        text += outline.eol;
      }
      if (!/(?:\r\n|\n|\r(?!\n))[ \t]*(?:\r\n|\n|\r)$/.test(text)) {
        text += outline.eol;
      }
    }
    text += chunk.text;
    previous = chunk.heading >= 0 ? chunk.heading : NEW_NODE;
  }

  // The section that ended the file moved or went away: do not leave its gap behind.
  const last = chunks[chunks.length - 1];
  if (outline.headings.length > 0 && last?.heading !== outline.headings.length - 1) {
    const trimmed = text.replace(/(?:[ \t]*(?:\r\n|\r|\n))+$/, '');
    text = trimmed === '' ? '' : trimmed + outline.eol;
  }
  return text;
}

function sameShape(a: TreeNode[], b: TreeNode[]): boolean {
  return (
    a.length === b.length &&
    a.every((node, i) => node.topic === b[i].topic && sameShape(node.children, b[i].children))
  );
}

/**
 * Re-parses the new text and returns its model, or null if it does not yield the
 * requested tree. The root may legitimately switch from synthetic to real, as when
 * only one H1 is left, so the top-level nodes are compared rather than the roots.
 */
function verifiedModel(text: string, expected: TreeNode, wasSynthetic: boolean, title: string): DocumentModel | null {
  const outline = parseOutline(text);
  const synthetic = buildStructure(outline).synthetic;
  const parsed = modelToTree({ outline, ids: outline.headings.map(() => ''), title });

  const parsedForest = synthetic ? parsed.children : [parsed];
  const expectedForest = wasSynthetic ? expected.children : [expected];
  if (!sameShape(parsedForest, expectedForest)) {
    return null;
  }

  // Headings appear in document order, which is depth-first order of the expected tree.
  const flat = collectIds(expected);
  const ids = wasSynthetic ? flat.slice(1) : flat;
  if (!synthetic) {
    ids[0] = ROOT_ID;
  }
  return { outline, ids, title };
}

/**
 * Turns the tree edited on the map into the smallest text change. The document
 * is reassembled from its original bytes, so only touched headings are rewritten,
 * and the result is re-parsed: a plan that would not yield the requested tree is
 * refused instead of being applied.
 */
export function planTreeEdit(model: DocumentModel, next: TreeNode): EditPlan {
  const { outline, ids, title } = model;
  const structure = buildStructure(outline);

  const nextIds = collectIds(next);
  if (next.id !== ROOT_ID || new Set(nextIds).size !== nextIds.length) {
    return { kind: 'rejected', reason: 'invalid-tree' };
  }
  if (structure.synthetic && normalizeTopic(next.topic) !== title) {
    return { kind: 'rejected', reason: 'synthetic-root-rename' };
  }

  const builder = new ChunkBuilder(outline, ids, structure.root);
  const expected: TreeNode = { id: next.id, topic: next.topic, children: [] };
  const rootHeading = structure.root.heading;
  let rootLevel = 0;
  if (rootHeading >= 0) {
    rootLevel = outline.headings[rootHeading].level;
    expected.topic = builder.emitExisting(rootHeading, next.topic, rootLevel);
  }
  if (!builder.emitChildren(next, rootHeading, rootLevel, 0, expected)) {
    return { kind: 'rejected', reason: 'depth-limit' };
  }

  const text = assemble(outline, builder.chunks);
  if (text === outline.source) {
    return { kind: 'noop' };
  }

  const nextModel = verifiedModel(text, expected, structure.synthetic, title);
  if (!nextModel) {
    return { kind: 'rejected', reason: 'verification-failed' };
  }

  const kept = new Set(nextIds);
  return {
    kind: 'change',
    change: minimalChange(outline.source, text),
    model: nextModel,
    removedWithBody: outline.headings.filter((h, i) => !kept.has(ids[i]) && hasBody(outline, h)).length,
  };
}

/** Applies a change to its source text. */
export function applyChange(source: string, change: TextChange): string {
  return source.slice(0, change.start) + change.text + source.slice(change.end);
}
