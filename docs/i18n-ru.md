# Russian interface (`ru`)

The app ships one catalog per language in `src/i18n/locales/`. English is the source and the fallback;
`ru.json` is a complete translation of it. `src/i18n/catalogs.js` is generated from those files and is
what the browser loads, so nothing is translated at run time and the UI works offline and inside Russia.

## Changing UI text

```
npm run i18n          # re-extract en.json from the components and rebuild catalogs.js
npm run i18n -- --check   # CI: fails when en.json or catalogs.js are stale, or a locale lacks a key
```

`npm test` runs `scripts/i18n-extract.test.mjs`, which **fails when any English string has no Russian
translation**. After adding UI text: run `npm run i18n`, translate the new keys in `ru.json`, run it again.

Only interface text is extracted (JSX text, `title` / `aria-label` / `placeholder` / `alt` / `label`,
toasts, and labels in data modules). Mail content is rendered from data and is never translated; the
brand wordmark carries `translate="no"`.

## Which language a person gets

`src/i18n/initial-locale.js`, in order:

1. a language they chose from the menu before (remembered in `localStorage`);
2. `?lang=ru`;
3. **`ru` when the host starts with `ru.`** (`ru.mail.cumuluscloud.app`), ahead of the browser's languages;
4. the browser's own languages (`Accept-Language` / `navigator.languages`);
5. English.

The language menu is in the bottom-left corner on every page, so a Russian-speaking visitor on
`mail.cumuluscloud.app` and an English-speaking visitor on `ru.mail.cumuluscloud.app` can both switch.

## Strings that need a lawyer's review before the Russia launch

These are the translations that make a **claim about how data is handled**. They were translated to match
the English, which is itself a marketing claim, not reviewed text. A Russian lawyer should confirm the
wording against 152-ФЗ (personal data), the data-localisation rule (ст. 18 ч. 5), and the rules on
advertising claims, and the owner should change `ru.json` to whatever they approve.

| Key in `en.json` | Why it needs review |
|---|---|
| `Every mailbox is encrypted at rest. Mail between Cumulus accounts is end-to-end. Never scanned for ads. Never sold.` | "никогда не продаётся" and the encryption claim are promises about processing; they have to match the published policy. |
| `Every mailbox is encrypted at rest. Mail between Cumulus://Mail accounts is end-to-end encrypted. Cumulus://Mail is never scanned for ads and never sold.` | The same claim, longer form. |
| `Cumulus://Mail — private email with every Cumulus://ID. Encrypted at rest. Never scanned for ads.` | Page description; the same claims in a sentence a search engine may show. |
| `Private by default.` | A claim as a headline. |
| `Encrypted at rest · leaves Cumulus when it is delivered` | Says where the data goes, which bears on the localisation rule. |
| `End-to-end · Cumulus to Cumulus` | Scope of encryption. |
| `Encrypted with this mailbox. Spectre sees titles and times only while the Firmament grant stands.` | Describes third-party access to personal data. |
| `Holds that belong to this CID. Spectre can read titles only while you allow it.` | The same, for the calendar. |
| `Phone, postal address, and an OpenPGP public key are sealed with this mailbox.` | Names the categories of personal data held. |
| `People already in this mailbox. External addresses leave the encrypted channel.` | Says when data leaves the protected channel. |
| `The password stays in this browser. The server stores only the sealed message.` | A claim about what the server stores. |
| `The private key stays in this tab. It is not written to the mailbox.` | The same, for keys. |

Nothing here is a consent notice yet. The 152-ФЗ consent text, the operator's name and the data location
belong in the privacy policy and terms (a separate, owner-filled document), not in these UI strings.
