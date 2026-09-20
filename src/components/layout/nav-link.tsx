"use client";

import Link from "next/link";
import { useState, type ComponentProps } from "react";

type NavLinkProps = Omit<ComponentProps<typeof Link>, "prefetch">;

/**
 * Sidebar link that prefetches only while hovered.
 *
 * Why not the default viewport prefetch: every dashboard page is dynamic
 * (auth cookies), so its prefetch has no client-cache TTL, and the App
 * Router re-prefetches ALL visible links each time the router tree
 * changes — which the inbox does on every conversation click
 * (`router.replace('/inbox?c=…')`). With eleven always-visible sidebar
 * links that was ~50–100 RSC requests per click, each paying the
 * middleware's Supabase getUser() round-trip (measured 1.0–1.7s apiece).
 *
 * This is the "Preventing too many prefetches" pattern from the Next.js
 * prefetching guide. Prefetch is switched back off on mouse leave so a
 * link hovered once does not rejoin the re-prefetch set for the rest of
 * the session.
 */
export function NavLink({
  onMouseEnter,
  onMouseLeave,
  ...rest
}: NavLinkProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <Link
      {...rest}
      prefetch={hovered ? null : false}
      onMouseEnter={(e) => {
        setHovered(true);
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        setHovered(false);
        onMouseLeave?.(e);
      }}
    />
  );
}
