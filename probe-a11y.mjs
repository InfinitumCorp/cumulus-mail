import { chromium } from "playwright";
const AXE = "node_modules/axe-core/axe.min.js";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
async function scan(label, setup, ctxOpts = {}) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, ...ctxOpts });
  const p = await ctx.newPage();
  await p.goto(process.env.E2E_URL, { waitUntil: "networkidle" });
  await p.locator("[data-row-id]").first().waitFor({ timeout: 30000 });
  await setup(p);
  await p.waitForTimeout(800);
  await p.addScriptTag({ path: AXE });
  const res = await p.evaluate(async () => {
    const r = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, ex: v.nodes.slice(0, 3).map((x) => x.target.join(" ") + " :: " + (x.failureSummary || "").split("\n")[1]) }));
  });
  console.log(`\n== ${label}: ${res.length} rule(s)`);
  for (const v of res) { console.log(`  ${v.impact} ${v.id} x${v.n}`); for (const e of v.ex) console.log(`     ${e.slice(0, 220)}`); }
  await ctx.close();
}
await scan("list", async () => {});
await scan("reader", async (p) => { await p.locator("[data-row-id]").first().click(); });
await scan("compose", async (p) => { await p.getByRole("button", { name: "Compose" }).first().click(); });
await scan("account dialog", async (p) => { await p.locator("aside button.w-full.border-t").click(); await p.getByRole("dialog").waitFor(); });
await scan("mobile shell", async () => {}, { viewport: { width: 390, height: 844 } });
await scan("ru locale", async () => {}, { locale: "ru-RU" });
await b.close();
