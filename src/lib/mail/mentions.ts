/**
 * Which assistant a draft is talking to. Browser-safe: no server code.
 *
 *   @conjure <question>          a live Conjure™ forecast
 *   @scalvs / @scalus <task>     the SCALVS agent (OpenClaw underneath). "@openclaw" is not a trigger.
 */
export const SCALVS_MENTION = /(^|[^\w@＠./])[@＠]scal(?:vs|us)(?![\w-]|\.[a-z])/i;
export const CONJURE_MENTION = /(^|[^\w@./])@conjure(?![\w-]|\.[a-z])/i;

/** @conjure wins when a draft has both, the same order as +SPCTR's Ask. */
export function mentionIn(text: string): "conjure" | "scalvs" | null {
  if (CONJURE_MENTION.test(text)) return "conjure";
  if (SCALVS_MENTION.test(text)) return "scalvs";
  return null;
}
