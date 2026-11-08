// FIRM Suite in React. firm-suite.js / firm-suite.css are plain copies of
// infinitum-nexus/packages/firm/suite (do not edit them here; re-copy after changes).
import { createElement, useEffect, useRef } from "react";
import "./firm-suite.css";

export interface FirmWallet {
  address: string;
  balances: Record<string, string | number>;
}

export function FirmSuite({ product, wallet, walletEndpoint, signinHref, compact }: {
  product: string;
  wallet?: FirmWallet | null;
  walletEndpoint?: string;
  signinHref?: string;
  compact?: boolean;
}) {
  const ref = useRef<HTMLElement & { wallet?: FirmWallet | null }>(null);
  useEffect(() => {
    let live = true;
    void import("./firm-suite.js").then(() => {
      if (live && ref.current && wallet !== undefined) ref.current.wallet = wallet;
    });
    return () => {
      live = false;
    };
  }, [wallet]);
  return createElement("firm-suite", {
    ref,
    product,
    "wallet-endpoint": walletEndpoint,
    "signin-href": signinHref,
    compact: compact ? "" : undefined,
  });
}
