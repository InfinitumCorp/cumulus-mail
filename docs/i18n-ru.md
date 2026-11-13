
## Legal pages

`/legal/privacy` and `/legal/terms` are served **only on `ru.*` hosts** (404 elsewhere) from the
templates in `src/lib/legal/ru-templates.ts`. See the comment at the top of that file: they are a
starting point for a Russian lawyer, not published documents.

Each `{{FIELD}}` is filled from `MAIL_LEGAL_RU_<FIELD>` (none of them secret). Until **every** field is
filled **and** `MAIL_LEGAL_RU_REVIEWED=yes`, the page carries a draft banner in Russian and English,
lists what is missing, and sends `X-Robots-Tag: noindex`. Filling the fields is not the same as
approving the wording: the review flag is set by a person, deliberately.

`npm test` covers both: a half-filled document can never lose the banner, and every placeholder in the
templates has an entry in `FIELDS` telling the owner what to supply.
