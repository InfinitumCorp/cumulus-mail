import { useEffect } from "react";
import { initInfinitumAmplitude } from "./infinitum-amplitude";

/** Invisible client-only Amplitude start. No UI. */
export function AmplitudeInit() {
  useEffect(() => {
    initInfinitumAmplitude();
  }, []);
  return null;
}
