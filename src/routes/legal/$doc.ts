import { createFileRoute } from "@tanstack/react-router";

/**
 * `/legal/privacy` and `/legal/terms` on the Russia copy (`ru.*`, or `MAIL_REGION=ru`): the 152-ФЗ
 * document templates in `src/lib/legal/ru-templates.ts`. 404 on the US copy, which has its own
 * published documents elsewhere.
 *
 * A document is served as a **visible draft** until every `{{FIELD}}` is filled from the environment
 * AND `MAIL_LEGAL_RU_REVIEWED=yes` says a lawyer has checked the wording. A draft also carries
 * `X-Robots-Tag: noindex`, so an unfinished policy cannot be indexed or mistaken for the real one.
 */
export const Route = createFileRoute("/legal/$doc")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { regionFor } = await import("@/lib/region");
        if (regionFor(request.headers.get("host")) !== "ru") return new Response("Not found", { status: 404 });
        const doc = params.doc === "privacy" || params.doc === "terms" ? params.doc : null;
        if (!doc) return new Response("Not found", { status: 404 });

        const { renderDoc } = await import("@/lib/legal/ru-templates");
        const { legalPageHtml } = await import("@/lib/legal/render");
        const rendered = renderDoc(doc);
        return new Response(legalPageHtml(rendered), {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            ...(rendered.draft ? { "x-robots-tag": "noindex, nofollow" } : {}),
          },
        });
      },
    },
  },
});
