// Interface language: Russian on ru.* hosts, else detected from the browser
// (Accept-Language), remembered when chosen from the menu, English fallback. Catalogs are generated at build time with
// infinitum-nexus packages/i18n (extract.ts + translate.ts) and committed here, so
// nothing is translated at runtime and the page works offline and in Russia.
// i18n.js and i18n.css are vendored unchanged from that package.
import { startI18n } from './i18n.js';
import './i18n.css';
import catalogs from './catalogs.js';
import { initialLocale } from './initial-locale.js';

let slot = document.getElementById('lang-switch');
if (!slot) {
  slot = document.createElement('div');
  slot.className = 'lang-float';
  document.body.append(slot);
}
export const i18n = startI18n({
  catalogs,
  switcher: slot,
  locale: initialLocale({ supported: Object.keys(catalogs) }),
});
export const t = i18n.t;
