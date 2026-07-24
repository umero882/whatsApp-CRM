"use client";

import { InboxView } from "@/components/inbox/inbox-view";

/**
 * All-channel inbox. The full experience lives in <InboxView/>, shared with
 * the channel-locked /email view.
 */
export default function InboxPage() {
  return <InboxView basePath="/inbox" />;
}
