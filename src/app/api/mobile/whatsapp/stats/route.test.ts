import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = { count: 0 };
  function builder() {
    const b: Record<string, unknown> = {
      select: vi.fn(() => b),
      eq: vi.fn(() => b),
      gte: vi.fn(() => b),
      in: vi.fn(() => b),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve({ count: state.count, error: null }).then(onF, onR),
    };
    return b;
  }
  return { state, builder };
});

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({ from: () => h.builder() }),
}));
vi.mock("@/lib/mobile/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mobile/auth")>();
  return { ...actual, verifyMobileAdmin: vi.fn() };
});

import { GET } from "./route";
import { verifyMobileAdmin, MobileAuthError } from "@/lib/mobile/auth";

const req = () =>
  new Request("https://crm.example/api/mobile/whatsapp/stats", {
    headers: { authorization: "Bearer x" },
  });

beforeEach(() => {
  vi.mocked(verifyMobileAdmin).mockReset();
  h.state.count = 0;
});

describe("GET /api/mobile/whatsapp/stats", () => {
  it("401s on auth failure", async () => {
    vi.mocked(verifyMobileAdmin).mockRejectedValue(new MobileAuthError());
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("returns the five KPI counts", async () => {
    vi.mocked(verifyMobileAdmin).mockResolvedValue({ userId: "owner-1", firebaseUid: "u" });
    h.state.count = 7;
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({
      today: 7,
      week: 7,
      total: 7,
      inbound_today: 7,
      outbound_today: 7,
    });
  });
});
