import { describe, expect, it } from 'vitest';
import { resolveCrmContactMatch } from './crm-contact-match';

describe('resolveCrmContactMatch', () => {
  it('matches a unique email or phone candidate', () => {
    expect(resolveCrmContactMatch(['contact-a'], [])).toEqual({
      status: 'matched',
      contactId: 'contact-a',
      matchedBy: 'email',
    });
    expect(resolveCrmContactMatch([], ['contact-b'])).toEqual({
      status: 'matched',
      contactId: 'contact-b',
      matchedBy: 'phone',
    });
  });

  it('reports both keys when they identify the same unique contact', () => {
    expect(resolveCrmContactMatch(['contact-a'], ['contact-a'])).toEqual({
      status: 'matched',
      contactId: 'contact-a',
      matchedBy: 'email_and_phone',
    });
  });

  it('leaves different candidates ambiguous and no candidates unmatched', () => {
    expect(resolveCrmContactMatch(['contact-a'], ['contact-b'])).toEqual({
      status: 'ambiguous',
      candidateCount: 2,
    });
    expect(resolveCrmContactMatch([], [])).toEqual({ status: 'unmatched' });
  });
});
