import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  adminClient: { from: vi.fn() },
  encrypt: vi.fn((value: string) => `encrypted:${value}`),
  registerPhoneNumber: vi.fn(),
  subscribeWabaToApp: vi.fn(),
  verifyPhoneNumber: vi.fn(async () => ({
    display_phone_number: '+15551234567',
  })),
  listWabaPhoneNumbers: vi.fn(async () => [{ id: '123456789012345' }]),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: 'user-1' } },
        error: null,
      })),
    },
    from: (table: string) => makeQuery('tenant', table),
  })),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => h.adminClient),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: h.encrypt,
  decrypt: vi.fn(() => 'decrypted-token'),
}));

vi.mock('@/lib/whatsapp/meta-api', () => ({
  getSubscribedApps: vi.fn(),
  listWabaPhoneNumbers: h.listWabaPhoneNumbers,
  registerPhoneNumber: h.registerPhoneNumber,
  subscribeWabaToApp: h.subscribeWabaToApp,
  verifyPhoneNumber: h.verifyPhoneNumber,
}));

vi.mock('@/lib/whatsapp/meta-error-explain', () => ({
  explainMetaError: vi.fn(() => ({
    summary: 'Meta request failed',
    httpStatus: 502,
    metaMessage: 'Meta request failed',
    code: null,
    subcode: null,
    fbtraceId: null,
  })),
  metaErrorPayload: vi.fn(() => ({})),
}));

import { POST } from './config/route';

function makeQuery(client: 'tenant' | 'admin', table: string) {
  const filters: Array<[string, ...unknown[]]> = [];
  const query: Record<string, (...args: unknown[]) => unknown> = {};
  for (const method of ['select', 'eq', 'neq', 'limit']) {
    query[method] = (...args) => {
      if (method !== 'select') filters.push([method, ...args]);
      return query;
    };
  }
  query.maybeSingle = async () => {
    if (client === 'tenant' && table === 'profiles') {
      return { data: { account_id: 'account-1' }, error: null };
    }
    if (client === 'admin' && table === 'whatsapp_config') {
      return { data: null, error: null };
    }
    if (client === 'tenant' && table === 'whatsapp_config') {
      return {
        data: {
          id: 'connection-1',
          account_id: 'account-1',
          phone_number_id: '123456789012345',
          verify_token: 'encrypted:old-verify-token',
          is_primary: true,
          connection_method: 'embedded_signup_coexistence',
        },
        error: null,
      };
    }
    return { data: null, error: null };
  };
  query.single = query.maybeSingle;
  query.insert = vi.fn(() => query);
  query.update = vi.fn(() => query);
  query.delete = vi.fn(() => query);
  query.then = (resolve, reject) =>
    Promise.resolve(query.maybeSingle()).then(
      typeof resolve === 'function'
        ? (resolve as (value: unknown) => unknown)
        : undefined,
      typeof reject === 'function'
        ? (reject as (reason: unknown) => unknown)
        : undefined
    );
  return query;
}

describe('POST /api/whatsapp/config', () => {
  beforeEach(() => {
    h.encrypt.mockClear();
    h.registerPhoneNumber.mockClear();
    h.subscribeWabaToApp.mockClear();
    h.verifyPhoneNumber.mockClear();
    h.listWabaPhoneNumbers.mockClear();
    h.adminClient.from.mockImplementation((table: string) =>
      makeQuery('admin', table)
    );
  });

  it('refuses to replace a Coexistence connection through manual credentials', async () => {
    const response = await POST(
      new Request('http://localhost/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone_number_id: '123456789012345',
          waba_id: '987654321098765',
          access_token: 'manual-token',
          verify_token: 'new-webhook-token',
        }),
      })
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/Embedded Signup/);
    expect(h.verifyPhoneNumber).toHaveBeenCalledOnce();
    expect(h.listWabaPhoneNumbers).toHaveBeenCalledOnce();
    expect(h.registerPhoneNumber).not.toHaveBeenCalled();
    expect(h.subscribeWabaToApp).not.toHaveBeenCalled();
    expect(h.encrypt).not.toHaveBeenCalled();
  });
});
