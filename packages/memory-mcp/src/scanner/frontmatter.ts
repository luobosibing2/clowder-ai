// memory-mcp: YAML frontmatter parsing utilities
// Extracted from CatCafeScanner.ts (F102) — simple regex-based subset parser.

/**
 * Parse YAML frontmatter from markdown content.
 * Supports scalar values and simple arrays: [a, b, c].
 * Returns null if no frontmatter found or it's empty.
 */
export function extractFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match?.[1]) return null;

  const yaml = match[1];
  const result: Record<string, unknown> = {};

  for (const line of yaml.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1]!;
    const rawVal = kv[2]!;
    const arrMatch = rawVal.match(/^\[(.+)]$/);
    if (arrMatch) {
      result[key] = arrMatch[1]?.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
    } else {
      result[key] = rawVal.trim();
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Extract a canonical anchor from frontmatter.
 * Priority: anchor > feature_ids[0] > decision_id > plan_id
 */
export function extractAnchor(fm: Record<string, unknown>): string | null {
  const anchor = fm['anchor'];
  if (typeof anchor === 'string') return anchor;
  const featureIds = fm['feature_ids'];
  if (Array.isArray(featureIds) && featureIds.length > 0) return featureIds[0] as string;
  const decisionId = fm['decision_id'];
  if (typeof decisionId === 'string') return decisionId;
  const planId = fm['plan_id'];
  if (typeof planId === 'string') return planId;
  return null;
}
