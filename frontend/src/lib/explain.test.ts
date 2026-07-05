import { describe, it, expect } from "vitest";
import { parseExplainTree, splitNodeLine, isLargeSeqScan } from "./explain";

const rows = (...lines: string[]): unknown[][] => lines.map((l) => [l]);

describe("parseExplainTree", () => {
  it("returns null for no rows", () => {
    expect(parseExplainTree([])).toBeNull();
  });

  it("treats the first line as the root", () => {
    const tree = parseExplainTree(rows("Seq Scan on t  (cost=0.00..1.00 rows=1 width=4)"));
    expect(tree?.arrowPos).toBe(-1);
    expect(tree?.children).toHaveLength(0);
  });

  it("nests child nodes by their arrow indentation", () => {
    const tree = parseExplainTree(
      rows(
        "Hash Join  (cost=...)",
        "  ->  Seq Scan on a  (cost=...)",
        "  ->  Hash  (cost=...)",
        "        ->  Seq Scan on b  (cost=...)",
      ),
    )!;
    expect(tree.children.map((c) => c.line.trim())).toEqual([
      "->  Seq Scan on a  (cost=...)",
      "->  Hash  (cost=...)",
    ]);
    // The deeper arrow attaches under Hash, not the root.
    const hash = tree.children[1];
    expect(hash.children).toHaveLength(1);
    expect(hash.children[0].line.trim()).toBe("->  Seq Scan on b  (cost=...)");
  });

  it("attaches attribute lines to the current node without nesting", () => {
    const tree = parseExplainTree(
      rows("Seq Scan on t  (cost=...)", "  Filter: (x > 1)"),
    )!;
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].arrowPos).toBeNull();
    expect(tree.children[0].children).toHaveLength(0);
  });
});

describe("splitNodeLine", () => {
  it("splits the operation name from the cost stats", () => {
    const { name, stats } = splitNodeLine("  ->  Index Scan using idx  (cost=0.57..2.94 rows=1 width=40)");
    expect(name).toBe("  ->  Index Scan using idx");
    expect(stats).toBe("  (cost=0.57..2.94 rows=1 width=40)");
  });

  it("splits on actual-time stats too", () => {
    const { stats } = splitNodeLine("Seq Scan  (actual time=0.1..0.2 rows=5 loops=1)");
    expect(stats).toContain("actual time=");
  });

  it("returns the whole line when there are no stats", () => {
    expect(splitNodeLine("Gather Merge")).toEqual({ name: "Gather Merge", stats: "" });
  });
});

describe("isLargeSeqScan", () => {
  it("flags seq scans estimated at >= 1000 rows", () => {
    expect(isLargeSeqScan("Seq Scan on t  (cost=0..1 rows=5000 width=4)")).toBe(true);
  });

  it("ignores small seq scans", () => {
    expect(isLargeSeqScan("Seq Scan on t  (cost=0..1 rows=10 width=4)")).toBe(false);
  });

  it("ignores non-seq-scan nodes", () => {
    expect(isLargeSeqScan("Index Scan using idx  (cost=0..1 rows=99999 width=4)")).toBe(false);
  });

  it("defaults to flagged when a seq scan has no row estimate", () => {
    expect(isLargeSeqScan("Seq Scan on t")).toBe(true);
  });
});
