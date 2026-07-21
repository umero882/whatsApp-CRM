import { google } from 'googleapis';

const OAUTH_CLIENT_ID = process.env.GMAIL_OAUTH_CLIENT_ID ?? '';
const OAUTH_CLIENT_SECRET = process.env.GMAIL_OAUTH_CLIENT_SECRET ?? '';

export interface GmailClient {
  watch(topicName: string): Promise<{ historyId: string; expiration: string }>;
  historyList(startHistoryId: string): Promise<string[]>;
  getRaw(messageId: string): Promise<{ raw: string; threadId: string; labelIds: string[] }>;
  send(args: { raw: string; threadId?: string }): Promise<{ id: string }>;
  addLabel(messageId: string, labelName: string): Promise<void>;
}

export function makeGmailClient(refreshToken: string): GmailClient {
  const auth = new google.auth.OAuth2(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: refreshToken });
  const gmail = google.gmail({ version: 'v1', auth });

  return {
    async watch(topicName) {
      const { data } = await gmail.users.watch({
        userId: 'me',
        requestBody: { topicName, labelIds: ['INBOX'], labelFilterBehavior: 'INCLUDE' },
      });
      return { historyId: String(data.historyId ?? ''), expiration: String(data.expiration ?? '') };
    },
    async historyList(startHistoryId) {
      const ids: string[] = [];
      let pageToken: string | undefined;
      do {
        const { data } = await gmail.users.history.list({
          userId: 'me', startHistoryId, historyTypes: ['messageAdded'], pageToken,
        });
        for (const h of data.history ?? [])
          for (const m of h.messagesAdded ?? [])
            if (m.message?.id) ids.push(m.message.id);
        pageToken = data.nextPageToken ?? undefined;
      } while (pageToken);
      return [...new Set(ids)];
    },
    async getRaw(messageId) {
      const { data } = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'raw' });
      return {
        raw: String(data.raw ?? ''),
        threadId: String(data.threadId ?? ''),
        labelIds: (data.labelIds ?? []) as string[],
      };
    },
    async send({ raw, threadId }) {
      const { data } = await gmail.users.messages.send({
        userId: 'me', requestBody: { raw, ...(threadId ? { threadId } : {}) },
      });
      return { id: String(data.id ?? '') };
    },
    async addLabel(messageId, labelName) {
      const { data: labels } = await gmail.users.labels.list({ userId: 'me' });
      let label = (labels.labels ?? []).find((l) => l.name === labelName);
      if (!label) {
        const created = await gmail.users.labels.create({ userId: 'me', requestBody: { name: labelName } });
        label = created.data;
      }
      await gmail.users.messages.modify({ userId: 'me', id: messageId, requestBody: { addLabelIds: [label.id!] } });
    },
  };
}
