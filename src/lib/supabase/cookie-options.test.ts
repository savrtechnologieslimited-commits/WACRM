import { describe, expect, it } from 'vitest';
import { supabaseCookieOptions } from './cookie-options';

describe('Supabase auth cookie options', () => {
  it('makes bridge-issued sessions available on dashboard routes', () => {
    expect(supabaseCookieOptions).toMatchObject({
      path: '/',
      sameSite: 'none',
      secure: true,
      partitioned: true,
    });
  });
});
