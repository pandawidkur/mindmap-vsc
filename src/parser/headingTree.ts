export interface MindmapNode {
  id: string;
  topic: string;
  children?: MindmapNode[];
  expanded?: boolean;
}

export interface MindmapData {
  nodeData: MindmapNode;
  direction?: number;
}

let counter = 0;
export function generateNodeId(prefix: string = 'node'): string {
  counter += 1;
  const rand = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${counter}_${rand}`;
}

export interface ParseOptions {
  defaultTitle?: string;
}

/**
 * Parses markdown text containing headings (#, ##, ###) into a MindElixir tree structure.
 * Plain text/paragraphs not starting with '#' are ignored per pure heading skeleton design.
 */
export function markdownToTree(markdown: string, options: ParseOptions = {}): MindmapData {
  const fallbackTitle = options.defaultTitle || 'Mindmap';
  const lines = markdown.split(/\r?\n/);

  interface HeadingItem {
    level: number;
    topic: string;
  }

  const headings: HeadingItem[] = [];
  const headingRegex = /^(#{1,6})\s+(.+)$/;

  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(headingRegex);
    if (match) {
      headings.push({
        level: match[1].length,
        topic: match[2].trim(),
      });
    }
  }

  if (headings.length === 0) {
    return {
      nodeData: {
        id: 'root',
        topic: fallbackTitle,
        children: [],
        expanded: true,
      },
    };
  }

  const minLevel = Math.min(...headings.map((h) => h.level));
  const minLevelCount = headings.filter((h) => h.level === minLevel).length;

  let rootNode: MindmapNode;
  let baseLevel: number;
  let itemsToProcess: HeadingItem[];

  if (minLevel === 1 && minLevelCount === 1) {
    // Single H1 acts as the natural root
    rootNode = {
      id: 'root',
      topic: headings[0].topic,
      children: [],
      expanded: true,
    };
    baseLevel = 1;
    itemsToProcess = headings.slice(1);
  } else {
    // Multiple top-level headings or no H1 -> wrap in fallback title root
    rootNode = {
      id: 'root',
      topic: fallbackTitle,
      children: [],
      expanded: true,
    };
    baseLevel = minLevel - 1;
    itemsToProcess = headings;
  }

  const stack: { level: number; node: MindmapNode }[] = [
    { level: baseLevel, node: rootNode },
  ];

  for (const h of itemsToProcess) {
    while (stack.length > 1 && stack[stack.length - 1].level >= h.level) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].node;
    const newNode: MindmapNode = {
      id: generateNodeId('n'),
      topic: h.topic,
      children: [],
      expanded: true,
    };

    if (!parent.children) {
      parent.children = [];
    }
    parent.children.push(newNode);
    stack.push({ level: h.level, node: newNode });
  }

  return {
    nodeData: rootNode,
  };
}

/**
 * Serializes a MindElixir tree structure into a clean markdown document with headings.
 */
export function treeToMarkdown(data: MindmapData): string {
  if (!data || !data.nodeData) {
    return '# Mindmap\n';
  }

  const lines: string[] = [];

  function walk(node: MindmapNode, depth: number) {
    const hashes = '#'.repeat(Math.min(Math.max(depth, 1), 6));
    lines.push(`${hashes} ${node.topic}`);

    if (node.children && node.children.length > 0) {
      for (const child of node.children) {
        walk(child, depth + 1);
      }
    }
  }

  walk(data.nodeData, 1);
  return lines.join('\n\n') + '\n';
}
