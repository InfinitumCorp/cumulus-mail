// The interface language to start in. Same order as the vendored detectLocale (a remembered choice,
// then ?lang=, then the browser's languages), except that on a ru.* host (ru.mail.cumuluscloud.app)
// Russian goes ahead of the browser's languages: people there get Russian unless they chose otherwise.
import { detectLocale } from './i18n.js';

/** @param {{ hostname?: string, languages?: readonly string[], supported?: string[], storageKey?: string }} [env] */
export function initialLocale(env = {}) {
  const hostname = (env.hostname ?? globalThis.location?.hostname ?? '').toLowerCase();
  const nav = globalThis.navigator;
  const browser = env.languages ?? (nav ? (nav.languages?.length ? nav.languages : [nav.language]) : []);
  const languages = hostname.startsWith('ru.') ? ['ru', ...browser] : [...browser];
  return detectLocale({ languages, supported: env.supported, storageKey: env.storageKey });
}
