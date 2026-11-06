import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COEXISTENCE_FINISH_EVENT,
  getEmbeddedSignupAppSecret,
  hashSignupState,
  parseCoexistenceSessionInfo,
} from './embedded-signup';

describe('Meta Embedded Signup callback validation', () => {
  it('accepts only the documented Coexistence completion payload', () => {
    expect(
      parseCoexistenceSessionInfo({
        type: 'WA_EMBEDDED_SIGNUP',
        event: COEXISTENCE_FINISH_EVENT,
        data: { waba_id: '123456', phone_number_id: '789012' },
      })
    ).toEqual({
      type: 'WA_EMBEDDED_SIGNUP',
      event: COEXISTENCE_FINISH_EVENT,
      data: { waba_id: '123456', phone_number_id: '789012' },
    });
  });

  it('accepts the documented payload when it omits an undocumented version field', () => {
    expect(
      parseCoexistenceSessionInfo({
        type: 'WA_EMBEDDED_SIGNUP',
        event: COEXISTENCE_FINISH_EVENT,
        data: {
          waba_id: '123456',
          phone_number_id: '789012',
          business_id: '345678',
        },
      })
    ).toEqual({
      type: 'WA_EMBEDDED_SIGNUP',
      event: COEXISTENCE_FINISH_EVENT,
      data: {
        waba_id: '123456',
        phone_number_id: '789012',
        business_id: '345678',
      },
    });
  });

  it('accepts the v5 messaging account payload and normalizes it to a WABA ID', () => {
    expect(
      parseCoexistenceSessionInfo({
        type: 'WA_EMBEDDED_SIGNUP',
        event: COEXISTENCE_FINISH_EVENT,
        data: {
          phone_number_id: '789012',
          messaging_account_ids: ['123456'],
          primary_waac_ids: [],
          is_on_biz_app: true,
        },
      })
    ).toEqual({
      type: 'WA_EMBEDDED_SIGNUP',
      event: COEXISTENCE_FINISH_EVENT,
      data: { waba_id: '123456', phone_number_id: '789012' },
    });
  });

  it('rejects v5 results with ambiguous messaging account IDs', () => {
    expect(
      parseCoexistenceSessionInfo({
        type: 'WA_EMBEDDED_SIGNUP',
        event: COEXISTENCE_FINISH_EVENT,
        data: {
          phone_number_id: '789012',
          messaging_account_ids: ['123456', '654321'],
        },
      })
    ).toBeNull();
  });

  describe('Embedded Signup app secret selection', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('reuses the existing app secret when only one Meta app is configured', () => {
      vi.stubEnv('META_EMBEDDED_SIGNUP_APP_SECRET', '');
      vi.stubEnv('META_APP_SECRET', 'existing-app-secret');

      expect(getEmbeddedSignupAppSecret()).toBe('existing-app-secret');
    });

    it('requires a dedicated secret when multiple app secrets are configured', () => {
      vi.stubEnv('META_EMBEDDED_SIGNUP_APP_SECRET', '');
      vi.stubEnv('META_APP_SECRET', 'first-secret,second-secret');

      expect(getEmbeddedSignupAppSecret()).toBeNull();
    });
  });

  it.each([
    null,
    {},
    { type: 'OTHER', event: COEXISTENCE_FINISH_EVENT, data: {} },
    { type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: {} },
    {
      type: 'WA_EMBEDDED_SIGNUP',
      event: COEXISTENCE_FINISH_EVENT,
      data: { waba_id: 'not-a-meta-id', phone_number_id: '456' },
    },
  ])('rejects invalid or non-Coexistence callback payloads', (payload) => {
    expect(parseCoexistenceSessionInfo(payload)).toBeNull();
  });

  it('hashes signup state deterministically without retaining the input', () => {
    const state = 'random-one-time-state';
    const hash = hashSignupState(state);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(state);
    expect(hashSignupState(state)).toBe(hash);
  });
});
