/**
 * CRM → admin-mobile serialization for the WhatsApp screen. Maps the CRM's
 * Supabase rows to the shapes the app renders (message log rows, thread
 * bubbles). Kept pure + separate so the mapping is unit-tested.
 */

/** Sentinel written by the ai-mode endpoint to mean "indefinite manual". */
export const AI_MANUAL_SENTINEL = "2999-01-01T00:00:00Z";

export type MobileRole = "user" | "admin" | "assistant";

/**
 * Bubble role from CRM authorship:
 *   customer            → user      (inbound)
 *   agent + agent_kind ai → assistant
 *   agent (human)       → admin
 *   bot                 → assistant
 */
export function roleForMessage(
  senderType: string | null | undefined,
  agentKind: string | null | undefined,
): MobileRole {
  if (senderType === "customer") return "user";
  if (senderType === "bot") return "assistant";
  if (senderType === "agent") return agentKind === "ai" ? "assistant" : "admin";
  return "assistant";
}

/** True when the AI is currently allowed to reply on this conversation. */
export function aiActive(aiPausedUntil: string | null | undefined): boolean {
  if (!aiPausedUntil) return true;
  const t = new Date(aiPausedUntil).getTime();
  if (Number.isNaN(t)) return true;
  return t <= Date.now();
}

export interface ConversationRow {
  id: string;
  last_message_text: string | null;
  last_message_at: string | null;
  unread_count: number | null;
  ai_paused_until: string | null;
  contact: { phone: string | null; name: string | null } | null;
}

export function serializeConversation(row: ConversationRow) {
  return {
    id: row.id,
    phone: row.contact?.phone ?? "",
    name: row.contact?.name ?? null,
    last_message_text: row.last_message_text ?? null,
    last_message_at: row.last_message_at ?? null,
    unread_count: row.unread_count ?? 0,
    ai_active: aiActive(row.ai_paused_until),
  };
}

export interface MessageRow {
  id: string;
  sender_type: string | null;
  agent_kind: string | null;
  content_text: string | null;
  content_type: string | null;
  media_url: string | null;
  ai_media_summary: string | null;
  status: string | null;
  created_at: string;
}

export function serializeMessage(row: MessageRow) {
  return {
    id: row.id,
    role: roleForMessage(row.sender_type, row.agent_kind),
    text: row.content_text ?? row.ai_media_summary ?? "",
    type: row.content_type ?? "text",
    media_url: row.media_url ?? null,
    ai_summary: row.ai_media_summary ?? null,
    status: row.status ?? "sent",
    created_at: row.created_at,
  };
}
