/** The preview bridge's channel name and version (see preview-host-bridge.ts). */
export const PREVIEW_BRIDGE_CHANNEL = "grok-preview-bridge" as const;
export const PREVIEW_BRIDGE_VERSION = 1 as const;

/**
 * Message shapes from the host, checked by hand. This file was the only client code that used zod, and
 * it put about 82 kB of zod (unminified) on every page's first load for four small checks.
 */
type Envelope = { channel: typeof PREVIEW_BRIDGE_CHANNEL; version: number; type: string };

export function readEnvelope(data: unknown): Envelope | null {
  if (!data || typeof data !== "object") return null;
  const row = data as Record<string, unknown>;
  if (row.channel !== PREVIEW_BRIDGE_CHANNEL) return null;
  if (typeof row.version !== "number" || !Number.isInteger(row.version) || row.version <= 0) return null;
  if (typeof row.type !== "string" || row.type.length === 0) return null;
  return { channel: PREVIEW_BRIDGE_CHANNEL, version: row.version, type: row.type };
}

export function readHostMessage(
  data: unknown,
):
  | { type: "hello" }
  | { type: "navigate"; path: string }
  | { type: "history"; delta: -1 | 1 }
  | { type: "connector-token-ready" }
  | null {
  const envelope = readEnvelope(data);
  if (!envelope) return null;
  const row = data as Record<string, unknown>;
  switch (envelope.type) {
    case "hello":
    case "connector-token-ready":
      return { type: envelope.type };
    case "navigate":
      return typeof row.path === "string" && row.path.length > 0 ? { type: "navigate", path: row.path } : null;
    case "history":
      return row.delta === -1 || row.delta === 1 ? { type: "history", delta: row.delta } : null;
    default:
      return null;
  }
}

