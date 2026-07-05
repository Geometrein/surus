import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Filter, RefreshCw } from "lucide-react";
import { api } from "../api/client";
import { SidebarHeader } from "./SidebarPanel";
import { SearchInput } from "./SearchInput";
import { SchemaTree } from "./SchemaTree";

/**
 * The shared schema browser used by both the editor sidebar and the ERD
 * sidebar: a header (schema-visibility filter + optional refresh), a search
 * box, and the table/column tree. Schema visibility is controlled by the parent
 * so each page can back it with its own state (editor: persisted per
 * connection; ERD: the diagram's hidden-schema set).
 *
 * `search` is optional-controlled: pass `search`/`onSearchChange` to share the
 * term with something else (the ERD highlights the diagram with it); omit them
 * to let the explorer manage its own search state.
 */
export function SchemaExplorer({
  connectionId,
  hiddenSchemas,
  onToggleSchema,
  label = "TABLES",
  search: controlledSearch,
  onSearchChange,
  searchPlaceholder,
  onRefresh,
  refreshing = false,
}: {
  connectionId: string | null;
  hiddenSchemas: Set<string>;
  onToggleSchema: (name: string) => void;
  label?: string;
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const [localSearch, setLocalSearch] = useState("");
  const search = controlledSearch ?? localSearch;
  const setSearch = onSearchChange ?? setLocalSearch;

  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

  const schema = useQuery({
    queryKey: ["schema", connectionId],
    queryFn: () => api.schema(connectionId!),
    enabled: !!connectionId,
  });
  const schemaNames = (schema.data?.schemas ?? []).map((s) => s.name);

  useEffect(() => {
    if (!filterOpen) return;
    function handleClick(e: MouseEvent) {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) setFilterOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [filterOpen]);

  return (
    <div className="h-full flex flex-col min-h-0">
      <SidebarHeader label={label}>
        {schemaNames.length > 1 && (
          <div className="relative" ref={filterRef}>
            <button
              className={`p-1 rounded hover:bg-[#2c2c33] flex items-center ${filterOpen || hiddenSchemas.size > 0 ? "text-[#3b6fb5]" : "text-[#8a8a92] hover:text-white"}`}
              title="Filter schemas"
              onClick={() => setFilterOpen((o) => !o)}
            >
              <Filter size={13} />
            </button>
            {filterOpen && (
              <div className="absolute right-0 top-full mt-1 bg-[#1f1f24] border border-[#2c2c33] rounded shadow-lg z-50 min-w-[160px]">
                <div className="px-2 py-1.5 text-[10px] font-bold tracking-wide text-[#6a6a72] border-b border-[#2c2c33]">SCHEMAS</div>
                {schemaNames.map((name) => (
                  <label key={name} className="flex items-center gap-2 px-2 py-1.5 hover:bg-[#26262d] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!hiddenSchemas.has(name)}
                      onChange={() => onToggleSchema(name)}
                      className="accent-[#3b6fb5]"
                    />
                    <span className="text-[12px] text-[#c8c8d0] truncate">{name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        {onRefresh && (
          <button
            className="text-[#8a8a92] hover:text-white p-1 rounded hover:bg-[#2c2c33] disabled:opacity-40 flex items-center"
            title="Refresh schema"
            onClick={onRefresh}
            disabled={refreshing}
          >
            <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
          </button>
        )}
      </SidebarHeader>
      <SearchInput value={search} onChange={setSearch} placeholder={searchPlaceholder} />
      <div className="flex-1 overflow-auto min-h-0 px-1 pb-1">
        <SchemaTree search={search} hiddenSchemas={hiddenSchemas} />
      </div>
    </div>
  );
}
