import { describe, expect, it, vi } from "vitest";
import { notifyAdminOfEscalation, _test } from "./escalation-notify";
import type { HasuraClient } from "./tools/hasura";

const BASE = {
  conversationId: "11111111-1111-1111-1111-111111111111",
  customerName: "Alem",
  customerPhone: "251900000000",
  reason: "wants a refund",
  issueSummary: "paid 2000 AED, no maid arrived",
  urgent: false,
} as const;

function makeHasura(admins: Array<{ id: string; phone: string | null }>) {
  const query = vi.fn(async (op: string) => {
    if (op.includes("profiles")) return { profiles: admins };
    return { insert_notifications_one: { id: "notif-1" } };
  });
  return { hasura: { query } as unknown as HasuraClient, query };
}

function insertArg(query: ReturnType<typeof vi.fn>) {
  const call = query.mock.calls.find((c) => String(c[0]).includes("insert_notifications_one"));
  return call?.[1]?.obj as Record<string, unknown> | undefined;
}

describe("notifyAdminOfEscalation", () => {
  it("resolves the admin by matching the escalation phone and inserts a row", async () => {
    const { hasura, query } = makeHasura([
      { id: "admin-A", phone: "+971588767821" },
      { id: "admin-B", phone: "+971500000000" },
    ]);
    const res = await notifyAdminOfEscalation(hasura, {
      ...BASE,
      escalationPhone: "971588767821", // no +, still matches on last 9 digits
    });
    expect(res).toEqual({ notified: true, adminUserId: "admin-A" });

    const obj = insertArg(query);
    expect(obj).toMatchObject({
      user_id: "admin-A",
      type: "whatsapp_escalation",
      priority: "high",
      link: `/comms/whatsapp?conversationId=${BASE.conversationId}`,
      related_id: BASE.conversationId,
      related_type: "whatsapp_conversation",
    });
    expect(String(obj?.message)).toContain("Alem");
    expect(String(obj?.message)).toContain("refund");
  });

  it("uses the env override and skips the admin lookup", async () => {
    const { hasura, query } = makeHasura([{ id: "admin-A", phone: "+971588767821" }]);
    const res = await notifyAdminOfEscalation(hasura, {
      ...BASE,
      escalationPhone: "971588767821",
      adminUidOverride: "override-uid",
    });
    expect(res.adminUserId).toBe("override-uid");
    // never queried profiles
    expect(query.mock.calls.some((c) => String(c[0]).includes("profiles"))).toBe(false);
    expect(insertArg(query)?.user_id).toBe("override-uid");
  });

  it("marks urgent escalations with 'urgent' priority", async () => {
    const { hasura, query } = makeHasura([{ id: "admin-A", phone: "+971588767821" }]);
    await notifyAdminOfEscalation(hasura, {
      ...BASE,
      urgent: true,
      escalationPhone: "971588767821",
    });
    expect(insertArg(query)?.priority).toBe("urgent");
  });

  it("does not notify when there are no admins", async () => {
    const { hasura, query } = makeHasura([]);
    const res = await notifyAdminOfEscalation(hasura, { ...BASE, escalationPhone: "971588767821" });
    expect(res).toEqual({ notified: false, adminUserId: null });
    expect(insertArg(query)).toBeUndefined();
  });

  it("does not guess when multiple admins and no phone match", async () => {
    const { hasura, query } = makeHasura([
      { id: "admin-A", phone: "+971500000001" },
      { id: "admin-B", phone: "+971500000002" },
    ]);
    const res = await notifyAdminOfEscalation(hasura, { ...BASE, escalationPhone: "971588767821" });
    expect(res.notified).toBe(false);
    expect(insertArg(query)).toBeUndefined();
  });

  it("phoneKey compares on the last 9 digits", () => {
    expect(_test.phoneKey("+971588767821")).toBe(_test.phoneKey("971588767821"));
    expect(_test.phoneKey("00971588767821")).toBe(_test.phoneKey("588767821"));
  });
});
