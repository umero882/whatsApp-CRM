import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    conversations: { data: [] as unknown[], count: 0, error: null as unknown },
    contacts: { data: [] as unknown[], error: null as unknown },
    conversationsEqArgs: [] as unknown[][],
    inArgs: [] as unknown[][],
  };
  function builder(table: string) {
    const b: Record<string, unknown> = {
      select: vi.fn(() => b),
      eq: vi.fn((...a: unknown[]) => {
        if (table === "conversations") state.conversationsEqArgs.push(a);
        return b;
      }),
      or: vi.fn(() => b),
      in: vi.fn((...a: unknown[]) => {
        state.inArgs.push(a);
        return b;
      }),
      order: vi.fn(() => b),
      range: vi.fn(() => b),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(table === "contacts" ? state.contacts : state.conversations).then(onF, onR),
    };
    return b;
  }
  return { state, builder };
});

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({ from: (t: string) => h.builder(t) }),
}));
vi.mock("@/lib/mobile/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mobile/auth")>();
  return { ...actual, verifyMobileAdmin: vi.fn() };
});

import { GET } from "./route";
import { verifyMobileAdmin, MobileAuthError } from "@/lib/mobile/auth";

const req = (url = "https://crm.example/api/mobile/whatsapp/conversations") =>
  new Request(url, { headers: { authorization: "Bearer x" } });

beforeEach(() => {
  vi.mocked(verifyMobileAdmin).mockReset();
  h.state.conversations = { data: [], count: 0, error: null };
  h.state.contacts = { data: [], error: null };
  h.state.conversationsEqArgs = [];
  h.state.inArgs = [];
});

describe("GET /api/mobile/whatsapp/conversations", () => {
  it("returns 401 on auth failure", async () => {
    vi.mocked(verifyMobileAdmin).mockRejectedValue(new MobileAuthError("invalid token"));
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("scopes the query to the resolved owner and serializes rows", async () => {
    vi.mocked(verifyMobileAdmin).mockResolvedValue({ userId: "owner-1", firebaseUid: "u" });
    h.state.conversations = {
      count: 1,
      error: null,
      data: [
        {
          id: "c1",
          last_message_text: "hi",
          last_message_at: "2026-07-11T00:00:00Z",
          unread_count: 0,
          ai_paused_until: null,
          contact: { phone: "971500000000", name: "Alem" },
        },
      ],
    };
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.conversations[0]).toMatchObject({ id: "c1", ai_active: true });
    // The user_id filter was applied.
    expect(h.state.conversationsEqArgs).toContainEqual(["user_id", "owner-1"]);
  });

  it("filters to channel=whatsapp", async () => {
    vi.mocked(verifyMobileAdmin).mockResolvedValue({ userId: "owner-1", firebaseUid: "u" });
    h.state.conversations = { data: [], count: 0, error: null };
    await GET(req());
    expect(h.state.conversationsEqArgs).toContainEqual(["channel", "whatsapp"]);
  });

  it("short-circuits to empty when search matches no contacts", async () => {
    vi.mocked(verifyMobileAdmin).mockResolvedValue({ userId: "owner-1", firebaseUid: "u" });
    h.state.contacts = { data: [], error: null };
    const res = await GET(req("https://crm.example/api/mobile/whatsapp/conversations?search=zzz"));
    const body = await res.json();
    expect(body).toEqual({ conversations: [], total: 0 });
  });

  it("constrains by matched contact ids when search hits", async () => {
    vi.mocked(verifyMobileAdmin).mockResolvedValue({ userId: "owner-1", firebaseUid: "u" });
    h.state.contacts = { data: [{ id: "contact-9" }], error: null };
    h.state.conversations = { data: [], count: 0, error: null };
    await GET(req("https://crm.example/api/mobile/whatsapp/conversations?search=Alem"));
    expect(h.state.inArgs).toContainEqual(["contact_id", ["contact-9"]]);
  });
});
