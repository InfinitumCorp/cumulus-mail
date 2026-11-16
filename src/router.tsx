import "@/lib/zod-config";
import { createRouter } from "@tanstack/react-router";
import { createIsomorphicFn, getGlobalStartContext } from "@tanstack/react-start";
import { AppErrorComponent } from "@/lib/error-component";
import { previewPathRewrite } from "@/lib/preview-path-prefix";
import { routeTree } from "./routeTree.gen";

/** This request's CSP nonce (src/start.ts). The client reads it back from the csp-nonce meta tag. */
const requestNonce = createIsomorphicFn()
  .server(() => {
    try {
      return (getGlobalStartContext() as { nonce?: string } | undefined)?.nonce;
    } catch {
      return undefined; // outside a request (no global middleware ran): no nonce, no CSP header either
    }
  })
  .client(() => undefined);

export function getRouter() {
  const nonce = requestNonce();
  return createRouter({
    routeTree,
    ...(nonce ? { ssr: { nonce } } : {}),
    rewrite: previewPathRewrite(),
    defaultErrorComponent: AppErrorComponent,
  });
}
