/**
 * Which assistant a draft is talking to. Browser-safe: no server code.
 *
 *   @conjure <question>          a live Conjure™ forecast
 *   @scalvs / @scalus <task>     the SCALVS agent (OpenClaw underneath). "@openclaw" is not a trigger.
 *   @search <question>           Infinitum Search: a web answer with numbered sources
 */
export const SCALVS_MENTION = /(^|[^\w@＠./])[@＠]scal(?:vs|us)(?![\w-]|\.[a-z])/i;
export const SEARCH_MENTION = /(^|[^\w@＠./])[@＠]search(?![\w-]|\.[a-z])/i;
export const CONJURE_MENTION = /(^|[^\w@./])@conjure(?![\w-]|\.[a-z])/i;

/** @conjure wins when a draft has both, the same order as +SPCTR's Ask. */
export function mentionIn(text: string): "conjure" | "scalvs" | "search" | null {
  if (CONJURE_MENTION.test(text)) return "conjure";
  if (SCALVS_MENTION.test(text)) return "scalvs";
  if (SEARCH_MENTION.test(text)) return "search";
  return null;
}
