import MarkdownIt from 'markdown-it';

const parser = new MarkdownIt({ html: true });

export type HeadingStyle = 'atx' | 'setext';

/** One top-level Markdown heading, with the lines of its own body. */
export interface Heading {
  level: number;
  /** Raw inline Markdown of the heading, on a single line. */
  label: string;
  style: HeadingStyle;
  startLine: number;
  /** First line after the heading itself (a setext heading spans several). */
  bodyStartLine: number;
  /** First line of the next heading, or the line count of the document. */
  endLine: number;
}

export interface Outline {
  source: string;
  /** Source lines, each one keeping its own line terminator. */
  lines: string[];
  eol: string;
  headings: Heading[];
  /** Lines before the first heading: frontmatter and any introduction. */
  preambleEndLine: number;
}

export function splitLines(source: string): string[] {
  return source.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
}

export function stripEol(line: string): string {
  return line.replace(/[\r\n]+$/, '');
}

function detectEol(source: string): string {
  const match = source.match(/\r\n|\r|\n/);
  return match ? match[0] : '\n';
}

/** Index of the line closing a YAML frontmatter block, or -1 when there is none. */
function frontmatterEnd(lines: string[]): number {
  if (lines.length === 0 || stripEol(lines[0]).trimEnd() !== '---') {
    return -1;
  }
  for (let i = 1; i < lines.length; i++) {
    const line = stripEol(lines[i]).trimEnd();
    if (line === '---' || line === '...') {
      return i;
    }
  }
  return -1;
}

export function parseOutline(source: string): Outline {
  const lines = splitLines(source);
  const fmEnd = frontmatterEnd(lines);
  // Frontmatter is blanked, not removed, so token line numbers match `lines`.
  const parseable = lines.map((line, i) => (i <= fmEnd ? '' : stripEol(line))).join('\n');
  const tokens = parser.parse(parseable, {});

  const headings: Heading[] = [];
  tokens.forEach((token, index) => {
    // A nested token is a heading inside a list or a quote: it is body text.
    if (token.type !== 'heading_open' || token.level !== 0 || !token.map) {
      return;
    }
    headings.push({
      level: Number(token.tag.slice(1)),
      label: tokens[index + 1].content.replace(/\s*\n\s*/g, ' ').trim(),
      style: token.markup.startsWith('#') ? 'atx' : 'setext',
      startLine: token.map[0],
      bodyStartLine: token.map[1],
      endLine: lines.length,
    });
  });
  headings.forEach((heading, i) => {
    if (i + 1 < headings.length) {
      heading.endLine = headings[i + 1].startLine;
    }
  });

  return {
    source,
    lines,
    eol: detectEol(source),
    headings,
    preambleEndLine: headings.length > 0 ? headings[0].startLine : lines.length,
  };
}

/** Whether a heading owns any text besides blank lines. */
export function hasBody(outline: Outline, heading: Heading): boolean {
  return outline.lines
    .slice(heading.bodyStartLine, heading.endLine)
    .some((line) => line.trim() !== '');
}

/** A heading position in the tree; the synthetic root has `heading` -1. */
export interface StructureNode {
  heading: number;
  children: StructureNode[];
}

export interface Structure {
  /** True when the root is the file title rather than a heading of the document. */
  synthetic: boolean;
  root: StructureNode;
}

/**
 * Builds the heading hierarchy. A lone H1 that opens the document is the root;
 * anything else hangs under a synthetic root that is never written to the file.
 */
export function buildStructure(outline: Outline): Structure {
  const { headings } = outline;
  const levelOneCount = headings.filter((h) => h.level === 1).length;
  const synthetic = !(headings.length > 0 && headings[0].level === 1 && levelOneCount === 1);

  const root: StructureNode = { heading: synthetic ? -1 : 0, children: [] };
  const stack: { level: number; node: StructureNode }[] = [
    { level: synthetic ? 0 : 1, node: root },
  ];
  for (let i = synthetic ? 0 : 1; i < headings.length; i++) {
    while (stack.length > 1 && stack[stack.length - 1].level >= headings[i].level) {
      stack.pop();
    }
    const node: StructureNode = { heading: i, children: [] };
    stack[stack.length - 1].node.children.push(node);
    stack.push({ level: headings[i].level, node });
  }
  return { synthetic, root };
}
