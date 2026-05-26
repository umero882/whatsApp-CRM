/**
 * Tiny Hasura GraphQL client. No SDK — fetch is enough.
 * Used by the Ethiopian Maids tools.
 */

export class HasuraError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly graphqlErrors?: unknown,
  ) {
    super(message);
    this.name = 'HasuraError';
  }
}

export interface HasuraClient {
  query<T = unknown>(
    operation: string,
    variables?: Record<string, unknown>,
  ): Promise<T>;
}

export function makeHasuraClient(url: string, adminSecret: string | null): HasuraClient {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (adminSecret) headers['x-hasura-admin-secret'] = adminSecret;

  return {
    async query<T>(operation: string, variables?: Record<string, unknown>): Promise<T> {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: operation, variables: variables ?? {} }),
      });
      const text = await res.text();
      if (!res.ok) {
        throw new HasuraError(`Hasura HTTP ${res.status}`, res.status, text.slice(0, 800));
      }
      let json: { data?: T; errors?: Array<{ message?: string }> };
      try {
        json = JSON.parse(text);
      } catch {
        throw new HasuraError('Hasura returned non-JSON', res.status, text.slice(0, 400));
      }
      if (json.errors?.length) {
        const msg = json.errors.map((e) => e.message ?? 'unknown').join('; ');
        throw new HasuraError(`Hasura: ${msg}`, res.status, json.errors);
      }
      if (json.data === undefined) {
        throw new HasuraError('Hasura returned no data', res.status, json);
      }
      return json.data;
    },
  };
}
