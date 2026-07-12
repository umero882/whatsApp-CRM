/**
 * search_knowledge_base — the retrieval half of the RAG knowledge base
 * (see docs/superpowers/specs/2026-07-12-rag-knowledge-base-design.md).
 * The operator curates documents in Settings → Knowledge; this tool
 * pulls the most relevant passages so the agent answers business/policy
 * questions from curated fact, never invention.
 */

import { searchKb, type KbHit } from '../kb';
import type { ToolHandler } from './registry';

/** LLM-facing payload shape. Pure — exported for tests. */
export function formatKbPassages(hits: KbHit[]): {
  found: number;
  passages: Array<{ source: string; content: string }>;
  note: string;
} {
  if (hits.length === 0) {
    return {
      found: 0,
      passages: [],
      note:
        'No knowledge-base entry covers this. Tell the customer you\'ll confirm the detail with our team ' +
        '(or escalate if it blocks them) — do NOT guess or invent policy, fees, or timelines.',
    };
  }
  return {
    found: hits.length,
    passages: hits.map((h) => ({ source: h.document_title, content: h.content })),
    note:
      'Answer using ONLY these passages, in the customer\'s language, in 1-3 short sentences. ' +
      'If the passages only partially answer, share what they cover and offer to confirm the rest with our team.',
  };
}

export const searchKnowledgeBase: ToolHandler = {
  name: 'search_knowledge_base',
  description:
    'Look up the business knowledge base (curated by our team) for anything factual about how Ethiopian Maids works: ' +
    'visa process, placement timelines, what fees include, refund/replacement policy, medical checks, trial periods, ' +
    'required documents, interview process, and similar service/policy questions. ' +
    'ALWAYS call this BEFORE answering such questions — never answer policy from memory. ' +
    'Not for live marketplace data (candidates → search_maids, jobs → list_jobs, fee amounts → get_pricing).',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'What the customer wants to know, as a concise English search query (translate if the conversation is in another language). E.g. "what does the placement fee include".',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const query = String(args.query ?? '').trim();
    if (!query) return { error: 'query is required.' };
    try {
      const hits = await searchKb(ctx.supabase, ctx.userId, query, 4);
      return formatKbPassages(hits);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[search_knowledge_base] failed:', msg);
      return {
        error: `Knowledge base lookup failed: ${msg}`,
        note: 'Tell the customer you\'ll confirm with the team — do not invent an answer.',
      };
    }
  },
};
