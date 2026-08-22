import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Captured once, when the module is first loaded in a fresh container.
const BOOTED_AT = Date.now();

// How long the deep probe waits on Supabase before calling it unhealthy.
// The self-hosted gateway routinely takes ~8-9s on a bad preflight, so a
// shorter budget would report false alarms. See [[crm-supabase-gateway-flaky]]
// context in src/app/api/me/profile/route.ts.
const DEEP_TIMEOUT_MS = 12_000;

/**
 * Liveness / readiness probe.
 *
 *   GET /api/health         -> liveness. Never touches the network.
 *   GET /api/health?deep=1  -> readiness. Also round-trips to Supabase.
 *
 * The plain form deliberately does NOT check the database. The web app and the
 * database live on two different VPSes, and the self-hosted Supabase gateway is
 * known to stall (see src/app/api/me/profile/route.ts). If liveness failed
 * whenever that gateway hiccuped, Coolify's health check would restart a
 * container that is perfectly fine — turning a database blip into an
 * application outage. So:
 *
 *   - Point Coolify's health check at the plain form. It answers if, and only
 *     if, the Node process can still serve a request.
 *   - Use `?deep=1` for dashboards and alerting, where a database outage
 *     should page a human rather than reboot something.
 *
 * `/api/health` is excluded from the middleware matcher (src/middleware.ts) so
 * the probe never depends on an auth round-trip of its own.
 *
 * `next.config.ts` already sends `Cache-Control: no-store` for `/api/*`, so
 * neither answer can be served from a cache.
 */
export async function GET(request: NextRequest) {
  const deep = request.nextUrl.searchParams.get('deep');

  const base = {
    status: 'ok',
    uptime_s: Math.round((Date.now() - BOOTED_AT) / 1000),
    // Coolify injects SOURCE_COMMIT at build time; absent when running locally.
    commit: process.env.SOURCE_COMMIT ?? null,
    ts: new Date().toISOString(),
  };

  if (deep !== '1' && deep !== 'true') {
    return NextResponse.json(base);
  }

  const startedAt = Date.now();
  try {
    const supabase = await createClient();

    // Cheapest possible round-trip that still proves PostgREST answered.
    // RLS may legitimately return zero rows for an anonymous caller — we only
    // care that the gateway responded without an error.
    const probe = supabase.from('profiles').select('id').limit(1);
    const { error } = await withTimeout(probe, DEEP_TIMEOUT_MS);

    const latencyMs = Date.now() - startedAt;
    if (error) {
      return NextResponse.json(
        { ...base, status: 'degraded', database: { ok: false, latency_ms: latencyMs, error: error.message } },
        { status: 503 },
      );
    }

    return NextResponse.json({ ...base, database: { ok: true, latency_ms: latencyMs } });
  } catch (err) {
    return NextResponse.json(
      {
        ...base,
        status: 'degraded',
        database: {
          ok: false,
          latency_ms: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
        },
      },
      { status: 503 },
    );
  }
}

// HEAD is what most uptime monitors send. Next.js would synthesise one from
// GET, but that would run the handler body; this keeps the probe free.
export async function HEAD() {
  return new Response(null, { status: 200 });
}

/**
 * Reject a pending promise once `ms` has elapsed.
 *
 * Supabase's query builder is a thenable, not a real promise, and it has no
 * abort signal — the underlying fetch keeps running after we give up. That is
 * acceptable here: the probe is read-only and the socket is closed by the
 * gateway's own timeout.
 */
async function withTimeout<T>(work: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`supabase probe exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
