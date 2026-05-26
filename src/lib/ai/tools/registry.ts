import type { SupabaseClient } from '@supabase/supabase-js';
import type { ToolSpec } from '../providers/types';

/**
 * Context every tool has access to when it runs. Kept small on purpose —
 * tools that need more should declare it explicitly in their parameters.
 *
 *   supabase   — admin Supabase client (RLS-bypassed). Tools that
 *                touch wacrm tables go through this.
 *   userId     — the wacrm user who owns the agent run. Always set.
 *   conversationId — the conversation that triggered this agent run.
 *   contactPhone — the customer's WhatsApp phone (E.164).
 *   hasuraUrl  — Ethiopian Maids GraphQL endpoint. Null if the user
 *                hasn't configured it yet.
 *   hasuraAdminSecret — decrypted Hasura admin secret. Null = no auth.
 */
export interface ToolContext {
  supabase: SupabaseClient;
  userId: string;
  conversationId: string;
  contactPhone: string;
  hasuraUrl: string | null;
  hasuraAdminSecret: string | null;
  /**
   * Credentials needed by render-side tools (e.g. send_maid_cards) so
   * they can post directly to Meta API without re-fetching the user's
   * whatsapp_config row. Populated by agent.ts when it builds the
   * context.
   */
  whatsapp: {
    phoneNumberId: string;
    accessToken: string;
  } | null;
}

export interface ToolHandler {
  /** Stable name the LLM uses to call the tool. snake_case. */
  name: string;
  /** What the LLM should know about when to call this tool. */
  description: string;
  /** JSON-Schema for the arguments object. */
  parameters: ToolSpec['parameters'];
  /**
   * Executor. Receives the parsed arguments and the run context.
   * Returns a JSON-serializable value the LLM will see as a string.
   * Throw to surface an error message to the LLM (it can recover).
   */
  handler: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<unknown>;
}

/**
 * Convert a registered tool list to the ToolSpec[] shape the providers
 * expect. Strips the handler.
 */
export function toolsToSpecs(tools: ToolHandler[]): ToolSpec[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

/**
 * Look up a tool by name. Returns undefined if the LLM hallucinated
 * a name the runner doesn't know — that case is handled by the runner.
 */
export function findTool(
  tools: ToolHandler[],
  name: string,
): ToolHandler | undefined {
  return tools.find((t) => t.name === name);
}
