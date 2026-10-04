import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { supabaseCookieOptions } from './cookie-options'

export async function createClient(response?: NextResponse) {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: supabaseCookieOptions,
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response?.cookies.set(name, value, options)
            try {
              cookieStore.set(name, value, options)
            } catch {
              // The `setAll` method was called from a Server Component.
              // This can be ignored if middleware refreshes sessions.
            }
          })
        },
      },
    }
  )
}
