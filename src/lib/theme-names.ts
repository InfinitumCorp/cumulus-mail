/**
 * The Appearance choices. Kept in their own tiny module: the root layout (src/lib/theme.ts) needs them
 * on every page, including the share page, and importing them from settings.ts would pull the whole
 * mail settings module (plans, folders, routing) into that bundle.
 */
export type Theme = "system" | "light" | "dark";
export const THEMES: readonly Theme[] = ["system", "light", "dark"];
