import { describe, expect, it } from 'vitest';
import { parseBroadcastCsv } from './broadcast-csv';

describe('parseBroadcastCsv', () => {
  it('parses phone + name into the audience shape', () => {
    const result = parseBroadcastCsv(
      `phone,name
+14155552671,Ada
+14155552672,Grace`
    );

    expect(result).toEqual({
      ok: true,
      duplicates: 0,
      invalid: 0,
      contacts: [
        { phone: '+14155552671', name: 'Ada' },
        { phone: '+14155552672', name: 'Grace' },
      ],
    });
  });

  it('omits name when the column is absent', () => {
    const result = parseBroadcastCsv(    `phone\n+14155552671`);
    expect(result).toEqual({
      ok: true,
      duplicates: 0,
      invalid: 0,
      contacts: [{ phone: '+14155552671' }],
    });
  });

  it('drops the extra columns the importer understands', () => {
    const result = parseBroadcastCsv(
      `phone,name,email,company,tags
+14155552671,Ada,ada@example.com,Analytical Engines,"VIP, Lead"`
    );
    expect(result).toEqual({
      ok: true,
      duplicates: 0,
      invalid: 0,
      contacts: [{ phone: '+14155552671', name: 'Ada' }],
    });
  });

  it('tolerates any column order', () => {
    const result = parseBroadcastCsv(    `name,phone\nAda,+14155552671`);
    expect(result).toEqual({
      ok: true,
      duplicates: 0,
      invalid: 0,
      contacts: [{ phone: '+14155552671', name: 'Ada' }],
    });
  });

  // The downstream upsert inserts against UNIQUE (account_id,
  // phone_normalized) (migration 022). If two spellings of one number
  // both reached it, the whole broadcast would die on a 23505 — so
  // collapsing them here is the fix, not a nicety.
  it('collapses differently-formatted spellings of the same number', () => {
    const result = parseBroadcastCsv(
      `phone,name
+1 (415) 555-2671,Ada
+1-415-555-2671,Ada Again`
    );

    expect(result).toEqual({
      ok: true,
      duplicates: 1,
      invalid: 0,
      contacts: [{ phone: '+14155552671', name: 'Ada' }],
    });
  });

  it('uses the selected default country and rejects invalid national lengths', () => {
    const result = parseBroadcastCsv(
      `phone,name
9876543210,National IN
987654321,Bad short
09876543210,Bad long`,
    );

    expect(result).toEqual({
      ok: true,
      duplicates: 0,
      invalid: 2,
      contacts: [{ phone: '+919876543210', name: 'National IN' }],
    });
  });

  it('uses a non-India country when selected', () => {
    expect(parseBroadcastCsv(`phone,name\n4155552671,Ada`, 'US')).toEqual({
      ok: true,
      duplicates: 0,
      invalid: 0,
      contacts: [{ phone: '+14155552671', name: 'Ada' }],
    });
  });

  it('reports no_valid_rows when every number is invalid', () => {
    expect(parseBroadcastCsv(`phone,name\n987654321,Ada`)).toEqual({
      ok: false,
      error: 'no_valid_rows',
    });
  });

  it('reports a missing phone header distinctly from an empty file', () => {
    expect(parseBroadcastCsv(`name,email\nAda,ada@example.com`)).toEqual({
      ok: false,
      error: 'missing_phone_column',
    });
    // No header at all reads the same way — there is no `phone` column.
    expect(parseBroadcastCsv('')).toEqual({
      ok: false,
      error: 'missing_phone_column',
    });
  });

  it('reports no_valid_rows when the header is good but no number is', () => {
    expect(parseBroadcastCsv(`phone,name\n,Ada\n"",Grace`)).toEqual({
      ok: false,
      error: 'no_valid_rows',
    });
  });

  it('handles CRLF line endings and a trailing newline', () => {
    const result = parseBroadcastCsv(
      'phone,name\r\n+14155552671,Ada\r\n+14155552672,Grace\r\n'
    );
    expect(result).toEqual({
      ok: true,
      duplicates: 0,
      invalid: 0,
      contacts: [
        { phone: '+14155552671', name: 'Ada' },
        { phone: '+14155552672', name: 'Grace' },
      ],
    });
  });
});
