/** Contact groups, capped so a payload cannot grow a contact without limit. */
export function cleanGroups(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const name = item.trim().replace(/\s+/g, " ").slice(0, 40);
    if (!name || out.some((existing) => existing.toLowerCase() === name.toLowerCase())) continue;
    out.push(name);
    if (out.length >= 8) break;
  }
  return out;
}

export function parseGroupField(value: string): string[] {
  return cleanGroups(value.split(","));
}
