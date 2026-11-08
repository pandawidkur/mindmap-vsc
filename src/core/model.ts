import { buildStructure, Outline, parseOutline, StructureNode } from './outline';

export const ROOT_ID = 'root';

export interface TreeNode {
  id: string;
  topic: string;
  children: TreeNode[];
  expanded?: boolean;
}

/** A parsed document together with the stable node id of each heading. */
export interface DocumentModel {
  outline: Outline;
  ids: string[];
  /** Shown as the synthetic root, when the document has no heading to use. */
  title: string;
}

let counter = 0;

function generateId(): string {
  counter += 1;
  return `n${counter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Index of the heading used as the real root, or -1 when the root is synthetic. */
export function rootHeading(outline: Outline): number {
  return buildStructure(outline).synthetic ? -1 : 0;
}

function headingPaths(outline: Outline): string[] {
  const paths: string[] = new Array(outline.headings.length);
  const walk = (node: StructureNode, prefix: string) => {
    const path =
      node.heading >= 0 ? `${prefix}\u0000${outline.headings[node.heading].label}` : prefix;
    if (node.heading >= 0) {
      paths[node.heading] = path;
    }
    node.children.forEach((child) => walk(child, path));
  };
  walk(buildStructure(outline).root, '');
  return paths;
}

/**
 * Carries node ids over to a new parse so selection and folding survive edits
 * made in the text editor. Matches by full path, then by label, then pairs what
 * is left in document order, which is how an edited heading keeps its id.
 */
export function reconcileIds(previous: DocumentModel | null, outline: Outline): string[] {
  const ids: (string | null)[] = new Array(outline.headings.length).fill(null);

  if (previous) {
    const used = new Set<number>();
    const match = (nextKeys: string[], prevKeys: string[]) => {
      const available = new Map<string, number[]>();
      prevKeys.forEach((key, i) => {
        if (!used.has(i)) {
          available.set(key, [...(available.get(key) ?? []), i]);
        }
      });
      nextKeys.forEach((key, i) => {
        const candidate = ids[i] === null ? available.get(key)?.shift() : undefined;
        if (candidate !== undefined) {
          ids[i] = previous.ids[candidate];
          used.add(candidate);
        }
      });
    };
    match(headingPaths(outline), headingPaths(previous.outline));
    match(
      outline.headings.map((h) => h.label),
      previous.outline.headings.map((h) => h.label)
    );

    const leftovers = previous.ids.filter((_, i) => !used.has(i));
    ids.forEach((id, i) => {
      if (id === null && leftovers.length > 0) {
        ids[i] = leftovers.shift() as string;
      }
    });
  }

  const root = rootHeading(outline);
  return ids.map((id, i) => {
    if (i === root) {
      return ROOT_ID;
    }
    return id === null || id === ROOT_ID ? generateId() : id;
  });
}

export function createModel(
  source: string,
  title: string,
  previous: DocumentModel | null = null
): DocumentModel {
  const outline = parseOutline(source);
  return { outline, ids: reconcileIds(previous, outline), title };
}

export function modelToTree(model: DocumentModel): TreeNode {
  const { outline, ids, title } = model;
  const toNode = (node: StructureNode): TreeNode => ({
    id: node.heading >= 0 ? ids[node.heading] : ROOT_ID,
    topic: node.heading >= 0 ? outline.headings[node.heading].label : title,
    children: node.children.map(toNode),
    expanded: true,
  });
  return toNode(buildStructure(outline).root);
}
