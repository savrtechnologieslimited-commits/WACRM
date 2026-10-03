import { createHmac, timingSafeEqual } from 'node:crypto';

export type WacrmBridgeClaims = {
  version: 1;
  purpose: 'signin' | 'contact-match';
  audience: string;
  crmUserId: string;
  email: string;
  fullName: string;
  issuer: string;
  record?: {
    type: 'lead' | 'customer';
    id: string;
    email: string | null;
    phones: string[];
  };
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

export class InvalidBridgeTokenError extends Error {
  constructor(
    readonly reason:
      | 'malformed'
      | 'signature'
      | 'claims'
      | 'expired'
      | 'issuer'
      | 'audience',
    readonly expectedAudience?: string,
    readonly actualAudience?: string
  ) {
    super('Invalid or expired CRM bridge token.');
    this.name = 'InvalidBridgeTokenError';
  }
}

export class BridgeConfigurationError extends Error {
  constructor() {
    super('WACRM_BRIDGE_SECRET must contain at least 32 bytes.');
    this.name = 'BridgeConfigurationError';
  }
}

export function verifyWacrmBridgeToken(
  token: string,
  secret: string,
  requestOrigin: string | null,
  requestAudience: string,
  now = Math.floor(Date.now() / 1000)
): WacrmBridgeClaims {
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new BridgeConfigurationError();
  }
  if (token.length > 4096) throw new InvalidBridgeTokenError('malformed');

  const parts = token.split('.');
  if (parts.length !== 2) throw new InvalidBridgeTokenError('malformed');

  const [encodedClaims, encodedSignature] = parts;
  if (!encodedClaims || !encodedSignature) {
    throw new InvalidBridgeTokenError('malformed');
  }
  const expectedSignature = createHmac('sha256', secret)
    .update(encodedClaims)
    .digest();
  const suppliedSignature = Buffer.from(encodedSignature, 'base64url');
  if (
    expectedSignature.length !== suppliedSignature.length ||
    !timingSafeEqual(expectedSignature, suppliedSignature)
  ) {
    throw new InvalidBridgeTokenError('signature');
  }

  let claims: unknown;
  try {
    claims = JSON.parse(
      Buffer.from(encodedClaims, 'base64url').toString('utf8')
    ) as unknown;
  } catch {
    throw new InvalidBridgeTokenError('malformed');
  }

  if (!isBridgeClaims(claims)) throw new InvalidBridgeTokenError('claims');
  if (
    claims.expiresAt <= now ||
    claims.issuedAt > now + 5 ||
    claims.expiresAt - claims.issuedAt > 60
  ) {
    throw new InvalidBridgeTokenError('expired');
  }
  if (claims.issuer !== requestOrigin) {
    throw new InvalidBridgeTokenError('issuer');
  }
  if (claims.audience !== requestAudience) {
    throw new InvalidBridgeTokenError(
      'audience',
      requestAudience,
      claims.audience
    );
  }

  return claims;
}

function isBridgeClaims(value: unknown): value is WacrmBridgeClaims {
  if (!value || typeof value !== 'object') return false;
  const claims = value as Record<string, unknown>;

  return (
    claims.version === 1 &&
    (claims.purpose === 'signin' || claims.purpose === 'contact-match') &&
    typeof claims.audience === 'string' &&
    isHttpOrigin(claims.audience) &&
    typeof claims.crmUserId === 'string' &&
    /^[0-9a-f-]{36}$/i.test(claims.crmUserId) &&
    typeof claims.email === 'string' &&
    claims.email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email) &&
    typeof claims.fullName === 'string' &&
    claims.fullName.length <= 120 &&
    typeof claims.issuer === 'string' &&
    isHttpOrigin(claims.issuer) &&
    (claims.purpose !== 'contact-match' || isContactMatchRecord(claims.record)) &&
    (claims.purpose !== 'signin' || claims.record === undefined) &&
    Number.isSafeInteger(claims.issuedAt) &&
    Number.isSafeInteger(claims.expiresAt) &&
    typeof claims.nonce === 'string' &&
    /^[0-9a-f-]{36}$/i.test(claims.nonce)
  );
}

function isContactMatchRecord(
  value: unknown
): value is NonNullable<WacrmBridgeClaims['record']> {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;

  return (
    (record.type === 'lead' || record.type === 'customer') &&
    typeof record.id === 'string' &&
    /^[0-9a-f-]{36}$/i.test(record.id) &&
    (record.email === null ||
      (typeof record.email === 'string' &&
        record.email.length <= 254 &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.email))) &&
    Array.isArray(record.phones) &&
    record.phones.length <= 2 &&
    record.phones.every(
      (phone) => typeof phone === 'string' && /^\d{7,15}$/.test(phone)
    )
  );
}

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      !url.username &&
      !url.password &&
      ['http:', 'https:'].includes(url.protocol)
    );
  } catch {
    return false;
  }
}
