"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Reactive `window.matchMedia` for the rare cases a breakpoint has to
 * drive something CSS cannot — e.g. attribute text like a placeholder.
 * Prefer Tailwind responsive classes for anything visual.
 *
 * SSR-safe: the server snapshot is `false`, so markup renders mobile-first
 * and React reconciles to the real value on hydration without a mismatch.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
