import type { SupabaseClient } from '@supabase/supabase-js';

export type ConsumeBridgeNonceResult =
  | { ok: true }
  | { ok: false; reason: 'replay' }
  | { ok: false; reason: 'database-error'; error: unknown };

export async function consumeBridgeNonce(
  admin: SupabaseClient,
  nonce: string,
  expiresAt: number
): Promise<ConsumeBridgeNonceResult> {
  const { error: cleanupError } = await admin
    .from('wacrm_sso_nonces')
    .delete()
    .lt('expires_at', new Date().toISOString());
  if (cleanupError) {
    return { ok: false, reason: 'database-error', error: cleanupError };
  }

  const { error } = await admin.from('wacrm_sso_nonces').insert({
    nonce,
    expires_at: new Date(expiresAt * 1000).toISOString(),
  });
  if (error?.code === '23505') return { ok: false, reason: 'replay' };
  if (error) return { ok: false, reason: 'database-error', error };

  return { ok: true };
}
