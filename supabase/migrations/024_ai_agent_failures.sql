-- ═══════════════════════════════════════════════════════════════════
-- 024 — ai_agent_failures
--
-- Observability for agent runs that produced NO model reply and fell
-- back to a canned holding line ("Let me get one of our team on this
-- — they'll be in touch shortly.").
--
-- Why: an audit on 2026-08-22 found 57 of 651 AI messages (8.8%) were
-- these holding lines, with nothing anywhere recording the cause. One
-- job-seeker received the same holding line eight times across two
-- days and never got the app download card. Without a row per failure
-- the only symptom is a customer complaining.
--
-- Writes are fail-soft in agent.ts, so deploying the code before this
-- migration is safe (the insert just logs a warning).
-- ═══════════════════════════════════════════════════════════════════

create table if not exists public.ai_agent_failures (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  -- GREETING | DISCOVERY | QUALIFICATION | RECOMMENDATION | BOOKING | CLOSE
  stage text not null,
  -- sponsor | job_seeker | unknown
  intent text not null,
  -- 'provider: OpenAI 429' | 'max_turns_exceeded' | ...
  reason text not null,
  created_at timestamptz not null default now()
);

-- The two questions this table exists to answer: "what is failing right
-- now?" and "did THIS conversation fail before?"
create index if not exists ai_agent_failures_created_at_idx
  on public.ai_agent_failures (created_at desc);
create index if not exists ai_agent_failures_conversation_idx
  on public.ai_agent_failures (conversation_id, created_at desc);

alter table public.ai_agent_failures enable row level security;

-- Owners read their own failures; only the service role (the agent)
-- writes, matching how messages/conversations are handled elsewhere.
drop policy if exists "own failures readable" on public.ai_agent_failures;
create policy "own failures readable"
  on public.ai_agent_failures
  for select
  using (auth.uid() = user_id);
