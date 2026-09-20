import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ outreach: vi.fn(), owner: vi.fn() }));

vi.mock("@/lib/outreach/whatsapp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/outreach/whatsapp")>();
  return { ...actual, sendOutreach: h.outreach };
});
vi.mock("@/lib/mobile/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mobile/auth")>();
  return { ...actual, resolveOwnerUserId: h.owner };
});

import { POST } from "./route";
import { OutreachError } from "@/lib/outreach/whatsapp";
import { MobileOwnerError } from "@/lib/mobile/auth";
import { __resetRateLimitForTests } from "@/lib/rate-limit";

const req = (body: unknown, key = "k-outreach") =>
  new Request("https://crm.example/api/integrations/outreach/whatsapp", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const ok = {
  contactId: "ct-1",
  conversationId: "cv-1",
  crmMessageId: "m-1",
  waMessageId: "wa-1",
  contactCreated: true,
  conversationCreated: true,
};

beforeEach(() => {
  process.env.OUTREACH_API_KEY = "k-outreach";
  h.outreach.mockReset();
  h.owner.mockReset();
  h.owner.mockResolvedValue("owner-1");
  __resetRateLimitForTests();
});

afterEach(() => {
  delete process.env.OUTREACH_API_KEY;
});

describe("POST /api/integrations/outreach/whatsapp", () => {
  it("sends the template to the owner's number and returns the ids", async () => {
    h.outreach.mockResolvedValue(ok);
    const res = await POST(
      req({ phone: "+971 50 123 4567", name: "Family in Al Shamkha", template_name: "ad_reply", template_params: ["Al Shamkha", 42] }),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({
      success: true,
      contact_id: "ct-1",
      conversation_id: "cv-1",
      message_id: "m-1",
      whatsapp_message_id: "wa-1",
      contact_created: true,
      conversation_created: true,
    });
    expect(h.outreach).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "owner-1",
        phone: "+971 50 123 4567",
        name: "Family in Al Shamkha",
        templateName: "ad_reply",
        templateParams: ["Al Shamkha", "42"],
        allowExisting: false,
      }),
    );
  });

  it("401s without the key, with a wrong key, and while the key is unset", async () => {
    h.outreach.mockResolvedValue(ok);
    expect((await POST(req({ phone: "+971501234567", text: "hi" }, "wrong"))).status).toBe(401);
    const bare = new Request("https://crm.example/api/integrations/outreach/whatsapp", {
      method: "POST",
      body: JSON.stringify({ phone: "+971501234567", text: "hi" }),
    });
    expect((await POST(bare)).status).toBe(401);
    delete process.env.OUTREACH_API_KEY;
    expect((await POST(req({ phone: "+971501234567", text: "hi" }))).status).toBe(401);
    expect(h.outreach).not.toHaveBeenCalled();
  });

  it("400s without a phone", async () => {
    const res = await POST(req({ template_name: "ad_reply" }));
    expect(res.status).toBe(400);
    expect(h.outreach).not.toHaveBeenCalled();
  });

  it("passes an OutreachError status through (409 for a known number)", async () => {
    h.outreach.mockRejectedValue(new OutreachError("this number was already written to once", 409));
    const res = await POST(req({ phone: "+971501234567", template_name: "ad_reply" }));
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toContain("already written to");
  });

  it("hides internal detail on a >=500 fault", async () => {
    h.outreach.mockRejectedValue(new OutreachError("contacts lookup failed: pg boom", 500));
    const res = await POST(req({ phone: "+971501234567", template_name: "ad_reply" }));
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to send");
  });

  it("503s when the WhatsApp owner cannot be resolved", async () => {
    h.owner.mockRejectedValue(new MobileOwnerError("no unambiguous WhatsApp owner"));
    const res = await POST(req({ phone: "+971501234567", template_name: "ad_reply" }));
    expect(res.status).toBe(503);
  });

  it("429s when the send budget is exhausted", async () => {
    h.outreach.mockResolvedValue(ok);
    let last: Response | undefined;
    for (let i = 0; i < 61; i++) {
      last = await POST(req({ phone: "+971501234567", template_name: "ad_reply" }));
    }
    expect(last?.status).toBe(429);
  });
});
