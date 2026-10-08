import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildDestinationPage,
  fetchTravelDestinations,
  type TravelDestination,
} from './travel-destinations';

const SECRET = 'a-32-byte-or-longer-shared-bridge-secret';
const EMPLOYEE_ID = '11111111-1111-4111-8111-111111111111';

function destinationId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('signed Travel CRM destination lookup', () => {
  it('POSTs the exact raw JSON with the timestamped HMAC headers', async () => {
    vi.stubEnv(
      'TRAVEL_CRM_DESTINATIONS_URL',
      'https://travel.example/api/wacrm/destinations'
    );
    vi.stubEnv('WACRM_BRIDGE_SECRET', SECRET);
    const payload = {
      version: 1,
      scope: 'domestic',
      destinations: [
        {
          id: destinationId(1),
          name: 'Goa',
          scope: 'domestic',
          pdf: null,
          assignment_status: 'assigned',
          assigned_employee_id: EMPLOYEE_ID,
        },
      ],
    };
    const request = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void input;
        void init;
        return Response.json(payload);
      }
    );
    vi.stubGlobal('fetch', request);

    const destinations = await fetchTravelDestinations('domestic');

    expect(destinations).toEqual(payload.destinations);
    const [url, init] = request.mock.calls[0];
    if (!init) throw new Error('fetch init was not provided');
    expect(url).toBeInstanceOf(URL);
    expect((init as RequestInit).method).toBe('POST');
    const body = String(init.body);
    expect(body).toBe('{"scope":"domestic"}');
    const timestamp = Number(
      new Headers(init.headers).get('x-wacrm-timestamp')
    );
    const expected = createHmac('sha256', SECRET)
      .update(`${timestamp}.${body}`)
      .digest('hex');
    expect(new Headers(init.headers).get('x-wacrm-signature')).toBe(expected);
  });

  it('rejects a response for a different scope', async () => {
    vi.stubEnv(
      'TRAVEL_CRM_DESTINATIONS_URL',
      'https://travel.example/api/wacrm/destinations'
    );
    vi.stubEnv('WACRM_BRIDGE_SECRET', SECRET);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ version: 1, scope: 'international', destinations: [] })
      )
    );

    await expect(fetchTravelDestinations('domestic')).rejects.toThrow(
      'invalid response'
    );
  });
});

describe('destination list pagination', () => {
  const destinations: TravelDestination[] = Array.from(
    { length: 23 },
    (_, index) => ({
      id: destinationId(index + 1),
      name: `Destination ${index + 1}`,
      scope: 'domestic',
      pdf: null,
      assignment_status: 'assigned',
      assigned_employee_id: EMPLOYEE_ID,
    })
  );

  it('exposes every destination across pages while keeping each Meta list within ten rows', () => {
    const pages = [0, 1, 2].map((page) =>
      buildDestinationPage(destinations, page)
    );
    const choices = pages.flatMap((page) =>
      page.rows
        .filter((row) => row.id.startsWith('destination:00000000-'))
        .map((row) => row.id)
    );

    expect(pages.every((page) => page.rows.length <= 10)).toBe(true);
    expect(choices).toHaveLength(destinations.length);
    expect(new Set(choices).size).toBe(destinations.length);
    expect(pages[0].rows.at(-1)).toEqual({
      id: 'destination:next',
      title: 'Next page',
    });
    expect(pages[1].rows.map((row) => row.id)).toContain(
      'destination:previous'
    );
    expect(pages[2].rows.map((row) => row.id)).toContain(
      'destination:previous'
    );
  });
});
