import { describe, it, expect } from 'vitest';
import { markdownToTree, treeToMarkdown } from './headingTree';

describe('headingTree parser & serializer', () => {
  it('handles empty markdown with default fallback title', () => {
    const tree = markdownToTree('', { defaultTitle: 'Project Idea' });
    expect(tree.nodeData.topic).toBe('Project Idea');
    expect(tree.nodeData.children).toEqual([]);

    const md = treeToMarkdown(tree);
    expect(md.trim()).toBe('# Project Idea');
  });

  it('parses single root heading', () => {
    const input = '# Central Topic\n';
    const tree = markdownToTree(input);
    expect(tree.nodeData.topic).toBe('Central Topic');
    expect(tree.nodeData.children).toEqual([]);

    const output = treeToMarkdown(tree);
    expect(output.trim()).toBe('# Central Topic');
  });

  it('parses multi-level tree correctly', () => {
    const input = `# Root
## Branch 1
### Leaf 1.1
### Leaf 1.2
## Branch 2
### Leaf 2.1
#### Sub-leaf 2.1.1
`;
    const tree = markdownToTree(input);
    expect(tree.nodeData.topic).toBe('Root');
    expect(tree.nodeData.children).toHaveLength(2);

    const b1 = tree.nodeData.children![0];
    expect(b1.topic).toBe('Branch 1');
    expect(b1.children).toHaveLength(2);
    expect(b1.children![0].topic).toBe('Leaf 1.1');
    expect(b1.children![1].topic).toBe('Leaf 1.2');

    const b2 = tree.nodeData.children![1];
    expect(b2.topic).toBe('Branch 2');
    expect(b2.children).toHaveLength(1);
    expect(b2.children![0].topic).toBe('Leaf 2.1');
    expect(b2.children![0].children![0].topic).toBe('Sub-leaf 2.1.1');
  });

  it('ignores non-heading content per pure skeleton policy', () => {
    const input = `# My Architecture

Some description paragraph here that should be ignored.

## Component A
- Bullet point item 1
- Bullet point item 2

\`\`\`typescript
const x = 42;
\`\`\`

## Component B
`;
    const tree = markdownToTree(input);
    expect(tree.nodeData.topic).toBe('My Architecture');
    expect(tree.nodeData.children).toHaveLength(2);
    expect(tree.nodeData.children![0].topic).toBe('Component A');
    expect(tree.nodeData.children![1].topic).toBe('Component B');

    const serialized = treeToMarkdown(tree);
    expect(serialized).toBe('# My Architecture\n\n## Component A\n\n## Component B\n');
  });

  it('handles multiple H1 headings by wrapping under fallback root', () => {
    const input = `# First Section
## Child of First
# Second Section
## Child of Second
`;
    const tree = markdownToTree(input, { defaultTitle: 'Workspace Overview' });
    expect(tree.nodeData.topic).toBe('Workspace Overview');
    expect(tree.nodeData.children).toHaveLength(2);
    expect(tree.nodeData.children![0].topic).toBe('First Section');
    expect(tree.nodeData.children![0].children![0].topic).toBe('Child of First');
    expect(tree.nodeData.children![1].topic).toBe('Second Section');
    expect(tree.nodeData.children![1].children![0].topic).toBe('Child of Second');
  });

  it('handles documents without H1 by using fallback root', () => {
    const input = `## Branch A
### Leaf A1
## Branch B
`;
    const tree = markdownToTree(input, { defaultTitle: 'Quick Notes' });
    expect(tree.nodeData.topic).toBe('Quick Notes');
    expect(tree.nodeData.children).toHaveLength(2);
    expect(tree.nodeData.children![0].topic).toBe('Branch A');
    expect(tree.nodeData.children![0].children![0].topic).toBe('Leaf A1');
    expect(tree.nodeData.children![1].topic).toBe('Branch B');
  });

  it('is idempotent across round-trip serialization', () => {
    const input = `# Project Vision

## Research

### Competitor Analysis

### User Interviews

## Development

### Frontend

### Backend
`;
    const tree = markdownToTree(input);
    const output = treeToMarkdown(tree);
    const tree2 = markdownToTree(output);
    const output2 = treeToMarkdown(tree2);

    expect(output.trim()).toBe(input.trim());
    expect(output2.trim()).toBe(output.trim());
  });
});
