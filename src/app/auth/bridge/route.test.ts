import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  generateLink: vi.fn(),
  maybeSingle: vi.fn(),
  consumeBridgeNonce: vi.fn(),
}));

vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({
    auth: { admin: { generateLink: mocks.generateLink } },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: mocks.maybeSingle }),
      }),
    }),
  }),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: mocks.createClient,
}));

vi.mock('@/lib/auth/consume-bridge-nonce', () => ({
  consumeBridgeNonce: mocks.consumeBridgeNonce,
}));

import { POST } from './route';

const BRIDGE_SECRET = 'test-bridge-secret-that-is-at-least-32-bytes';

function createBridgeToken() {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    version: 1,
    purpose: 'signin',
    audience: 'https://wacrm.example.test',
    crmUserId: '00000000-0000-4000-8000-000000000001',
    email: 'staff@example.test',
    fullName: 'Staff User',
    issuer: 'https://crm.example.test',
    issuedAt: now,
    expiresAt: now + 60,
    nonce: '00000000-0000-4000-8000-000000000002',
  };
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString(
    'base64url'
  );
  const signature = createHmac('sha256', BRIDGE_SECRET)
    .update(encodedClaims)
    .digest('base64url');
  return `${encodedClaims}.${signature}`;
}

function createBridgeRequest() {
  const body = new URLSearchParams({
    token: createBridgeToken(),
    next: '/inbox',
  });
  return new NextRequest('https://wacrm.example.test/auth/bridge', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://crm.example.test',
    },
    body,
  });
}

function createSupabaseClient(getUserResult: unknown) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue(getUserResult),
      verifyOtp: vi.fn().mockResolvedValue({ error: null }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
    },
  };
}

beforeEach(() => {
  process.env.WACRM_BRIDGE_SECRET = BRIDGE_SECRET;
  mocks.createClient.mockReset();
  mocks.generateLink.mockReset().mockResolvedValue({
    data: { properties: { hashed_token: 'magic-link-hash' } },
    error: null,
  });
  mocks.maybeSingle.mockReset().mockResolvedValue({ data: null, error: null });
  mocks.consumeBridgeNonce.mockReset().mockResolvedValue({ ok: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /auth/bridge', () => {
  it('sends a CRM user without a WACRM profile to the sign-in page', async () => {
    const client = createSupabaseClient({
      data: { user: null },
      error: Object.assign(new Error('Auth session missing!'), {
        name: 'AuthSessionMissingError',
      }),
    });
    mocks.createClient.mockResolvedValue(client);

    const response = await POST(createBridgeRequest());

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      'https://wacrm.example.test/login?next=%2Finbox'
    );
    expect(mocks.generateLink).not.toHaveBeenCalled();
    expect(client.auth.verifyOtp).not.toHaveBeenCalled();
  });

  it('continues sign-in for an existing WACRM profile without a session', async () => {
    const client = createSupabaseClient({
      data: { user: null },
      error: Object.assign(new Error('Auth session missing!'), {
        name: 'AuthSessionMissingError',
      }),
    });
    mocks.createClient.mockResolvedValue(client);
    mocks.maybeSingle.mockResolvedValue({
      data: { user_id: 'existing-wacrm-user' },
      error: null,
    });

    const response = await POST(createBridgeRequest());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('Secure sign-in complete. Opening WhatsApp CRM');
    expect(mocks.generateLink).toHaveBeenCalledOnce();
    expect(client.auth.verifyOtp).toHaveBeenCalledWith({
      token_hash: 'magic-link-hash',
      type: 'magiclink',
    });
  });

  it('clears a different WACRM session and requires sign-in', async () => {
    const activeClient = createSupabaseClient({
      data: { user: { email: 'another-user@example.test' } },
      error: null,
    });
    const signOutClient = createSupabaseClient({
      data: { user: null },
      error: null,
    });
    mocks.createClient
      .mockResolvedValueOnce(activeClient)
      .mockResolvedValueOnce(signOutClient);

    const response = await POST(createBridgeRequest());

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      'https://wacrm.example.test/login?next=%2Finbox'
    );
    expect(signOutClient.auth.signOut).toHaveBeenCalledOnce();
    expect(mocks.generateLink).not.toHaveBeenCalled();
  });

  it('returns a server error for unexpected session verification failures', async () => {
    mocks.createClient.mockResolvedValue(
      createSupabaseClient({
        data: { user: null },
        error: new Error('Supabase is unavailable'),
      })
    );

    const response = await POST(createBridgeRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'WACRM could not verify the current account.',
    });
    expect(mocks.generateLink).not.toHaveBeenCalled();
  });
});
