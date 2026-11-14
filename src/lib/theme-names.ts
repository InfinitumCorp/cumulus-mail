/**
 * The Appearance choices. Kept in their own tiny module: the root layout (src/lib/theme.ts) needs them
 * on every page, including the share page, and importing them from settings.ts would pull the whole
 * mail settings module (plans, folders, routing) into that bundle.
 */
export type Theme = "light" | "dark" | "system";
export const THEMES: readonly Theme[] = ["light", "dark", "system"];
/** Light: the shell looks as it always has unless its owner chooses otherwise (the layout rule). */
export const DEFAULT_THEME: Theme = "light";
