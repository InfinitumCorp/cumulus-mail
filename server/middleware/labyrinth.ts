import { proxyLabyrinthRequest } from "../../src/lib/labyrinth/proxy.ts";
/** Separate CID credential required even when the app is using preview/dev Better Auth. */
export default async function labyrinthMiddleware(event: { url: URL; req: Request }, next: () => unknown | Promise<unknown>): Promise<unknown> {
  if (event.url.pathname !== "/api/labyrinth") return next();
  return proxyLabyrinthRequest(event.req, process.env.LBRNTH_ENDPOINT, "cumulus-mail");
}
