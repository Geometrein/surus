import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

// Whether AI features are on (Settings → Agent). On until the settings load, so
// a first paint never flashes the AI-free layout for people who use the agent.
export function useAiEnabled(): boolean {
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.getSettings });
  return settings.data?.aiEnabled ?? true;
}
