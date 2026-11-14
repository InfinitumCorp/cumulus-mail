import { useEffect, useState } from "react";

/** "ru" when the interface translator has switched the page to Russian (it sets <html lang>), else "en". */
export function interfaceLanguage(lang: string | null | undefined): "en" | "ru" {
  return (lang ?? "").toLowerCase().startsWith("ru") ? "ru" : "en";
}

/**
 * The interface language, for text the catalog cannot hold because code assembles it (a recurrence rule
 * in words). "en" on the server and in the first render, so hydration matches; then whatever <html lang>
 * says, following later changes from the language menu.
 */
export function useInterfaceLanguage(): "en" | "ru" {
  const [language, setLanguage] = useState<"en" | "ru">("en");
  useEffect(() => {
    const root = document.documentElement;
    const read = () => setLanguage(interfaceLanguage(root.getAttribute("lang")));
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ["lang"] });
    return () => observer.disconnect();
  }, []);
  return language;
}
