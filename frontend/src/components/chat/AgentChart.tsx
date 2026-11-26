// Renders a chart the agent asked for via the render_chart tool. The tool_call
// carries only a spec (SQL + column→axis mapping); we run the SQL read-only and
// draw it with recharts — the same library the editor's chart tab uses.
import { useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import {
  ResponsiveContainer, CartesianGrid, XAxis, YAxis, Tooltip, Legend,
  LineChart, Line, BarChart, Bar, AreaChart, Area, ScatterChart, Scatter, PieChart, Pie, Cell,
} from "recharts";
import { api, type QueryResult } from "../../api/client";
import { formatCount } from "../../utils";
import { chartColor, chartTooltipStyle, color } from "../../lib/theme";
import { useTheme } from "../../hooks/useTheme";
import type { ChartSpec } from "./shared";

// Cap the rows we pull for a chart — the agent is told to pre-aggregate, and a
// chart with thousands of points is unreadable anyway.
const MAX_ROWS = 2000;

function toNum(v: unknown): number {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

// Pivot a QueryResult into recharts rows + the series keys to draw. With a
// `series` column, distinct values become series; otherwise each y column is one.
function buildSeries(result: QueryResult, spec: ChartSpec): { data: Record<string, unknown>[]; keys: string[] } {
  const xi = result.columns.indexOf(spec.x);
  if (xi < 0) return { data: [], keys: [] };

  if (spec.series) {
    const si = result.columns.indexOf(spec.series);
    const yi = result.columns.indexOf(spec.y[0]);
    if (si < 0 || yi < 0) return { data: [], keys: [] };
    const byX = new Map<string, Record<string, unknown>>();
    const keys: string[] = [];
    for (const row of result.rows) {
      const xv = row[xi] == null ? "" : String(row[xi]);
      const sv = row[si] == null ? "—" : String(row[si]);
      if (!keys.includes(sv)) keys.push(sv);
      const rec = byX.get(xv) ?? { x: xv };
      rec[sv] = toNum(row[yi]);
      byX.set(xv, rec);
    }
    return { data: [...byX.values()], keys };
  }

  const ys = spec.y.map((c) => [c, result.columns.indexOf(c)] as const).filter(([, i]) => i >= 0);
  const data = result.rows.map((row) => {
    const rec: Record<string, unknown> = { x: row[xi] == null ? "" : String(row[xi]) };
    for (const [c, i] of ys) rec[c] = toNum(row[i]);
    return rec;
  });
  return { data, keys: ys.map(([c]) => c) };
}

export function AgentChart({ connectionId, sql, spec }: { connectionId: string | null; sql: string; spec: ChartSpec }) {
  useTheme();
  const q = useQuery({
    queryKey: ["agent-chart", connectionId, sql],
    queryFn: () => api.runQuery(connectionId!, sql, MAX_ROWS),
    enabled: !!connectionId,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const built = useMemo(() => (q.data ? buildSeries(q.data, spec) : { data: [], keys: [] }), [q.data, spec]);

  const chartRef = useRef<HTMLDivElement>(null);
  // Rasterize the rendered SVG to a PNG (on a dark background) and download it —
  // the same approach the editor's chart tab uses.
  async function exportPng() {
    const svg = chartRef.current?.querySelector("svg");
    if (!svg) return;
    const { width, height } = svg.getBoundingClientRect();
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }));
    const img = new Image();
    img.src = url;
    await new Promise((r) => { img.onload = r; });
    const scale = window.devicePixelRatio || 2;
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(scale, scale);
    ctx.fillStyle = color("panel");
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    URL.revokeObjectURL(url);
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `${(spec.title || "chart").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${Date.now()}.png`;
    a.click();
  }

  const body = (() => {
    if (q.isLoading) return <Placeholder text="Drawing chart…" />;
    if (q.error) return <Placeholder text={`Chart failed: ${(q.error as Error).message}`} error />;
    if (!q.data || q.data.rows.length === 0) return <Placeholder text="No rows to chart." />;

    if (spec.chartType === "pie") {
      const xi = q.data.columns.indexOf(spec.x);
      const yi = q.data.columns.indexOf(spec.y[0]);
      const pie = xi >= 0 && yi >= 0
        ? q.data.rows.map((r) => ({ name: r[xi] == null ? "" : String(r[xi]), value: toNum(r[yi]) }))
        : [];
      if (!pie.length) return <Placeholder text="Chart columns not found in the result." error />;
      return (
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={pie} dataKey="value" nameKey="name" outerRadius="80%" label>
              {pie.map((_, i) => <Cell key={i} fill={chartColor(i)} />)}
            </Pie>
            <Tooltip {...chartTooltipStyle()} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
          </PieChart>
        </ResponsiveContainer>
      );
    }

    if (spec.chartType === "scatter") {
      const xi = q.data.columns.indexOf(spec.x);
      const yi = q.data.columns.indexOf(spec.y[0]);
      const pts = xi >= 0 && yi >= 0 ? q.data.rows.map((r) => ({ x: toNum(r[xi]), y: toNum(r[yi]) })) : [];
      return (
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
            <CartesianGrid stroke={color("line")} />
            <XAxis type="number" dataKey="x" name={spec.x} tick={{ fontSize: 11, fill: color("subtle") }} stroke={color("line-strong")} />
            <YAxis type="number" dataKey="y" name={spec.y[0]} tick={{ fontSize: 11, fill: color("subtle") }} stroke={color("line-strong")} tickFormatter={(v) => formatCount(Number(v))} />
            <Tooltip {...chartTooltipStyle()} cursor={{ stroke: color("line-strong") }} />
            <Scatter data={pts} fill={chartColor(0)} />
          </ScatterChart>
        </ResponsiveContainer>
      );
    }

    const { data, keys } = built;
    if (!data.length || !keys.length) return <Placeholder text="Chart columns not found in the result." error />;
    const common = (
      <>
        <CartesianGrid stroke={color("line")} vertical={false} />
        <XAxis dataKey="x" tick={{ fontSize: 11, fill: color("subtle") }} stroke={color("line-strong")} />
        <YAxis tick={{ fontSize: 11, fill: color("subtle") }} stroke={color("line-strong")} tickFormatter={(v) => formatCount(Number(v))} />
        <Tooltip {...chartTooltipStyle()} cursor={{ fill: "#ffffff08" }} />
        {keys.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
      </>
    );
    if (spec.chartType === "bar")
      return (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
            {common}
            {keys.map((k, i) => <Bar key={k} dataKey={k} fill={chartColor(i)} />)}
          </BarChart>
        </ResponsiveContainer>
      );
    if (spec.chartType === "area")
      return (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
            {common}
            {keys.map((k, i) => (
              <Area key={k} dataKey={k} stroke={chartColor(i)} fill={chartColor(i)} fillOpacity={0.25} />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      );
    return (
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
          {common}
          {keys.map((k, i) => <Line key={k} dataKey={k} stroke={chartColor(i)} dot={false} strokeWidth={2} />)}
        </LineChart>
      </ResponsiveContainer>
    );
  })();

  return (
    <div className="group/chart mt-1 bg-panel border border-line rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 pt-2">
        <span className="flex-1 text-xs font-medium text-body truncate">{spec.title ?? ""}</span>
        <button
          className="shrink-0 flex items-center gap-1 text-[11px] text-muted hover:text-body opacity-0 group-hover/chart:opacity-100 transition-opacity disabled:opacity-30"
          title="Export as PNG"
          onClick={exportPng}
          disabled={!q.data || q.data.rows.length === 0}
        >
          <Download size={12} /> PNG
        </button>
      </div>
      <div ref={chartRef} className="h-64 p-2">{body}</div>
    </div>
  );
}


function Placeholder({ text, error }: { text: string; error?: boolean }) {
  return (
    <div className={`h-full flex items-center justify-center text-xs ${error ? "text-red-400" : "text-muted"}`}>
      {text}
    </div>
  );
}
