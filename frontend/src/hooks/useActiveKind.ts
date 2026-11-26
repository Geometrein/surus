import { useQuery } from "@tanstack/react-query";
import { api, type Connection, type DatabaseKind } from "../api/client";
import { useStore } from "../store";

// The active connection, from the cached connection list.
export function useActiveConnection(): Connection | undefined {
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const conns = useQuery({ queryKey: ["connections"], queryFn: api.listConnections });
  return conns.data?.find((c) => c.id === activeConnectionId);
}

// The engine of the active connection.
export function useActiveKind(): DatabaseKind {
  return useActiveConnection()?.kind ?? "postgres";
}
