// Pure parsing/formatting for PostgreSQL EXPLAIN output. Kept out of the
// component module so it can be unit-tested and stays fast-refresh friendly.

export interface ExplainNode {
  id: number;
  line: string;
  arrowPos: number | null; // null = attribute line, -1 = root node
  children: ExplainNode[];
}

export function parseExplainTree(rows: unknown[][]): ExplainNode | null {
  if (!rows.length) return null;
  const parsed = rows.map((r, i) => {
    const text = String(r[0] ?? "");
    const m = text.match(/^(\s*)->/);
    return { id: i, text, arrowPos: m ? m[1].length : null };
  });
  const root: ExplainNode = { id: parsed[0].id, line: parsed[0].text, arrowPos: -1, children: [] };
  const stack: ExplainNode[] = [root];
  for (let i = 1; i < parsed.length; i++) {
    const { id, text, arrowPos } = parsed[i];
    if (arrowPos !== null) {
      // Pop until we find a shallower arrow node
      while (stack.length > 1 && (stack[stack.length - 1].arrowPos ?? -1) >= arrowPos) {
        stack.pop();
      }
      const node: ExplainNode = { id, line: text, arrowPos, children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else {
      // Attribute line — belongs to current top of stack, never pushed itself
      stack[stack.length - 1].children.push({ id, line: text, arrowPos: null, children: [] });
    }
  }
  return root;
}

// Split a node line into the operation name and the trailing stats block(s).
// e.g. "  ->  Index Scan using idx  (cost=0.57..2.94 rows=1 width=40)"
//   → name: "  ->  Index Scan using idx"   stats: "  (cost=0.57..2.94 rows=1 width=40)"
export function splitNodeLine(line: string): { name: string; stats: string } {
  const m = line.match(/^(.*?)(\s{2,}\((?:cost|actual\s+time)=.*)$/);
  return m ? { name: m[1], stats: m[2] } : { name: line, stats: "" };
}

// Flag Seq Scan only when the planner estimates >= 1000 rows.
export function isLargeSeqScan(line: string): boolean {
  if (!/\bSeq Scan\b/.test(line)) return false;
  const m = line.match(/\brows=(\d+)/);
  return m ? parseInt(m[1], 10) >= 1000 : true;
}
