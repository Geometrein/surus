import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Maximize2, ZoomIn, ZoomOut, Link2, Columns3, HardDrive } from "lucide-react";
import { api } from "../api/client";
import type { ConnectionSnapshot } from "../api/client";
import { useStore } from "../store";
import { SidebarPanel } from "./SidebarPanel";
import { SchemaExplorer } from "./SchemaExplorer";
import { formatBytes, formatCount, abbrevType } from "../utils";

// ---------------------------------------------------------------------------
// Geometry constants
// ---------------------------------------------------------------------------

const NODE_W = 210;
const HEADER_H = 40;
const ROW_H = 18;
const COL_GAP = 70;
const ROW_GAP = 34;
const PAD = 60; // canvas padding around the laid-out graph

const keyOf = (schema: string, name: string) => `${schema}.${name}`;

interface Box { x: number; y: number; w: number; h: number }

function nodeHeight(node: ConnectionSnapshot["tables"][number], showColumns: boolean): number {
  if (!showColumns) return HEADER_H;
  return HEADER_H + node.columns.length * ROW_H + 6;
}

// Masonry-ish layout: drop each node into the currently-shortest column.
function computeLayout(nodes: ConnectionSnapshot["tables"][number][], showColumns: boolean): Record<string, Box> {
  const cols = Math.max(1, Math.round(Math.sqrt(nodes.length)));
  const colHeights = new Array(cols).fill(PAD);
  const out: Record<string, Box> = {};
  for (const n of nodes) {
    let c = 0;
    for (let i = 1; i < cols; i++) if (colHeights[i] < colHeights[c]) c = i;
    const h = nodeHeight(n, showColumns);
    out[keyOf(n.schema, n.name)] = {
      x: PAD + c * (NODE_W + COL_GAP),
      y: colHeights[c],
      w: NODE_W,
      h,
    };
    colHeights[c] += h + ROW_GAP;
  }
  return out;
}

// Intersection of the center→target ray with the box border.
function borderPoint(box: Box, tx: number, ty: number) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const hw = box.w / 2;
  const hh = box.h / 2;
  const scale = Math.min(
    dx === 0 ? Infinity : hw / Math.abs(dx),
    dy === 0 ? Infinity : hh / Math.abs(dy),
  );
  return { x: cx + dx * scale, y: cy + dy * scale };
}

// ---------------------------------------------------------------------------
// Diagram page (central area)
// ---------------------------------------------------------------------------

export function SchemaDiagramPage() {
  const {
    activeConnectionId, diagramSearch, diagramHiddenSchemas, openTab,
    diagramShowColumns, setDiagramShowColumns,
    diagramOnlyRelated, setDiagramOnlyRelated,
    diagramShowSizes, setDiagramShowSizes,
  } = useStore();

  const graph = useQuery({
    queryKey: ["snapshot", activeConnectionId],
    queryFn: () => api.snapshot(activeConnectionId!),
    enabled: !!activeConnectionId,
  });

  // On-disk sizes are expensive (pg_total_relation_size stats every file), so
  // they're a separate endpoint fetched only while the "Sizes" toggle is on.
  const sizesQuery = useQuery({
    queryKey: ["snapshot-sizes", activeConnectionId],
    queryFn: () => api.tableSizes(activeConnectionId!),
    enabled: !!activeConnectionId && diagramShowSizes,
    staleTime: 5 * 60 * 1000,
  });
  const sizeByKey = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of sizesQuery.data?.sizes ?? []) m[keyOf(s.schema, s.name)] = s.sizeBytes;
    return m;
  }, [sizesQuery.data]);

  // Pan / zoom.
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  // User-dragged node overrides (cleared on reset / connection change).
  const [dragged, setDragged] = useState<Record<string, { x: number; y: number }>>({});
  const [hovered, setHovered] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Reset pan/zoom and node drags when the connection changes (render-time
  // state adjustment — React's recommended pattern over an effect).
  const [prevConn, setPrevConn] = useState(activeConnectionId);
  if (prevConn !== activeConnectionId) {
    setPrevConn(activeConnectionId);
    setDragged({});
    setView({ x: 0, y: 0, scale: 1 });
  }

  const hidden = useMemo(() => new Set(diagramHiddenSchemas), [diagramHiddenSchemas]);

  // Filter the nodes that actually get drawn.
  const visibleNodes = useMemo(() => {
    const all = graph.data?.tables ?? [];
    let nodes = all.filter((n) => !hidden.has(n.schema));
    if (diagramOnlyRelated) {
      const related = new Set<string>();
      for (const e of graph.data?.edges ?? []) {
        related.add(keyOf(e.fromSchema, e.fromTable));
        related.add(keyOf(e.toSchema, e.toTable));
      }
      nodes = nodes.filter((n) => related.has(keyOf(n.schema, n.name)));
    }
    return nodes;
  }, [graph.data, hidden, diagramOnlyRelated]);

  const visibleKeys = useMemo(
    () => new Set(visibleNodes.map((n) => keyOf(n.schema, n.name))),
    [visibleNodes],
  );

  const visibleEdges = useMemo(
    () =>
      (graph.data?.edges ?? []).filter(
        (e) =>
          visibleKeys.has(keyOf(e.fromSchema, e.fromTable)) &&
          visibleKeys.has(keyOf(e.toSchema, e.toTable)),
      ),
    [graph.data, visibleKeys],
  );

  // Base layout, recomputed when the visible set or column display changes.
  const layout = useMemo(
    () => computeLayout(visibleNodes, diagramShowColumns),
    [visibleNodes, diagramShowColumns],
  );

  const boxes = useMemo(() => {
    const out: Record<string, Box> = {};
    for (const n of visibleNodes) {
      const k = keyOf(n.schema, n.name);
      const base = layout[k];
      const ov = dragged[k];
      out[k] = ov ? { ...base, x: ov.x, y: ov.y } : base;
    }
    return out;
  }, [visibleNodes, layout, dragged]);

  // Highlight set: a node + its direct neighbours when hovered.
  const neighbours = useMemo(() => {
    if (!hovered) return null;
    const set = new Set<string>([hovered]);
    for (const e of visibleEdges) {
      const a = keyOf(e.fromSchema, e.fromTable);
      const b = keyOf(e.toSchema, e.toTable);
      if (a === hovered) set.add(b);
      if (b === hovered) set.add(a);
    }
    return set;
  }, [hovered, visibleEdges]);

  // column name → index within each node (for column-level arrow attachment)
  const colIndexMap = useMemo(() => {
    const out: Record<string, Record<string, number>> = {};
    for (const n of visibleNodes) {
      const k = keyOf(n.schema, n.name);
      out[k] = {};
      n.columns.forEach((c, i) => { out[k][c.name] = i; });
    }
    return out;
  }, [visibleNodes]);

  const term = diagramSearch.trim().toLowerCase();
  function nameMatches(n: ConnectionSnapshot["tables"][number]) {
    return !term || n.name.toLowerCase().includes(term) || n.schema.toLowerCase().includes(term);
  }

  // ── Pointer gestures (pan background / drag node) ────────────────────────
  const gesture = useRef<
    | { kind: "pan"; startX: number; startY: number; vx: number; vy: number }
    | { kind: "node"; key: string; startX: number; startY: number; bx: number; by: number }
    | null
  >(null);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const g = gesture.current;
      if (!g) return;
      if (g.kind === "pan") {
        setView((v) => ({ ...v, x: g.vx + (e.clientX - g.startX), y: g.vy + (e.clientY - g.startY) }));
      } else {
        const scale = view.scale;
        setDragged((d) => ({
          ...d,
          [g.key]: { x: g.bx + (e.clientX - g.startX) / scale, y: g.by + (e.clientY - g.startY) / scale },
        }));
      }
    }
    function onUp() { gesture.current = null; }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [view.scale]);

  function startPan(e: React.MouseEvent) {
    if (e.button !== 0) return;
    gesture.current = { kind: "pan", startX: e.clientX, startY: e.clientY, vx: view.x, vy: view.y };
  }
  function startNode(e: React.MouseEvent, k: string) {
    e.stopPropagation();
    const b = boxes[k];
    if (!b) return;
    gesture.current = { kind: "node", key: k, startX: e.clientX, startY: e.clientY, bx: b.x, by: b.y };
  }

  function onWheel(e: React.WheelEvent) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    setView((v) => {
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const scale = Math.min(2.5, Math.max(0.2, v.scale * factor));
      // keep the point under the cursor fixed
      const wx = (mx - v.x) / v.scale;
      const wy = (my - v.y) / v.scale;
      return { scale, x: mx - wx * scale, y: my - wy * scale };
    });
  }

  function zoom(factor: number) {
    setView((v) => ({ ...v, scale: Math.min(2.5, Math.max(0.2, v.scale * factor)) }));
  }
  function resetLayout() {
    setDragged({});
    setView({ x: 0, y: 0, scale: 1 });
  }

  const totalTables = graph.data?.tables.length ?? 0;
  const filtersActive = !!term || hidden.size > 0 || diagramOnlyRelated;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-[#1f1f24] border-b border-[#2c2c33] shrink-0">
        <span className="text-xs text-[#8a8a92]">⌗ Schema Diagram</span>
        {filtersActive && totalTables > 0 && (
          <span className="text-[11px] text-[#6aa3e8]">
            {visibleNodes.length} / {totalTables} tables · {visibleEdges.length} relations
          </span>
        )}
        <div className="flex-1" />
        <button
          className={`text-xs px-2 py-1 rounded flex items-center gap-1 ${diagramShowColumns ? "bg-[#1e3550] text-[#6aa3e8]" : "hover:bg-[#1d1d22] text-[#8a8a92] hover:text-white"}`}
          onClick={() => setDiagramShowColumns(!diagramShowColumns)}
          title="Show columns inside table nodes"
        >
          <Columns3 size={13} /> Columns
        </button>
        <button
          className={`text-xs px-2 py-1 rounded flex items-center gap-1 ${diagramOnlyRelated ? "bg-[#1e3550] text-[#6aa3e8]" : "hover:bg-[#1d1d22] text-[#8a8a92] hover:text-white"}`}
          onClick={() => setDiagramOnlyRelated(!diagramOnlyRelated)}
          title="Only show tables that have relationships"
        >
          <Link2 size={13} /> Only related
        </button>
        <button
          className={`text-xs px-2 py-1 rounded flex items-center gap-1 ${diagramShowSizes ? "bg-[#1e3550] text-[#6aa3e8]" : "hover:bg-[#1d1d22] text-[#8a8a92] hover:text-white"}`}
          onClick={() => setDiagramShowSizes(!diagramShowSizes)}
          title="Show on-disk table sizes (fetched on demand)"
        >
          <HardDrive size={13} className={sizesQuery.isFetching ? "animate-pulse" : ""} /> Sizes
        </button>
        <span className="w-px h-4 bg-[#2c2c33] mx-0.5" />
        <button className="text-xs px-2 py-1 rounded hover:bg-[#1d1d22] text-[#8a8a92] hover:text-white flex items-center gap-1" onClick={() => zoom(1 / 1.1)} title="Zoom out">
          <ZoomOut size={13} />
        </button>
        <span className="text-[11px] text-[#6a6a72] w-9 text-center tabular-nums">{Math.round(view.scale * 100)}%</span>
        <button className="text-xs px-2 py-1 rounded hover:bg-[#1d1d22] text-[#8a8a92] hover:text-white flex items-center gap-1" onClick={() => zoom(1.1)} title="Zoom in">
          <ZoomIn size={13} />
        </button>
        <button className="text-xs px-2 py-1 rounded hover:bg-[#1d1d22] text-[#8a8a92] hover:text-white flex items-center gap-1" onClick={resetLayout} title="Reset layout & zoom">
          <Maximize2 size={13} /> Reset
        </button>
      </div>

      <div className="flex-1 min-h-0 bg-[#0e0e11] relative overflow-hidden">
        {!activeConnectionId ? (
          <Centered>Not connected — select a connection to view its schema.</Centered>
        ) : graph.isLoading ? (
          <Centered>Loading schema…</Centered>
        ) : graph.error ? (
          <Centered className="text-red-400">{(graph.error as Error).message}</Centered>
        ) : visibleNodes.length === 0 ? (
          <Centered>{totalTables === 0 ? "No tables in this database." : "No tables match the current filters."}</Centered>
        ) : (
          <>
          <svg
            ref={svgRef}
            className="w-full h-full cursor-grab active:cursor-grabbing"
            onMouseDown={startPan}
            onWheel={onWheel}
          >
            <defs>
              <marker id="fk-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="#5a7fb5" />
              </marker>
              <marker id="fk-arrow-lit" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="#8fb6e8" />
              </marker>
            </defs>
            <g transform={`translate(${view.x},${view.y}) scale(${view.scale})`}>
              {/* edges first so nodes sit on top */}
              {visibleEdges.map((e, i) => {
                const fromKey = keyOf(e.fromSchema, e.fromTable);
                const toKey = keyOf(e.toSchema, e.toTable);
                const a = boxes[fromKey];
                const b = boxes[toKey];
                if (!a || !b) return null;
                const lit = hovered != null && (fromKey === hovered || toKey === hovered);
                const dim = (hovered != null && !lit) || (term !== "" && !lit);
                const stroke = lit ? "#8fb6e8" : "#3a4a63";
                const strokeWidth = lit ? 1.8 : 1;
                const marker = `url(#${lit ? "fk-arrow-lit" : "fk-arrow"})`;

                if (diagramShowColumns) {
                  const ac = { x: a.x + a.w / 2 };
                  const bc = { x: b.x + b.w / 2 };
                  const toRight = bc.x >= ac.x;
                  const fromIdx = colIndexMap[fromKey]?.[e.fromColumn];
                  const toIdx = colIndexMap[toKey]?.[e.toColumn];
                  const p1x = toRight ? a.x + a.w : a.x;
                  const p1y = fromIdx !== undefined
                    ? a.y + HEADER_H + fromIdx * ROW_H + ROW_H / 2
                    : a.y + a.h / 2;
                  const p2x = toRight ? b.x : b.x + b.w;
                  const p2y = toIdx !== undefined
                    ? b.y + HEADER_H + toIdx * ROW_H + ROW_H / 2
                    : b.y + b.h / 2;
                  const offset = Math.max(40, Math.abs(p2x - p1x) * 0.4);
                  const cx1 = toRight ? p1x + offset : p1x - offset;
                  const cx2 = toRight ? p2x - offset : p2x + offset;
                  return (
                    <path
                      key={i}
                      d={`M ${p1x},${p1y} C ${cx1},${p1y} ${cx2},${p2y} ${p2x},${p2y}`}
                      fill="none"
                      stroke={stroke}
                      strokeWidth={strokeWidth}
                      strokeOpacity={dim ? 0.18 : 1}
                      markerEnd={marker}
                    />
                  );
                }

                const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
                const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
                const p1 = borderPoint(a, bc.x, bc.y);
                const p2 = borderPoint(b, ac.x, ac.y);
                return (
                  <line
                    key={i}
                    x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
                    stroke={stroke}
                    strokeWidth={strokeWidth}
                    strokeOpacity={dim ? 0.18 : 1}
                    markerEnd={marker}
                  />
                );
              })}

              {/* nodes */}
              {visibleNodes.map((n) => {
                const k = keyOf(n.schema, n.name);
                const b = boxes[k];
                if (!b) return null;
                const matched = nameMatches(n);
                const inHover = !neighbours || neighbours.has(k);
                const dim = (!matched && term !== "") || !inHover;
                return (
                  <g
                    key={k}
                    transform={`translate(${b.x},${b.y})`}
                    opacity={dim ? 0.28 : 1}
                    className="cursor-pointer"
                    onMouseDown={(e) => startNode(e, k)}
                    onMouseEnter={() => setHovered(k)}
                    onMouseLeave={() => setHovered((h) => (h === k ? null : h))}
                    onDoubleClick={() =>
                      openTab(n.name, `SELECT *\nFROM "${n.schema}"."${n.name}"\nLIMIT 10;`, true, `table:${n.schema}.${n.name}`)
                    }
                  >
                    <rect
                      width={b.w} height={b.h} rx={6}
                      fill="#181820"
                      stroke={term !== "" && matched ? "#3b6fb5" : "#2c2c3a"}
                      strokeWidth={term !== "" && matched ? 1.6 : 1}
                    />
                    <rect width={b.w} height={HEADER_H} rx={6} fill="#22293a" />
                    <rect y={HEADER_H - 6} width={b.w} height={6} fill="#22293a" />
                    <text x={10} y={14} fontSize={12} fontWeight={600} fill="#cdd6e8">
                      {n.name.length > 26 ? n.name.slice(0, 25) + "…" : n.name}
                    </text>
                    <text x={b.w - 8} y={14} fontSize={9} fill="#6a7488" textAnchor="end">
                      {n.schema}
                    </text>
                    <text x={10} y={28} fontSize={9} fill="#4a5a72">
                      {formatCount(n.rowEstimate)} rows
                    </text>
                    {diagramShowSizes && sizeByKey[k] != null && (
                      <text x={b.w - 8} y={28} fontSize={9} fill="#4a5a72" textAnchor="end">
                        {formatBytes(sizeByKey[k])}
                      </text>
                    )}
                    {diagramShowColumns &&
                      n.columns.map((c, ci) => (
                        <g key={c.name}>
                          {ci > 0 && (
                            <line x1={0} x2={b.w} y1={HEADER_H + ci * ROW_H} y2={HEADER_H + ci * ROW_H} stroke="#2c2c3a" strokeWidth={0.5} />
                          )}
                          {c.isFk && (
                            <g transform={`translate(12, ${HEADER_H + ci * ROW_H + 3}) scale(0.46)`}>
                              <path d="M9 17H7A5 5 0 0 1 7 7h2" fill="none" stroke="#86c5a8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                              <path d="M15 7h2a5 5 0 1 1 0 10h-2" fill="none" stroke="#86c5a8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                              <line x1="11" x2="13" y1="12" y2="12" stroke="#86c5a8" strokeWidth="2.5" strokeLinecap="round" />
                            </g>
                          )}
                          <text
                            x={c.isFk ? 25 : 12}
                            y={HEADER_H + ci * ROW_H + 13}
                            fontSize={11}
                            fill={c.isFk ? "#86c5a8" : "#8a8a98"}
                            fontFamily="ui-monospace, monospace"
                          >
                            {c.name.length > 16 ? c.name.slice(0, 15) + "…" : c.name}
                          </text>
                          <text
                            x={b.w - 6}
                            y={HEADER_H + ci * ROW_H + 13}
                            fontSize={10}
                            fill="#4a5a72"
                            fontFamily="ui-monospace, monospace"
                            textAnchor="end"
                          >
                            {abbrevType(c.type)}
                          </text>
                        </g>
                      ))}
                  </g>
                );
              })}
            </g>
          </svg>
          <DiagramLegend />
          </>
        )}
      </div>
    </div>
  );
}

function Centered({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`absolute inset-0 flex items-center justify-center text-xs text-[#6a6a72] ${className}`}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diagram sidebar (filters)
// ---------------------------------------------------------------------------

export function SchemaDiagramSidebar() {
  const {
    activeConnectionId,
    diagramSearch, setDiagramSearch,
    diagramHiddenSchemas, setDiagramHiddenSchemas,
  } = useStore();
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const hidden = useMemo(() => new Set(diagramHiddenSchemas), [diagramHiddenSchemas]);
  function toggleSchema(name: string) {
    const next = new Set(hidden);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setDiagramHiddenSchemas([...next]);
  }

  async function refresh() {
    if (!activeConnectionId || refreshing) return;
    setRefreshing(true);
    try {
      await api.refreshSchema(activeConnectionId);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["schema", activeConnectionId] }),
        qc.invalidateQueries({ queryKey: ["snapshot", activeConnectionId] }),
      ]);
    } finally {
      setRefreshing(false);
    }
  }

  // Identical schema explorer to the editor sidebar; its search also highlights
  // the diagram (shared diagramSearch state). The diagram's view options live on
  // the canvas toolbar and the legend floats over the canvas.
  return (
    <SidebarPanel>
      <SchemaExplorer
        connectionId={activeConnectionId}
        hiddenSchemas={hidden}
        onToggleSchema={toggleSchema}
        search={diagramSearch}
        onSearchChange={setDiagramSearch}
        searchPlaceholder="Search tables…"
        onRefresh={refresh}
        refreshing={refreshing}
      />
    </SidebarPanel>
  );
}

// Floating key, pinned to the diagram's bottom-right corner. Non-interactive so
// it never blocks panning or node dragging underneath.
function DiagramLegend() {
  return (
    <div className="absolute bottom-3 right-3 bg-[#161619]/90 backdrop-blur-sm border border-[#2c2c33] rounded-lg px-3 py-2 shadow-lg pointer-events-none">
      <div className="space-y-1 text-[11px] text-[#8a8a92]">
        <div className="flex items-center gap-2"><Link2 size={12} className="text-[#86c5a8] shrink-0" /> Foreign-key column</div>
        <div className="flex items-center gap-2">
          <svg width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" stroke="#5a7fb5" strokeWidth="1.5" /></svg>
          Relationship → referenced table
        </div>
        <div className="flex items-center gap-1.5 pt-1 mt-0.5 border-t border-[#2c2c33] text-[#6a6a72]">
          <RefreshCw size={11} /> drag tables · scroll to zoom · double-click to preview
        </div>
      </div>
    </div>
  );
}
