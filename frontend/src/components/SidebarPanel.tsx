import type { ReactNode } from "react";

/**
 * Standard aside wrapper used across all sidebar columns.
 * Provides the dark background, right border, and full-height flex layout.
 */
export function SidebarPanel({ children }: { children: ReactNode }) {
  return (
    <aside className="w-full h-full flex flex-col bg-[#131316] border-r border-[#2c2c33] min-h-0">
      {children}
    </aside>
  );
}

/**
 * Section header row (label + optional trailing action buttons).
 */
export function SidebarHeader({
  label,
  children,
}: {
  label: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center px-2 h-9 shrink-0 border-b border-[#2c2c33]">
      <span className="flex-1 text-[11px] font-bold tracking-wide text-[#8a8a92]">{label}</span>
      {children}
    </div>
  );
}
