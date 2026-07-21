/**
 * Channel abstraction — one inbox, one AI agent, many platforms.
 *
 * Phase 1 (this file): the type, per-channel capabilities, and a text
 * send router. WhatsApp is fully wired; Instagram/Messenger/Telegram
 * throw ChannelNotImplementedError until their phases land, so every
 * caller is already channel-correct the day a new channel goes live.
 */

import { sendTextMessage } from '@/lib/whatsapp/meta-api';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';

export type Channel = 'whatsapp' | 'instagram' | 'messenger' | 'telegram' | 'email';

export const CHANNELS: readonly Channel[] = ['whatsapp', 'instagram', 'messenger', 'telegram', 'email'];

export function isChannel(v: unknown): v is Channel {
  return typeof v === 'string' && (CHANNELS as readonly string[]).includes(v);
}

/**
 * Agent tools that render WhatsApp-specific surfaces (interactive
 * buttons/lists, image cards, CTA cards). On other channels the model
 * must stay in plain text until that channel's native equivalents are
 * wired, so these are filtered out of the tool list.
 */
const WHATSAPP_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'reply_with_choices',
  'send_maid_cards',
  'send_app_download_card',
]);

/** Pure — exported for tests. */
export function filterToolsForChannel<T extends { name: string }>(
  tools: T[],
  channel: Channel,
): T[] {
  if (channel === 'whatsapp') return tools;
  return tools.filter((t) => !WHATSAPP_ONLY_TOOLS.has(t.name));
}

export class ChannelNotImplementedError extends Error {
  constructor(channel: string) {
    super(`Channel "${channel}" is not wired for outbound sends yet.`);
    this.name = 'ChannelNotImplementedError';
  }
}

export interface SendChannelTextArgs {
  channel: Channel;
  /** WhatsApp: E.164 phone. Other channels: platform user id. */
  to: string;
  text: string;
  /** WhatsApp transport credentials (required when channel=whatsapp). */
  whatsapp?: { phoneNumberId: string; accessToken: string } | null;
  /** Required when channel==='email'. Threading is loaded from this conversation. */
  email?: { conversationId: string } | null;
}

/**
 * Send a plain-text message on the conversation's channel. Returns the
 * platform message id. Persistence stays with the caller (unchanged
 * from the pre-omnichannel flow).
 */
export async function sendChannelText(args: SendChannelTextArgs): Promise<{ messageId: string }> {
  switch (args.channel) {
    case 'whatsapp': {
      if (!args.whatsapp) throw new Error('whatsapp credentials missing for whatsapp send');
      return sendTextMessage({
        phoneNumberId: args.whatsapp.phoneNumberId,
        accessToken: args.whatsapp.accessToken,
        to: sanitizePhoneForMeta(args.to),
        text: args.text,
      });
    }
    case 'email': {
      if (!args.email) throw new Error('email context missing for email send');
      // Lazy import avoids a static import cycle.
      const { sendEmailReply } = await import('@/lib/email/send');
      return sendEmailReply({ conversationId: args.email.conversationId, to: args.to, text: args.text });
    }
    case 'instagram':
    case 'messenger':
    case 'telegram':
      throw new ChannelNotImplementedError(args.channel);
  }
}
