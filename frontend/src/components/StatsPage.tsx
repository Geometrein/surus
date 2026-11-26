import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Check } from "lucide-react";
import { api } from "../api/client";
import { useStore } from "../store";

/** Small hover-revealed copy affordance; flips to a check for ~1.2s on click. */
function CopyButton({ text, title }: { text: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      title={title ?? `Copy "${text}"`}
      className="opacity-0 group-hover:opacity-100 focus:opacity-100 shrink-0 text-muted hover:text-body transition-colors"
    >
      {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
    </button>
  );
}

export function StatsPage() {
  const { statsConnectionId, activeConnectionId } = useStore();
  const targetId = statsConnectionId ?? activeConnectionId;

  const conns = useQuery({ queryKey: ["connections"], queryFn: api.listConnections });
  const conn = conns.data?.find((c) => c.id === targetId);
  const isConnected = !!conn?.connected;

  // Version + extensions are captured once at connect time (served from cache),
  // so this is the only query the page needs.
  const info = useQuery({
    queryKey: ["connection-info", targetId],
    queryFn: () => api.connectionInfo(targetId!),
    enabled: !!targetId && isConnected,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  if (!targetId)
    return <div className="p-4 text-muted">Click a connection to view its stats.</div>;

  if (!isConnected)
    return <div className="p-4 text-muted">Connect to this database to load stats.</div>;

  if (!info.data && info.isLoading)
    return (
      <div className="p-4 overflow-auto h-full animate-pulse">
        <div className="flex items-center gap-3 mb-5">
          <div className="h-6 w-32 bg-line rounded" />
          <div className="h-4 w-20 bg-line rounded" />
        </div>
        <div className="h-4 w-28 bg-line rounded mb-3" />
        <div className="space-y-2 max-w-2xl">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-4 bg-panel rounded" />
          ))}
        </div>
      </div>
    );

  if (!info.data)
    return (
      <div className="p-4 text-muted">
        {info.error ? (info.error as Error).message : "Loading…"}
      </div>
    );

  return (
    <div className="p-4 overflow-auto h-full">
      {/* Header */}
      <div className="flex items-center gap-3 mb-1">
        <div className="text-lg font-semibold">{conn?.dbname}</div>
        {conn && <span className="text-xs text-muted">{conn.name}</span>}
      </div>

      <div className="group inline-flex items-center gap-1.5 text-xs text-subtle mb-6">
        {info.data.version.split(",")[0]}
        <CopyButton text={info.data.version} title="Copy full version string" />
      </div>

      <div className="max-w-2xl">
        <div className="text-sm font-semibold mb-2">Extensions ({info.data.extensions.length})</div>
        {info.data.extensions.length === 0 ? (
          <div className="text-xs text-muted">None installed.</div>
        ) : (
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-xs text-muted border-b border-line">
                <th className="pb-1.5 font-medium w-1/2">Extension</th>
                <th className="pb-1.5 font-medium">Version</th>
                <th className="pb-1.5 font-medium">Latest</th>
              </tr>
            </thead>
            <tbody>
              {info.data.extensions.map((ext) => (
                <tr key={ext.name} className="group border-b border-hover last:border-0" title={ext.comment ?? undefined}>
                  <td className="py-1.5 pr-3 font-mono text-body">
                    <span className="inline-flex items-center gap-1.5">
                      {ext.name}
                      <CopyButton text={ext.name} title={`Copy "${ext.name}"`} />
                    </span>
                  </td>
                  <td className="py-1.5 pr-3 font-mono text-body">
                    <span className="inline-flex items-center gap-1.5">
                      {ext.installed_version}
                      <CopyButton text={ext.installed_version} title={`Copy version ${ext.installed_version}`} />
                    </span>
                  </td>
                  <td className="py-1.5 font-mono">
                    {ext.update_available
                      ? <span className="text-body">{ext.default_version}</span>
                      : <span className="text-muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
