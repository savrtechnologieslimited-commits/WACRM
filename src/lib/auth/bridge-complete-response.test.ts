import { describe, expect, it } from 'vitest';

import { createBridgeCompleteResponse } from './bridge-complete-response';

describe('createBridgeCompleteResponse', () => {
  it('notifies the CRM parent and navigates to the requested WACRM page', async () => {
    const response = createBridgeCompleteResponse(
      new URL('https://wacrm.example/inbox?contact=contact-123'),
      'https://crm.example'
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toContain("window.parent.postMessage({ type: 'wacrm:dashboard-ready' }");
    expect(html).toContain("event.origin === parentOrigin");
    expect(html).toContain('"/inbox?contact=contact-123"');
  });
});
