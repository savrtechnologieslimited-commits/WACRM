import type { CookieOptions } from '@supabase/ssr'

export const supabaseCookieOptions: CookieOptions = {
  sameSite: 'none',
  secure: true,
  partitioned: true,
}
