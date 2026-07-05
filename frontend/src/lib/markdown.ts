// Pure helpers for rendering the agent's markdown replies. Kept out of the
// component module so they can be unit-tested and stay fast-refresh friendly.

/** Ensure a fenced code block always starts on its own line. */
export function normalizeMd(text: string): string {
  return text.replace(/([^\n])(```)/g, "$1\n$2");
}

/** Extract the contents of every ```sql fenced block, trimmed. */
export function extractSqlBlocks(text: string): string[] {
  const re = /```sql\s*([\s\S]*?)```/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1].trim());
  return out;
}
