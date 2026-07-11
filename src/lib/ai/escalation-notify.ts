/**
 * Sends the admin an in-app + push notification when the AI agent escalates
 * a WhatsApp conversation to a human.
 *
 * Reuses the maids-app's existing push pipeline: inserting a row into the
 * Hasura `notifications` table fires a Hasura event trigger → the `sendPush`
 * Cloud Function → Expo push to the admin's devices, and the row also shows
 * up in the admin app's in-app notification center. So the CRM's only job is
 * to insert one correctly-shaped row for the right admin.
 *
 * Recipient = the "primary admin": prefer an explicit env override, else the
 * admin profile whose phone matches the escalation number, else the sole
 * active admin. Never throws — escalation must not depend on this.
 */

import type { HasuraClient } from "./tools/hasura";

const ADMIN_QUERY = /* GraphQL */ `
  query EscalationAdmins {
    profiles(
      where: { user_type: { _in: ["admin", "super_admin"] }, is_active: { _eq: true } }
    ) {
      id
      phone
    }
  }
`;

const INSERT_NOTIFICATION = /* GraphQL */ `
  mutation EscalationNotify($obj: notifications_insert_input!) {
    insert_notifications_one(object: $obj) {
      id
    }
  }
`;

interface AdminRow {
  id: string;
  phone: string | null;
}

/** Last 9 digits — format-agnostic phone comparison (drops +, spaces, 0s). */
function phoneKey(p: string | null | undefined): string {
  return (p ?? "").replace(/\D/g, "").slice(-9);
}

export interface EscalationNotifyInput {
  escalationPhone: string | null;
  conversationId: string;
  customerName: string | null;
  customerPhone: string;
  reason: string;
  issueSummary: string | null;
  urgent: boolean;
  /** Explicit admin Firebase UID (env override). Wins over phone lookup. */
  adminUidOverride?: string | null;
}

export interface EscalationNotifyResult {
  notified: boolean;
  adminUserId: string | null;
}

async function resolveAdminUserId(
  hasura: HasuraClient,
  escalationPhone: string | null,
  override: string | null | undefined,
): Promise<string | null> {
  if (override?.trim()) return override.trim();

  const { profiles } = await hasura.query<{ profiles: AdminRow[] }>(ADMIN_QUERY);
  const admins = profiles ?? [];
  if (admins.length === 0) return null;

  const target = phoneKey(escalationPhone);
  const matched = target ? admins.find((a) => phoneKey(a.phone) === target) : undefined;
  if (matched) return matched.id;

  // No phone match — only safe to guess when there's exactly one admin.
  return admins.length === 1 ? admins[0].id : null;
}

function buildNotification(input: EscalationNotifyInput, adminUserId: string) {
  const title = input.urgent
    ? "🚨 Urgent: human needed on WhatsApp"
    : "🚩 WhatsApp handoff";

  const who = input.customerName
    ? `${input.customerName} (${input.customerPhone})`
    : input.customerPhone;
  const parts = [`${who}: ${input.reason}`];
  if (input.issueSummary) parts.push(input.issueSummary);

  return {
    user_id: adminUserId,
    type: "whatsapp_escalation",
    title: title.slice(0, 255),
    message: parts.join(" — ").slice(0, 500),
    priority: input.urgent ? "urgent" : "high",
    // sendPush forwards `link` into the push payload; the admin app routes on
    // it. related_id/related_type give the in-app center a typed anchor.
    link: `/comms/whatsapp?conversationId=${input.conversationId}`,
    related_id: input.conversationId,
    related_type: "whatsapp_conversation",
  };
}

export async function notifyAdminOfEscalation(
  hasura: HasuraClient,
  input: EscalationNotifyInput,
): Promise<EscalationNotifyResult> {
  const adminUserId = await resolveAdminUserId(
    hasura,
    input.escalationPhone,
    input.adminUidOverride,
  );
  if (!adminUserId) return { notified: false, adminUserId: null };

  await hasura.query(INSERT_NOTIFICATION, { obj: buildNotification(input, adminUserId) });
  return { notified: true, adminUserId };
}

// exported for tests
export const _test = { phoneKey, buildNotification, resolveAdminUserId };
