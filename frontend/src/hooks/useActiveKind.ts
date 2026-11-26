import { useQuery } from "@tanstack/react-query";
import { api, type DatabaseKind } from "../api/client";
import { useStore } from "../store";

// The engine of the active connection, from the cached connection list.
export function useActiveKind(): DatabaseKind {
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const conns = useQuery({ queryKey: ["connections"], queryFn: api.listConnections });
  return conns.data?.find((c) => c.id === activeConnectionId)?.kind ?? "postgres";
}
