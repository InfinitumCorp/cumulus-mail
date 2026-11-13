/**
 * The legal pages are plain server-rendered HTML: no script, no app shell, nothing to hydrate. A
 * policy has to be readable by a regulator, a lawyer or a person with scripting off, and has to say
 * plainly when it is not final.
 */
import type { Rendered } from "./ru-templates.ts";
import { FIELDS } from "./ru-templates.ts";

const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The small subset of Markdown these templates use: headings, tables, bold, lists, paragraphs. */
export function markdownToHtml(markdown: string): string {
  const out: string[] = [];
  const lines = markdown.split("\n");
  let paragraph: string[] = [];
  let list: string[] = [];
  let table: string[][] = [];
  const inline = (text: string): string =>
    escape(text)
      .replace(/\{\{([A-Z_]+)\}\}/g, '<mark class="todo">{{$1}}</mark>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length) out.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`);
    list = [];
  };
  const flushTable = () => {
    if (table.length) {
      const [head, ...body] = table;
      out.push(
        `<table><thead><tr>${head!.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body
          .map((row) => `<tr>${row.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      );
    }
    table = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushTable();
  };
  for (const line of lines) {
    const text = line.trim();
    if (!text) {
      flushAll();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(text);
    if (heading) {
      flushAll();
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      continue;
    }
    if (text.startsWith("|")) {
      flushParagraph();
      flushList();
      const cells = text.slice(1, text.endsWith("|") ? -1 : undefined).split("|").map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // the |---|---| separator row
      table.push(cells);
      continue;
    }
    if (text.startsWith("- ")) {
      flushParagraph();
      flushTable();
      list.push(text.slice(2));
      continue;
    }
    // A wrapped line keeps belonging to whatever it is wrapping: a list item, or the paragraph above.
    if (list.length) {
      list[list.length - 1] += ` ${text}`;
      continue;
    }
    flushTable();
    paragraph.push(text);
  }
  flushAll();
  return out.join("\n");
}

const STYLE = `
:root { color-scheme: light dark; --ink: #111; --paper: #fff; --line: #ddd; --warn: #8a5300; --warn-bg: #fff6e0; }
@media (prefers-color-scheme: dark) { :root { --ink: #eee; --paper: #111; --line: #333; --warn: #ffcc7a; --warn-bg: #2b2111; } }
body { margin: 0 auto; max-width: 46rem; padding: 2rem 1rem 6rem; background: var(--paper); color: var(--ink);
  font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
h1 { font-size: 1.9rem; line-height: 1.2; } h2 { margin-top: 2.2rem; font-size: 1.25rem; } h3 { font-size: 1.05rem; }
table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
th, td { border: 1px solid var(--line); padding: .5rem .6rem; text-align: left; vertical-align: top; }
.draft { border: 2px solid var(--warn); background: var(--warn-bg); color: var(--warn); padding: 1rem 1.1rem; margin-bottom: 2rem; }
.draft h2 { margin: 0 0 .5rem; font-size: 1.05rem; } .draft ul { margin: .5rem 0 0; padding-left: 1.2rem; }
mark.todo { background: var(--warn-bg); color: var(--warn); border: 1px dashed var(--warn); padding: 0 .25rem; font-family: ui-monospace, monospace; font-size: .9em; }
footer { margin-top: 3rem; border-top: 1px solid var(--line); padding-top: 1rem; font-size: .85rem; }
a { color: inherit; }
`;

const WHAT = new Map(FIELDS.map((field) => [field.key, field.what] as const));

/** A whole page. `draft` puts an unmissable banner at the top and lists what is still missing. */
export function legalPageHtml(rendered: Rendered): string {
  const banner = rendered.draft
    ? `<section class="draft" role="note">
  <h2>ЧЕРНОВИК — документ не имеет юридической силы</h2>
  <p>Это шаблон, подготовленный для проверки юристом. Он не является опубликованной политикой и не
  порождает обязательств. DRAFT: this template has not been reviewed by a lawyer and is not in force.</p>
  ${
    rendered.missing.length
      ? `<p>Не заполнено (${rendered.missing.length}):</p><ul>${rendered.missing
          .map((key) => `<li><code>${escape(key)}</code> — ${escape(WHAT.get(key as never) ?? "")}</li>`)
          .join("")}</ul>`
      : `<p>Все поля заполнены, но проверка юристом не подтверждена (<code>MAIL_LEGAL_RU_REVIEWED</code>).</p>`
  }
</section>`
    : "";
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(rendered.title)} — Cumulus://Mail</title>
${rendered.draft ? '<meta name="robots" content="noindex, nofollow">\n' : ""}<style>${STYLE}</style>
</head>
<body>
${banner}
${markdownToHtml(rendered.markdown)}
<footer><a href="/legal/privacy">Политика конфиденциальности</a> · <a href="/legal/terms">Пользовательское соглашение</a> · <a href="/">Cumulus://Mail</a></footer>
</body>
</html>
`;
}
