import { useMemo, useRef, useState } from "react";
import {
  BarChart, Bar, LineChart, Line, ScatterChart, Scatter,
  PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import type { QueryResult } from "../api/client";
import { formatCount } from "../utils";

type ChartType = "bar" | "line" | "scatter" | "pie";
type AggFunc  = "none" | "sum" | "avg" | "count" | "min" | "max";

const PALETTE = [
  "#6aa3e8", "#ae84cb", "#52a06a", "#e88c6a",
  "#e8c86a", "#6ae8d4", "#e86a9c", "#a0c0e8",
];

// ── helpers ────────────────────────────────────────────────────────────────

function isNum(v: unknown): boolean {
  return v !== null && v !== undefined && v !== "" && !isNaN(Number(v));
}

function agg(values: number[], fn: AggFunc): number {
  if (!values.length) return 0;
  switch (fn) {
    case "none":  return values[values.length - 1]; // last value (raw)
    case "sum":   return values.reduce((a, b) => a + b, 0);
    case "avg":   return values.reduce((a, b) => a + b, 0) / values.length;
    case "count": return values.length;
    case "min":   return Math.min(...values);
    case "max":   return Math.max(...values);
  }
}

function fmt(v: unknown): string {
  const n = Number(v);
  if (isNaN(n)) return String(v);
  return formatCount(n);
}

// ── X-tick date formatting ──────────────────────────────────────────────────

function smartDateFmt(raw: string): string {
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw;
  // yyyy-MM  → "Jan '24"
  if (/^\d{4}-\d{2}$/.test(raw))
    return d.toLocaleDateString("en", { month: "short", year: "2-digit" });
  // yyyy-MM-dd  → "Jan 15"
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw))
    return d.toLocaleDateString("en", { month: "short", day: "numeric" });
  // has a time component → "Jan 15 14:30"
  if (/T|^\d{4}-\d{2}-\d{2} \d/.test(raw))
    return (
      d.toLocaleDateString("en", { month: "short", day: "numeric" }) +
      " " +
      d.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hour12: false })
    );
  return raw;
}

function makeDateFormatter(xValues: string[]): ((v: string) => string) | null {
  const sample = xValues.slice(0, 10).filter(Boolean);
  if (!sample.length) return null;
  const allDates = sample.every((v) => {
    if (/^\d{4}$/.test(v)) return false; // bare year — not worth formatting
    const d = new Date(v);
    return !isNaN(d.getTime());
  });
  return allDates ? smartDateFmt : null;
}

// ── data builders ──────────────────────────────────────────────────────────

function buildBarLine(
  columns: string[], rows: unknown[][],
  xCol: string, yCol: string, groupCol: string | null, fn: AggFunc,
): { data: Record<string, unknown>[]; series: string[] } {
  const xi = columns.indexOf(xCol);
  const yi = columns.indexOf(yCol);
  const gi = groupCol ? columns.indexOf(groupCol) : -1;
  if (xi < 0 || yi < 0) return { data: [], series: [] };

  const sample = rows.slice(0, 5000);

  if (gi < 0) {
    const map = new Map<string, number[]>();
    for (const row of sample) {
      const x = String(row[xi] ?? "—");
      const y = Number(row[yi]);
      if (!isNaN(y)) { const a = map.get(x) ?? []; a.push(y); map.set(x, a); }
    }
    return {
      data: [...map.entries()].map(([x, ys]) => ({ x, [yCol]: +agg(ys, fn).toFixed(4) })),
      series: [yCol],
    };
  }

  const seriesOrder: string[] = [];
  const seriesSet = new Set<string>();
  const map = new Map<string, Map<string, number[]>>();
  for (const row of sample) {
    const x = String(row[xi] ?? "—");
    const g = String(row[gi] ?? "—");
    const y = Number(row[yi]);
    if (!seriesSet.has(g)) { seriesSet.add(g); seriesOrder.push(g); }
    if (!isNaN(y)) {
      const xm = map.get(x) ?? new Map<string, number[]>();
      const a = xm.get(g) ?? []; a.push(y); xm.set(g, a); map.set(x, xm);
    }
  }
  const series = seriesOrder.slice(0, 12);
  return {
    data: [...map.entries()].map(([x, gm]) => {
      const e: Record<string, unknown> = { x };
      for (const g of series) e[g] = +agg(gm.get(g) ?? [], fn).toFixed(4);
      return e;
    }),
    series,
  };
}

// Aggregate a single column by X for the second Y axis.
function buildY2Map(
  columns: string[], rows: unknown[][],
  xCol: string, y2Col: string, fn: AggFunc,
): Map<string, number> {
  const xi = columns.indexOf(xCol);
  const yi = columns.indexOf(y2Col);
  if (xi < 0 || yi < 0) return new Map();
  const acc = new Map<string, number[]>();
  for (const row of rows.slice(0, 5000)) {
    const x = String(row[xi] ?? "—");
    const y = Number(row[yi]);
    if (!isNaN(y)) { const a = acc.get(x) ?? []; a.push(y); acc.set(x, a); }
  }
  const result = new Map<string, number>();
  for (const [x, ys] of acc) result.set(x, +agg(ys, fn).toFixed(4));
  return result;
}

function buildScatter(
  columns: string[], rows: unknown[][],
  xCol: string, yCol: string, groupCol: string | null,
): { name: string; data: { x: number; y: number }[] }[] {
  const xi = columns.indexOf(xCol);
  const yi = columns.indexOf(yCol);
  const gi = groupCol ? columns.indexOf(groupCol) : -1;
  const sample = rows.slice(0, 3000).filter((r) => isNum(r[xi]) && isNum(r[yi]));

  if (gi < 0) {
    return [{ name: yCol, data: sample.map((r) => ({ x: Number(r[xi]), y: Number(r[yi]) })) }];
  }
  const groups = new Map<string, { x: number; y: number }[]>();
  for (const row of sample) {
    const g = String(row[gi] ?? "—");
    const pts = groups.get(g) ?? []; pts.push({ x: Number(row[xi]), y: Number(row[yi]) }); groups.set(g, pts);
  }
  return [...groups.entries()].slice(0, 8).map(([name, data]) => ({ name, data }));
}

function buildPie(
  columns: string[], rows: unknown[][],
  xCol: string, yCol: string, fn: AggFunc,
): { name: string; value: number }[] {
  const xi = columns.indexOf(xCol);
  const yi = columns.indexOf(yCol);
  if (xi < 0 || yi < 0) return [];
  const map = new Map<string, number[]>();
  for (const row of rows.slice(0, 3000)) {
    const x = String(row[xi] ?? "—");
    const y = Number(row[yi]);
    if (!isNaN(y)) { const a = map.get(x) ?? []; a.push(y); map.set(x, a); }
  }
  return [...map.entries()]
    .map(([name, vals]) => ({ name, value: +agg(vals, fn).toFixed(4) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 20);
}

// ── component ──────────────────────────────────────────────────────────────

const TOOLTIP_STYLE = {
  contentStyle: { background: "#1f1f24", border: "1px solid #2c2c33", borderRadius: 6, fontSize: 12 },
  labelStyle: { color: "#c8c8d0" },
};

const AXIS_TICK  = { fill: "#6a6a72", fontSize: 11 };
const AXIS_LABEL = { fill: "#6a6a72", fontSize: 10 };

export function ChartView({ result }: { result: QueryResult }) {
  const { columns, rows } = result;
  const [chartType, setChartType] = useState<ChartType>("line");
  const [xCol,    setXCol]    = useState("");
  const [yCol,    setYCol]    = useState("");
  const [y2Col,    setY2Col]    = useState("");
  const [groupBy,  setGroupBy]  = useState("");
  const [fn,       setFn]       = useState<AggFunc>("none");
  const [dualAxis, setDualAxis] = useState(false);
  const [logLeft,  setLogLeft]  = useState(false);
  const [logRight, setLogRight] = useState(false);

  // Reset axes when a new result comes in — adjusted during render (rather than
  // in an effect) so the fresh columns render without an extra pass.
  const colsKey = columns.join(",");
  const [prevColsKey, setPrevColsKey] = useState(colsKey);
  if (colsKey !== prevColsKey) {
    setPrevColsKey(colsKey);
    setXCol("");
    setYCol("");
    setY2Col("");
    setGroupBy("");
    setFn("none");
    setDualAxis(false);
    setLogLeft(false);
    setLogRight(false);
  }

  const groupCol   = groupBy || null;
  const y2Active   = !!(y2Col && (chartType === "bar" || chartType === "line") && !groupCol);
  const rightAxisActive = y2Active && dualAxis;

  const { data: rawData, series } = useMemo(
    () => chartType === "scatter" || chartType === "pie"
      ? { data: [], series: [] }
      : buildBarLine(columns, rows, xCol, yCol, groupCol, fn),
    [columns, rows, xCol, yCol, groupCol, fn, chartType],
  );

  // Merge Y2 values into data when active.
  const data = useMemo(() => {
    if (!y2Active || !y2Col) return rawData;
    const y2map = buildY2Map(columns, rows, xCol, y2Col, fn);
    return rawData.map((d) => ({ ...d, __y2: y2map.get(String(d.x)) ?? 0 }));
  }, [rawData, y2Active, y2Col, columns, rows, xCol, fn]);

  const scatterSeries = useMemo(
    () => chartType === "scatter" ? buildScatter(columns, rows, xCol, yCol, groupCol) : [],
    [columns, rows, xCol, yCol, groupCol, chartType],
  );

  const pieData = useMemo(
    () => chartType === "pie" ? buildPie(columns, rows, xCol, yCol, fn) : [],
    [columns, rows, xCol, yCol, fn, chartType],
  );

  // X tick date auto-formatter.
  const xFormatter = useMemo(
    () => makeDateFormatter(data.map((d) => String((d as Record<string, unknown>).x))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.length, xCol],
  );

  const empty = chartType === "scatter" ? scatterSeries.every((s) => !s.data.length)
    : chartType === "pie" ? !pieData.length
    : !data.length;

  const chartRef = useRef<HTMLDivElement>(null);

  async function exportPng() {
    const svg = chartRef.current?.querySelector("svg");
    if (!svg) return;
    const { width, height } = svg.getBoundingClientRect();
    const xml  = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([xml], { type: "image/svg+xml" });
    const url  = URL.createObjectURL(blob);
    const img  = new Image();
    img.src = url;
    await new Promise((r) => { img.onload = r; });
    const canvas = document.createElement("canvas");
    const scale  = window.devicePixelRatio ?? 2;
    canvas.width  = width  * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(scale, scale);
    ctx.fillStyle = "#161619";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    URL.revokeObjectURL(url);
    const a = document.createElement("a");
    a.href     = canvas.toDataURL("image/png");
    a.download = `chart-${Date.now()}.png`;
    a.click();
  }

  const selCls   = "bg-[#1e3550] text-[#6aa3e8] border-[#2a4a6a]";
  const unselCls = "text-[#8a8a92] hover:text-white border-[#2c2c33]";
  const dropCls  = "bg-[#131316] border border-[#2c2c33] rounded px-2 py-1 text-xs text-[#c8c8d0] outline-none focus:border-[#3b6fb5]";

  const rightMargin = rightAxisActive ? 64 : 16;

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#161619]">
      {/* ── Controls ── */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[#2c2c33] bg-[#1f1f24] shrink-0 flex-wrap">
        {/* Chart type pills */}
        <div className="flex rounded overflow-hidden border border-[#2c2c33]">
          {(["line", "bar", "scatter", "pie"] as ChartType[]).map((t) => (
            <button key={t} onClick={() => setChartType(t)}
              className={`px-3 py-1 text-xs capitalize transition-colors border-r border-[#2c2c33] last:border-r-0 ${chartType === t ? selCls : unselCls}`}>
              {t}
            </button>
          ))}
        </div>

        <div className="w-px h-4 bg-[#2c2c33]" />

        <label className="flex items-center gap-1.5 text-[11px] text-[#6a6a72]">
          X
          <select value={xCol} onChange={(e) => setXCol(e.target.value)} className={dropCls}>
            <option value="">—</option>
            {columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>

        <label className="flex items-center gap-1.5 text-[11px] text-[#6a6a72]">
          Y
          <select value={yCol} onChange={(e) => setYCol(e.target.value)} className={dropCls}>
            <option value="">—</option>
            {columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>

        {/* Y2 — only bar/line without groupBy */}
        {(chartType === "bar" || chartType === "line") && !groupCol && (
          <label className="flex items-center gap-1.5 text-[11px] text-[#6a6a72]">
            Y2
            <select value={y2Col} onChange={(e) => { setY2Col(e.target.value); if (!e.target.value) setDualAxis(false); }} className={dropCls}>
              <option value="">—</option>
              {columns.filter((c) => c !== xCol && c !== yCol).map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
        )}

        {/* Dual axis checkbox — only when Y2 is selected */}
        {y2Active && (
          <label className="flex items-center gap-1.5 text-[11px] text-[#6a6a72] cursor-pointer select-none">
            <input type="checkbox" checked={dualAxis} onChange={(e) => setDualAxis(e.target.checked)}
              className="accent-[#3b6fb5]" />
            dual axis
          </label>
        )}

        {chartType !== "scatter" && (
          <label className="flex items-center gap-1.5 text-[11px] text-[#6a6a72]">
            Agg
            <select value={fn} onChange={(e) => setFn(e.target.value as AggFunc)} className={dropCls}>
              {(["none", "sum", "avg", "count", "min", "max"] as AggFunc[]).map((a) => (
                <option key={a} value={a}>{a === "none" ? "—" : a}</option>
              ))}
            </select>
          </label>
        )}

        {chartType !== "pie" && (
          <label className="flex items-center gap-1.5 text-[11px] text-[#6a6a72]">
            Group by
            <select value={groupBy} onChange={(e) => { setGroupBy(e.target.value); setY2Col(""); }} className={dropCls}>
              <option value="">—</option>
              {columns.filter((c) => c !== xCol && c !== yCol).map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
        )}

        {/* Per-axis log scale — bar/line/scatter only */}
        {chartType !== "pie" && (
          <label className="flex items-center gap-1.5 text-[11px] text-[#6a6a72] cursor-pointer select-none">
            <input type="checkbox" checked={logLeft} onChange={(e) => setLogLeft(e.target.checked)}
              className="accent-[#3b6fb5]" />
            {rightAxisActive ? "log L" : "log Y"}
          </label>
        )}
        {rightAxisActive && (
          <label className="flex items-center gap-1.5 text-[11px] text-[#6a6a72] cursor-pointer select-none">
            <input type="checkbox" checked={logRight} onChange={(e) => setLogRight(e.target.checked)}
              className="accent-[#3b6fb5]" />
            log R
          </label>
        )}

        {/* Show badge when date auto-format is active */}
        {xFormatter && (
          <span className="text-[10px] text-[#6a6a72] border border-[#2c2c33] rounded px-1.5 py-0.5">
            date axis
          </span>
        )}

        <div className="ml-auto">
          <button onClick={exportPng} disabled={empty}
            className="px-2.5 py-1 rounded text-xs text-[#a0a0a8] hover:bg-[#26262d] disabled:opacity-40 flex items-center gap-1.5 border border-[#2c2c33]"
            title="Export chart as PNG">
            ↓ PNG
          </button>
        </div>
      </div>

      {/* ── Chart ── */}
      <div ref={chartRef} className="flex-1 min-h-0 p-4">
        {empty ? (
          <div className="h-full flex items-center justify-center text-sm text-[#6a6a72]">
            No numeric data to chart — adjust the axis selections above.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            {chartType === "bar" ? (
              <BarChart data={data} margin={{ top: 4, right: rightMargin, bottom: 52, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2c2c33" />
                <XAxis dataKey="x" tick={AXIS_TICK} angle={-35} textAnchor="end" interval="preserveStartEnd"
                  tickFormatter={xFormatter ?? undefined} />
                <YAxis yAxisId="left" tick={AXIS_TICK} tickFormatter={fmt} width={68}
                  scale={logLeft ? "log" : "auto"} allowDataOverflow={logLeft}
                  domain={logLeft ? [(d: number) => (d > 0 ? d : 1), "auto"] : undefined}
                  label={{ ...AXIS_LABEL, value: yCol, angle: -90, position: "insideLeft" }} />
                {rightAxisActive && (
                  <YAxis yAxisId="right" orientation="right" tick={AXIS_TICK} tickFormatter={fmt} width={68}
                    scale={logRight ? "log" : "auto"} allowDataOverflow={logRight}
                    domain={logRight ? [(d: number) => (d > 0 ? d : 1), "auto"] : undefined}
                    label={{ ...AXIS_LABEL, value: y2Col, angle: 90, position: "insideRight" }} />
                )}
                <Tooltip {...TOOLTIP_STYLE} formatter={(v) => [fmt(v), ""]} />
                {(series.length > 1 || y2Active) && <Legend verticalAlign="top" wrapperStyle={{ fontSize: 11, color: "#8a8a92", paddingBottom: 8 }} />}
                {series.map((s, i) => (
                  <Bar key={s} yAxisId="left" dataKey={s} fill={PALETTE[i % PALETTE.length]} radius={[2, 2, 0, 0]} maxBarSize={48} />
                ))}
                {y2Active && (
                  <Bar yAxisId={rightAxisActive ? "right" : "left"} dataKey="__y2" name={y2Col}
                    fill={PALETTE[series.length % PALETTE.length]}
                    radius={[2, 2, 0, 0]} maxBarSize={48} opacity={0.75} />
                )}
              </BarChart>
            ) : chartType === "line" ? (
              <LineChart data={data} margin={{ top: 4, right: rightMargin, bottom: 52, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2c2c33" />
                <XAxis dataKey="x" tick={AXIS_TICK} angle={-35} textAnchor="end" interval="preserveStartEnd"
                  tickFormatter={xFormatter ?? undefined} />
                <YAxis yAxisId="left" tick={AXIS_TICK} tickFormatter={fmt} width={68}
                  scale={logLeft ? "log" : "auto"} allowDataOverflow={logLeft}
                  domain={logLeft ? [(d: number) => (d > 0 ? d : 1), "auto"] : undefined}
                  label={{ ...AXIS_LABEL, value: yCol, angle: -90, position: "insideLeft" }} />
                {rightAxisActive && (
                  <YAxis yAxisId="right" orientation="right" tick={AXIS_TICK} tickFormatter={fmt} width={68}
                    scale={logRight ? "log" : "auto"} allowDataOverflow={logRight}
                    domain={logRight ? [(d: number) => (d > 0 ? d : 1), "auto"] : undefined}
                    label={{ ...AXIS_LABEL, value: y2Col, angle: 90, position: "insideRight" }} />
                )}
                <Tooltip {...TOOLTIP_STYLE} formatter={(v) => [fmt(v), ""]} />
                {(series.length > 1 || y2Active) && <Legend verticalAlign="top" wrapperStyle={{ fontSize: 11, color: "#8a8a92", paddingBottom: 8 }} />}
                {series.map((s, i) => (
                  <Line key={s} yAxisId="left" dataKey={s} stroke={PALETTE[i % PALETTE.length]} strokeWidth={2} dot={data.length < 80} />
                ))}
                {y2Active && (
                  <Line yAxisId={rightAxisActive ? "right" : "left"} dataKey="__y2" name={y2Col}
                    stroke={PALETTE[series.length % PALETTE.length]} strokeWidth={2}
                    strokeDasharray="5 3" dot={data.length < 80} />
                )}
              </LineChart>
            ) : chartType === "scatter" ? (
              <ScatterChart margin={{ top: 4, right: 16, bottom: 28, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2c2c33" />
                <XAxis dataKey="x" type="number" name={xCol} tick={AXIS_TICK} tickFormatter={fmt} />
                <YAxis dataKey="y" type="number" name={yCol} tick={AXIS_TICK} tickFormatter={fmt} width={68}
                  scale={logLeft ? "log" : "auto"} allowDataOverflow={logLeft}
                  domain={logLeft ? [(d: number) => (d > 0 ? d : 1), "auto"] : undefined}
                  label={{ ...AXIS_LABEL, value: yCol, angle: -90, position: "insideLeft" }} />
                <Tooltip {...TOOLTIP_STYLE} cursor={{ strokeDasharray: "3 3" }} formatter={(v) => [fmt(v), ""]} />
                {scatterSeries.length > 1 && <Legend wrapperStyle={{ fontSize: 11, color: "#8a8a92" }} />}
                {scatterSeries.map((s, i) => (
                  <Scatter key={s.name} name={s.name} data={s.data} fill={PALETTE[i % PALETTE.length]} opacity={0.7} />
                ))}
              </ScatterChart>
            ) : (
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius="70%"
                  label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(1)}%`}
                  labelLine={{ stroke: "#6a6a72" }}>
                  {pieData.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                </Pie>
                <Tooltip {...TOOLTIP_STYLE} formatter={(v) => [fmt(v), ""]} />
                <Legend wrapperStyle={{ fontSize: 11, color: "#8a8a92" }} />
              </PieChart>
            )}
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
