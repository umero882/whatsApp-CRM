import { beforeEach, describe, expect, it, vi } from "vitest";

// Tracks whether the middleware built a Supabase client and called getUser().
// That call is a network round-trip to the auth server on another VPS, so the
// point of these tests is which paths pay for it.
const h = vi.hoisted(() => {
  const state = { getUserCalls: 0, user: null as unknown };
  return { state };
});

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => {
        h.state.getUserCalls += 1;
        return { data: { user: h.state.user }, error: null };
      },
    },
  }),
}));

import { middleware, config } from "./middleware";
import { NextRequest } from "next/server";

const req = (path: string) => new NextRequest(new URL(path, "https://crm.example"));

beforeEach(() => {
  h.state.getUserCalls = 0;
  h.state.user = null;
});

describe("middleware auth skip", () => {
  it("skips the auth round-trip for self-authenticating API routes", async () => {
    for (const p of [
      "/api/email/send",
      "/api/mobile/whatsapp/conversations",
      "/api/ai/stats/card-coverage",
      "/api/automations/run",
    ]) {
      h.state.getUserCalls = 0;
      const res = await middleware(req(p));
      expect(res.status, p).toBe(200);
      expect(h.state.getUserCalls, `${p} must not call getUser()`).toBe(0);
    }
  });

  it("still guards /api/whatsapp/* as defence in depth", async () => {
    const res = await middleware(req("/api/whatsapp/send"));
    expect(h.state.getUserCalls).toBe(1);
    expect(res.status).toBe(401);
  });

  it("leaves the whatsapp webhook unauthenticated — Meta calls it with no session", async () => {
    const res = await middleware(req("/api/whatsapp/webhook"));
    expect(res.status).toBe(200);
  });

  it("still redirects anonymous users away from protected pages", async () => {
    for (const p of ["/dashboard", "/inbox", "/email", "/settings"]) {
      const res = await middleware(req(p));
      expect(res.status, p).toBe(307);
      expect(res.headers.get("location"), p).toContain("/login");
    }
  });

  it("still redirects signed-in users away from the login page", async () => {
    h.state.user = { id: "u1" };
    const res = await middleware(req("/login"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
  });

  it("excludes the health probe from the matcher so liveness cannot depend on auth", () => {
    // The probe must never reach this middleware at all — see
    // src/app/api/health/route.ts.
    expect(config.matcher[0]).toContain("api/health");
  });
});
