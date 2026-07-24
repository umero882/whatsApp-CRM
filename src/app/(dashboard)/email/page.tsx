"use client";

import { InboxView } from "@/components/inbox/inbox-view";

/**
 * Dedicated email view — the same inbox experience locked to the email
 * channel (channel filter hidden, WhatsApp banner suppressed). Human replies
 * route through /api/email/send; the AI persona handles inbound email.
 */
export default function EmailPage() {
  return <InboxView basePath="/email" lockChannel="email" />;
}
