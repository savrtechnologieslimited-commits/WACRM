import type { CookieOptions } from '@supabase/ssr'

export const supabaseCookieOptions: CookieOptions = {
  // The bridge signs in under /auth; auth cookies must also reach /dashboard.
  path: '/',
  sameSite: 'none',
  secure: true,
  partitioned: true,
}
