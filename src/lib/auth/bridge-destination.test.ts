import { describe, expect, it } from 'vitest';

import { resolveBridgeDestination } from './bridge-destination';

const requestUrl = 'https://wacrm.example/auth/bridge';

describe('resolveBridgeDestination', () => {
  it('uses the dashboard when no destination is provided', () => {
    expect(resolveBridgeDestination(null, requestUrl)?.pathname).toBe(
      '/dashboard'
    );
  });

  it('accepts a same-origin inbox deep link', () => {
    const destination = resolveBridgeDestination(
      '/inbox?c=conversation-id',
      requestUrl
    );
    expect(destination?.origin).toBe('https://wacrm.example');
    expect(destination?.pathname).toBe('/inbox');
    expect(destination?.searchParams.get('c')).toBe('conversation-id');
  });

  it.each([
    'https://attacker.example/inbox',
    '//attacker.example/inbox',
    '/\\attacker.example/inbox',
    '/%5c%5cattacker.example/inbox',
  ])('rejects unsafe destination %s', (value) => {
    expect(resolveBridgeDestination(value, requestUrl)).toBeNull();
  });
});
