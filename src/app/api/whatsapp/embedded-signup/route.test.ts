import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  accountId: 'account-1',
  userId: 'user-1',
  tenantConfigCount: 0,
  adminQueries: [] as Array<{
    table: string;
    operation: 'select' | 'insert' | 'update';
    payload?: Record<string, unknown>;
    filters: Array<[string, ...unknown[]]>;
  }>,
  resolveAdminQuery: (query: {
    table: string;
    operation: 'select' | 'insert' | 'update';
    payload?: Record<string, unknown>;
    filters: Array<[string, ...unknown[]]>;
  }): unknown => {
    void query;
    return { data: null, error: null };
  },
  adminClient: { from: vi.fn() },
  encrypt: vi.fn(
    (value: string) => `encrypted:${Buffer.from(value).toString('base64')}`
  ),
  decrypt: vi.fn((value: string) =>
    Buffer.from(value.replace(/^encrypted:/, ''), 'base64').toString()
  ),
  exchange: vi.fn(async () => ({
    access_token: 'customer-access-token',
    expires_in: 0,
  })),
  listPhones: vi.fn(async () => [
    { id: 'phone-1', display_phone_number: '+15551234567' },
  ]),
  verifyPhone: vi.fn(async () => ({
    is_on_biz_app: true,
    platform_type: 'CLOUD_API',
    display_phone_number: '+15551234567',
  })),
  subscribe: vi.fn(async () => {}),
  syncCalls: [] as string[],
  requestSync: vi.fn(
    async (_phoneNumberId: string, _token: string, kind: string) => {
      h.syncCalls.push(kind);
      return `${kind}-request`;
    }
  ),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => h.adminClient),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({
    accountId: h.accountId,
    userId: h.userId,
    supabase: {
      from: (table: string) => {
        const query = {
          select: vi.fn(() => query),
          eq: vi.fn(() => query),
          limit: vi.fn(() => query),
          then: (resolve: (result: unknown) => unknown) =>
            resolve({
              data:
                table === 'whatsapp_config'
                  ? Array.from({ length: h.tenantConfigCount }, (_, index) => ({
                      id: `existing-${index}`,
                    }))
                  : [],
              error: null,
            }),
        };
        return query;
      },
    },
  })),
  toErrorResponse: vi.fn(
    () =>
      new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
  ),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: h.encrypt,
  decrypt: h.decrypt,
}));

vi.mock('@/lib/whatsapp/embedded-signup', () => ({
  COEXISTENCE_FINISH_EVENT: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
  hashSignupState: () => 'hashed-signup-state',
  parseCoexistenceSessionInfo: (value: unknown) => {
    if (
      !value ||
      typeof value !== 'object' ||
      !('type' in value) ||
      value.type !== 'WA_EMBEDDED_SIGNUP'
    ) {
      return null;
    }
    return {
      type: 'WA_EMBEDDED_SIGNUP',
      event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
      data: { waba_id: 'waba-1', phone_number_id: 'phone-1' },
    };
  },
  exchangeEmbeddedSignupCode: h.exchange,
  listCoexistenceWabaPhones: h.listPhones,
  verifyCoexistencePhone: h.verifyPhone,
  subscribeCoexistenceWaba: h.subscribe,
  requestCoexistenceSync: h.requestSync,
}));

import { POST as startSignup } from './start/route';
import { POST as completeSignup } from './complete/route';

type AdminQuery = (typeof h.adminQueries)[number];

function makeAdminQuery(table: string) {
  const query: AdminQuery = { table, operation: 'select', filters: [] };
  h.adminQueries.push(query);

  const builder: Record<string, (...args: unknown[]) => unknown> = {};
  for (const method of ['eq', 'gt', 'limit'] as const) {
    builder[method] = (...args) => {
      query.filters.push([method, ...args]);
      return builder;
    };
  }
  builder.select = (...args) => {
    query.filters.push(['select', ...args]);
    return builder;
  };
  builder.insert = (...args) => {
    query.operation = 'insert';
    query.payload = args[0] as Record<string, unknown>;
    return builder;
  };
  builder.update = (...args) => {
    query.operation = 'update';
    query.payload = args[0] as Record<string, unknown>;
    return builder;
  };
  const resolve = () => h.resolveAdminQuery(query);
  builder.maybeSingle = async () => resolve();
  builder.single = async () => resolve();
  builder.then = (...args) => {
    const onfulfilled = args[0];
    const onrejected = args[1];
    return Promise.resolve(resolve()).then(
      typeof onfulfilled === 'function'
        ? (onfulfilled as (value: unknown) => unknown)
        : undefined,
      typeof onrejected === 'function'
        ? (onrejected as (reason: unknown) => unknown)
        : undefined
    );
  };
  return builder;
}

function postJson(path: string, body: Record<string, unknown>) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function completeSignupSession() {
  return {
    account_id: 'account-1',
    user_id: 'user-1',
    app_id: '123456',
    configuration_id: '789012',
    verify_token: h.encrypt('webhook-verify-token'),
  };
}

function configureSuccessfulSignupResolution() {
  h.resolveAdminQuery = (query) => {
    if (
      query.table === 'whatsapp_signup_sessions' &&
      query.operation === 'update' &&
      query.payload?.status === 'processing'
    ) {
      return { data: completeSignupSession(), error: null };
    }
    if (query.table === 'whatsapp_config' && query.operation === 'select') {
      const selects = query.filters.filter(([method]) => method === 'eq');
      return {
        data: selects.some(([, field]) => field === 'phone_number_id')
          ? null
          : [],
        error: null,
      };
    }
    if (query.table === 'whatsapp_config' && query.operation === 'insert') {
      return { data: { id: 'connection-1' }, error: null };
    }
    return { data: null, error: null };
  };
}

const validSessionInfo = {
  type: 'WA_EMBEDDED_SIGNUP',
  event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
  data: { waba_id: 'waba-1', phone_number_id: 'phone-1' },
};

describe('Meta Embedded Signup routes', () => {
  beforeEach(() => {
    h.accountId = 'account-1';
    h.userId = 'user-1';
    h.tenantConfigCount = 0;
    h.adminQueries.length = 0;
    h.encrypt.mockClear();
    h.decrypt.mockClear();
    h.exchange.mockClear();
    h.listPhones.mockClear();
    h.verifyPhone.mockClear();
    h.subscribe.mockClear();
    h.requestSync.mockClear();
    h.syncCalls.length = 0;
    h.adminClient.from.mockImplementation((table: string) =>
      makeAdminQuery(table)
    );
    h.resolveAdminQuery = (query) => {
      if (
        query.table === 'whatsapp_signup_sessions' &&
        query.operation === 'update'
      ) {
        if (query.payload?.status === 'processing') {
          return {
            data: null,
            error: null,
          };
        }
      }
      return { data: null, error: null };
    };
  });

  it('rejects malformed or replay-shaped OAuth state before database access', async () => {
    const response = await completeSignup(
      postJson('/api/whatsapp/embedded-signup/complete', {
        state: 'not-a-valid-state',
        code: 'oauth-code',
        session_info: validSessionInfo,
      })
    );

    expect(response.status).toBe(400);
    expect(h.adminQueries).toHaveLength(0);
    expect(h.exchange).not.toHaveBeenCalled();
  });

  it('binds completion to the initiating tenant, admin, pending status, and expiry', async () => {
    const response = await completeSignup(
      postJson('/api/whatsapp/embedded-signup/complete', {
        state: 'a'.repeat(64),
        code: 'oauth-code',
        session_info: validSessionInfo,
      })
    );

    expect(response.status).toBe(409);
    expect(h.adminQueries[0]).toMatchObject({
      table: 'whatsapp_signup_sessions',
      operation: 'update',
    });
    expect(h.adminQueries[0].filters).toEqual(
      expect.arrayContaining([
        ['eq', 'state_hash', 'hashed-signup-state'],
        ['eq', 'account_id', 'account-1'],
        ['eq', 'user_id', 'user-1'],
        ['eq', 'status', 'pending'],
        ['gt', 'expires_at', expect.any(String)],
      ])
    );
    expect(h.exchange).not.toHaveBeenCalled();
  });

  it('stores signup state hashed and webhook verification credentials encrypted', async () => {
    const verifyToken = 'webhook-verify-token-value';
    h.resolveAdminQuery = () => ({ data: null, error: null });

    const response = await startSignup(
      postJson('/api/whatsapp/embedded-signup/start', {
        app_id: '123456',
        configuration_id: '789012',
        verify_token: verifyToken,
      })
    );
    const result = await response.json();
    const inserted = h.adminQueries.find(
      (query) =>
        query.table === 'whatsapp_signup_sessions' &&
        query.operation === 'insert'
    );

    expect(response.status).toBe(200);
    expect(result.state).toMatch(/^[a-f0-9]{64}$/);
    expect(inserted?.payload).toMatchObject({
      state_hash: 'hashed-signup-state',
      account_id: 'account-1',
      user_id: 'user-1',
      app_id: '123456',
      configuration_id: '789012',
      verify_token: h.encrypt(verifyToken),
    });
    expect(JSON.stringify(inserted?.payload)).not.toContain(verifyToken);
  });

  it('does not let Embedded Signup replace a workspace manual connection', async () => {
    h.tenantConfigCount = 1;

    const response = await startSignup(
      postJson('/api/whatsapp/embedded-signup/start', {
        app_id: '123456',
        configuration_id: '789012',
        verify_token: 'webhook-verify-token-value',
      })
    );

    expect(response.status).toBe(409);
    expect(h.adminQueries).toHaveLength(0);
  });

  it('does not let completion overwrite an existing workspace connection', async () => {
    h.resolveAdminQuery = (query) => {
      if (
        query.table === 'whatsapp_signup_sessions' &&
        query.payload?.status === 'processing'
      ) {
        return { data: completeSignupSession(), error: null };
      }
      if (query.table === 'whatsapp_config' && query.operation === 'select') {
        return { data: [{ id: 'existing-manual-connection' }], error: null };
      }
      return { data: null, error: null };
    };

    const response = await completeSignup(
      postJson('/api/whatsapp/embedded-signup/complete', {
        state: 'a'.repeat(64),
        code: 'oauth-code',
        session_info: validSessionInfo,
      })
    );

    expect(response.status).toBe(502);
    expect(h.exchange).not.toHaveBeenCalled();
    expect(h.subscribe).not.toHaveBeenCalled();
    expect(h.requestSync).not.toHaveBeenCalled();
    expect(
      h.adminQueries.some(
        (query) =>
          query.table === 'whatsapp_config' && query.operation === 'insert'
      )
    ).toBe(false);
  });

  it('encrypts the customer token and stores the connection under the authenticated tenant', async () => {
    configureSuccessfulSignupResolution();

    const response = await completeSignup(
      postJson('/api/whatsapp/embedded-signup/complete', {
        state: 'a'.repeat(64),
        code: 'oauth-code',
        session_info: validSessionInfo,
      })
    );
    const inserted = h.adminQueries.find(
      (query) =>
        query.table === 'whatsapp_config' && query.operation === 'insert'
    );

    expect(response.status).toBe(200);
    expect(h.requestSync.mock.calls.map(([, , kind]) => kind)).toEqual([
      'smb_app_state_sync',
      'history',
    ]);
    expect(inserted?.payload).toMatchObject({
      account_id: 'account-1',
      user_id: 'user-1',
      phone_number_id: 'phone-1',
      waba_id: 'waba-1',
      meta_app_id: '123456',
      access_token: h.encrypt('customer-access-token'),
      access_token_expires_at: null,
      verify_token: h.encrypt('webhook-verify-token'),
      connection_method: 'embedded_signup_coexistence',
    });
    expect(JSON.stringify(inserted?.payload)).not.toContain(
      'customer-access-token'
    );
    expect(JSON.stringify(inserted?.payload)).not.toContain(
      'webhook-verify-token'
    );
  });

  it('stores the expiration of an exchanged business token', async () => {
    h.exchange.mockResolvedValueOnce({
      access_token: 'customer-access-token',
      expires_in: 3600,
    });
    configureSuccessfulSignupResolution();

    const now = Date.now();
    const response = await completeSignup(
      postJson('/api/whatsapp/embedded-signup/complete', {
        state: 'a'.repeat(64),
        code: 'oauth-code',
        session_info: validSessionInfo,
      })
    );
    const inserted = h.adminQueries.find(
      (query) =>
        query.table === 'whatsapp_config' && query.operation === 'insert'
    );
    const expiration = Date.parse(
      String(inserted?.payload?.access_token_expires_at)
    );

    expect(response.status).toBe(200);
    expect(expiration).toBeGreaterThanOrEqual(now + 3_600_000);
    expect(expiration).toBeLessThanOrEqual(Date.now() + 3_600_000);
  });

  it('does not request history sync unless contact sync is accepted first', async () => {
    configureSuccessfulSignupResolution();
    h.requestSync.mockRejectedValueOnce(new Error('contacts sync unavailable'));

    const response = await completeSignup(
      postJson('/api/whatsapp/embedded-signup/complete', {
        state: 'a'.repeat(64),
        code: 'oauth-code',
        session_info: validSessionInfo,
      })
    );
    const syncUpdate = h.adminQueries.find(
      (query) =>
        query.table === 'whatsapp_config' &&
        query.operation === 'update' &&
        query.payload?.coexistence_sync_status
    );

    expect(response.status).toBe(200);
    expect(h.requestSync.mock.calls.map(([, , kind]) => kind)).toEqual([
      'smb_app_state_sync',
    ]);
    expect(syncUpdate?.payload).toMatchObject({
      coexistence_sync_status: 'failed',
      contacts_sync_status: 'failed',
      history_sync_status: 'not_started',
      history_sync_request_id: null,
    });
  });

  it('records history-sync failure without retrying contacts or reporting full sync', async () => {
    configureSuccessfulSignupResolution();
    h.requestSync
      .mockResolvedValueOnce('contacts-request')
      .mockRejectedValueOnce(new Error('history sync unavailable'));

    const response = await completeSignup(
      postJson('/api/whatsapp/embedded-signup/complete', {
        state: 'a'.repeat(64),
        code: 'oauth-code',
        session_info: validSessionInfo,
      })
    );
    const syncUpdate = h.adminQueries.find(
      (query) =>
        query.table === 'whatsapp_config' &&
        query.operation === 'update' &&
        query.payload?.coexistence_sync_status
    );

    expect(response.status).toBe(200);
    expect(h.requestSync.mock.calls.map(([, , kind]) => kind)).toEqual([
      'smb_app_state_sync',
      'history',
    ]);
    expect(syncUpdate?.payload).toMatchObject({
      coexistence_sync_status: 'partial',
      contacts_sync_status: 'requested',
      contacts_sync_request_id: 'contacts-request',
      history_sync_status: 'failed',
      history_sync_request_id: null,
    });
  });

  it('rejects duplicate callbacks while the original callback is processing', async () => {
    let releaseContactSync: (requestId: string) => void = () => {};
    const contactSync = new Promise<string>((resolve) => {
      releaseContactSync = resolve;
    });
    let stateIsPending = true;
    h.resolveAdminQuery = (query) => {
      if (
        query.table === 'whatsapp_signup_sessions' &&
        query.operation === 'update' &&
        query.payload?.status === 'processing'
      ) {
        if (!stateIsPending) return { data: null, error: null };
        stateIsPending = false;
        return { data: completeSignupSession(), error: null };
      }
      if (query.table === 'whatsapp_config' && query.operation === 'select') {
        const selects = query.filters.filter(([method]) => method === 'eq');
        return {
          data: selects.some(([, field]) => field === 'phone_number_id')
            ? null
            : [],
          error: null,
        };
      }
      if (query.table === 'whatsapp_config' && query.operation === 'insert') {
        return { data: { id: 'connection-1' }, error: null };
      }
      return { data: null, error: null };
    };
    h.requestSync.mockImplementation(async (_phoneNumberId, _token, kind) => {
      h.syncCalls.push(kind);
      if (kind === 'smb_app_state_sync') return contactSync;
      return `${kind}-request`;
    });

    const callback = () =>
      completeSignup(
        postJson('/api/whatsapp/embedded-signup/complete', {
          state: 'a'.repeat(64),
          code: 'oauth-code',
          session_info: validSessionInfo,
        })
      );
    const firstCompletion = callback();
    await vi.waitFor(() => expect(h.requestSync).toHaveBeenCalledTimes(1));
    expect(h.requestSync.mock.calls.map(([, , kind]) => kind)).toEqual([
      'smb_app_state_sync',
    ]);

    const duplicateResponse = await callback();
    expect(duplicateResponse.status).toBe(409);
    expect(h.exchange).toHaveBeenCalledOnce();
    expect(h.requestSync).toHaveBeenCalledOnce();

    releaseContactSync('contacts-request');
    const firstResponse = await firstCompletion;

    expect(firstResponse.status).toBe(200);
    expect(h.requestSync.mock.calls.map(([, , kind]) => kind)).toEqual([
      'smb_app_state_sync',
      'history',
    ]);
  });

  it('rejects phone numbers not owned by the returned WABA', async () => {
    configureSuccessfulSignupResolution();
    h.listPhones.mockResolvedValueOnce([
      { id: 'different-phone', display_phone_number: '+15551234567' },
    ]);

    const response = await completeSignup(
      postJson('/api/whatsapp/embedded-signup/complete', {
        state: 'a'.repeat(64),
        code: 'oauth-code',
        session_info: validSessionInfo,
      })
    );

    expect(response.status).toBe(502);
    expect(h.subscribe).not.toHaveBeenCalled();
    expect(h.requestSync).not.toHaveBeenCalled();
    expect(
      h.adminQueries.some(
        (query) =>
          query.table === 'whatsapp_config' && query.operation === 'insert'
      )
    ).toBe(false);
  });

  it('marks a failed authorization exchange as failed and does not create a connection', async () => {
    h.resolveAdminQuery = (query) => {
      if (
        query.table === 'whatsapp_signup_sessions' &&
        query.payload?.status === 'processing'
      ) {
        return {
          data: {
            account_id: 'account-1',
            user_id: 'user-1',
            app_id: '123456',
            configuration_id: '789012',
            verify_token: h.encrypt('webhook-verify-token'),
          },
          error: null,
        };
      }
      if (query.table === 'whatsapp_config' && query.operation === 'select') {
        return { data: [], error: null };
      }
      return { data: null, error: null };
    };
    h.exchange.mockRejectedValueOnce(
      new Error('Meta code exchange unavailable')
    );

    const response = await completeSignup(
      postJson('/api/whatsapp/embedded-signup/complete', {
        state: 'a'.repeat(64),
        code: 'oauth-code',
        session_info: validSessionInfo,
      })
    );
    const failedSession = h.adminQueries.find(
      (query) =>
        query.table === 'whatsapp_signup_sessions' &&
        query.payload?.status === 'failed'
    );

    expect(response.status).toBe(502);
    expect(failedSession?.payload).toMatchObject({
      status: 'failed',
      verify_token: null,
    });
    expect(
      h.adminQueries.some(
        (query) =>
          query.table === 'whatsapp_config' && query.operation === 'insert'
      )
    ).toBe(false);
  });
});
