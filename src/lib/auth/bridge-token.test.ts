import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  BridgeConfigurationError,
  InvalidBridgeTokenError,
  verifyWacrmBridgeToken,
} from './bridge-token';

const secret = 'a'.repeat(32);
const issuer = 'http://localhost:5173';
const audience = 'http://localhost:3000';

function signClaims(overrides: Record<string, unknown> = {}) {
  const issuedAt = 1_800_000_000;
  const claims = {
    version: 1,
    purpose: 'signin',
    audience,
    crmUserId: randomUUID(),
    email: 'user@example.com',
    fullName: 'CRM User',
    issuer,
    issuedAt,
    expiresAt: issuedAt + 60,
    nonce: randomUUID(),
    ...overrides,
  };
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString(
    'base64url'
  );
  const signature = createHmac('sha256', secret)
    .update(encodedClaims)
    .digest('base64url');
  return `${encodedClaims}.${signature}`;
}

describe('verifyWacrmBridgeToken', () => {
  it('accepts valid sign-in tokens only for the signed CRM origin', () => {
    const claims = verifyWacrmBridgeToken(
      signClaims(),
      secret,
      issuer,
      audience,
      1_800_000_030
    );
    expect(claims.purpose).toBe('signin');
  });

  it('accepts a validated contact-match payload', () => {
    const claims = verifyWacrmBridgeToken(
      signClaims({
        purpose: 'contact-match',
        record: {
          type: 'lead',
          id: randomUUID(),
          email: 'traveler@example.com',
          phones: ['15551234567'],
        },
      }),
      secret,
      issuer,
      audience,
      1_800_000_030
    );
    expect(claims.record?.phones).toEqual(['15551234567']);
  });

  it('rejects modified, expired, wrong-origin, and malformed tokens', () => {
    const token = signClaims();
    expect(() =>
      verifyWacrmBridgeToken(
        `${token.slice(0, -1)}x`,
        secret,
        issuer,
        audience,
        1_800_000_030
      )
    ).toThrow(InvalidBridgeTokenError);
    expect(() =>
      verifyWacrmBridgeToken(
        token,
        secret,
        issuer,
        audience,
        1_800_000_061
      )
    ).toThrow(InvalidBridgeTokenError);
    expect(() =>
      verifyWacrmBridgeToken(
        token,
        secret,
        'https://attacker.example',
        audience,
        1_800_000_030
      )
    ).toThrow(InvalidBridgeTokenError);
    expect(() =>
      verifyWacrmBridgeToken(
        signClaims({
          purpose: 'contact-match',
          record: {
            type: 'lead',
            id: randomUUID(),
            email: 'traveler@example.com',
            phones: ['not-a-phone'],
          },
        }),
        secret,
        issuer,
        audience,
        1_800_000_030
      )
    ).toThrow(InvalidBridgeTokenError);
  });

  it('rejects weak secrets', () => {
    expect(() =>
      verifyWacrmBridgeToken(
        signClaims(),
        'short',
        issuer,
        audience,
        1_800_000_030
      )
    ).toThrow(BridgeConfigurationError);
  });
});
