import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Skip the auth round-trip for API routes that already authenticate
  // themselves.
  //
  // supabase.auth.getUser() validates the JWT against the auth server rather
  // than decoding it locally, so for a signed-in caller it is a network
  // request to the Supabase gateway on a different VPS. Every /api/* handler
  // that needs a user builds its own client and calls getUser() again, so
  // running it here too made each authenticated API call pay that round-trip
  // twice.
  //
  // /api/whatsapp/* is deliberately still matched: the blanket 401 below is
  // defence in depth for that subtree. All six non-webhook routes there do
  // check getUser() themselves today, but keeping the guard means a newly
  // added route cannot be exposed by forgetting it.
  //
  // Anonymous requests were never affected either way — with no auth cookie,
  // getUser() short-circuits to AuthSessionMissingError without any network
  // call (auth-js GoTrueClient._getUser).
  if (pathname.startsWith('/api/') && !pathname.startsWith('/api/whatsapp/')) {
    return NextResponse.next({ request })
  }

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // Auth pages - redirect to dashboard if already logged in
  if (user && (
    request.nextUrl.pathname === '/login' ||
    request.nextUrl.pathname === '/signup' ||
    request.nextUrl.pathname === '/forgot-password'
  )) {
    const url = request.nextUrl.clone()
    url.pathname = '/dashboard'
    return NextResponse.redirect(url)
  }

  // Protected pages - redirect to login if not authenticated
  const protectedPaths = ['/dashboard', '/inbox', '/email', '/contacts', '/pipelines', '/broadcasts', '/automations', '/settings']
  if (!user && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // API routes that need auth (not webhooks)
  if (!user && request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
      !request.nextUrl.pathname.includes('/webhook')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    // `api/health` is excluded on purpose: this middleware calls
    // supabase.auth.getUser() on every matched request, which is a network
    // round-trip to the Supabase gateway on a different VPS. A liveness probe
    // that depends on that gateway would let a database blip trigger a
    // container restart. See src/app/api/health/route.ts.
    '/((?!api/health|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
