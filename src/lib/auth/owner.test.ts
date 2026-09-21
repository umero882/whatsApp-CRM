import { describe, expect, it, vi, beforeEach } from "vitest";

const resolveOwner = vi.fn<() => Promise<string>>();

vi.mock("@/lib/mobile/auth", () => {
  class MobileOwnerError extends Error {
    readonly status = 503;
    constructor(message = "no owner") {
      super(message);
      this.name = "MobileOwnerError";
    }
  }
  return { MobileOwnerError, resolveOwnerUserId: () => resolveOwner() };
});

import { forbidUnlessOwner } from "./owner";
import { MobileOwnerError } from "@/lib/mobile/auth";

beforeEach(() => {
  resolveOwner.mockReset();
});

describe("forbidUnlessOwner", () => {
  it("passes the operator through", async () => {
    resolveOwner.mockResolvedValue("owner-1");
    expect(await forbidUnlessOwner("owner-1")).toBeNull();
  });

  it("returns 403 for any other authenticated user", async () => {
    resolveOwner.mockResolvedValue("owner-1");
    const res = await forbidUnlessOwner("stranger-9");
    expect(res?.status).toBe(403);
    expect(await res!.json()).toEqual({ error: "Forbidden" });
  });

  it("surfaces an owner-lookup failure as the lookup's own status, not 403", async () => {
    resolveOwner.mockRejectedValue(new MobileOwnerError("no unambiguous WhatsApp owner"));
    const res = await forbidUnlessOwner("owner-1");
    expect(res?.status).toBe(503);
  });

  it("does not swallow unexpected errors", async () => {
    resolveOwner.mockRejectedValue(new Error("db down"));
    await expect(forbidUnlessOwner("owner-1")).rejects.toThrow("db down");
  });
});
