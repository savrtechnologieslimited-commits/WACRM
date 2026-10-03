export type CrmContactMatchResult =
  | {
      status: 'matched';
      contactId: string;
      matchedBy: 'email' | 'phone' | 'email_and_phone';
    }
  | { status: 'ambiguous'; candidateCount: number }
  | { status: 'unmatched' };

export function resolveCrmContactMatch(
  emailContactIds: string[],
  phoneContactIds: string[]
): CrmContactMatchResult {
  const emailMatches = new Set(emailContactIds);
  const phoneMatches = new Set(phoneContactIds);
  const candidates = new Set([...emailMatches, ...phoneMatches]);

  if (candidates.size === 0) return { status: 'unmatched' };
  if (candidates.size > 1) {
    return { status: 'ambiguous', candidateCount: candidates.size };
  }

  const [contactId] = candidates;
  if (!contactId) return { status: 'unmatched' };
  const matchedBy =
    emailMatches.has(contactId) && phoneMatches.has(contactId)
      ? 'email_and_phone'
      : emailMatches.has(contactId)
        ? 'email'
        : 'phone';

  return { status: 'matched', contactId, matchedBy };
}
