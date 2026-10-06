import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  completeTravelCrmEnquiry,
  getTravelCrmDestination,
  getTravelCrmDestinations,
  type TravelCrmEnquiryPayload,
} from './travel-crm-actions';

const SECRET = 'a-32-byte-or-longer-shared-bridge-secret';
const DESTINATION_ID = '00000000-0000-4000-8000-000000000001';
const EMPLOYEE_ID = '11111111-1111-4111-8111-111111111111';
const ENQUIRY_RESULT = {
  customer_id: '22222222-2222-4222-8222-222222222222',
  lead_id: '33333333-3333-4333-8333-333333333333',
  enquiry_id: '44444444-4444-4444-8444-444444444444',
  enquiry_number: 'ENQ-0001',
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function stubDestinationLookup() {
  vi.stubEnv(
    'TRAVEL_CRM_DESTINATIONS_URL',
    'https://travel.example/api/wacrm/destinations'
  );
  vi.stubEnv('WACRM_BRIDGE_SECRET', SECRET);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        version: 1,
        scope: 'domestic',
        destinations: [
          {
            id: DESTINATION_ID,
            name: 'Goa',
            scope: 'domestic',
            pdf: {
              name: 'Goa.pdf',
              url: 'https://travel.example/signed/goa.pdf?token=temporary',
            },
            assignment_status: 'assigned',
            assigned_employee_id: EMPLOYEE_ID,
          },
          {
            id: '00000000-0000-4000-8000-000000000002',
            name: 'Unassigned',
            scope: 'domestic',
            pdf: null,
            assignment_status: 'unassigned',
            assigned_employee_id: EMPLOYEE_ID,
          },
        ],
      })
    )
  );
}

describe('Travel CRM destination actions', () => {
  it('returns only assigned destinations with their CRM PDF metadata', async () => {
    stubDestinationLookup();

    await expect(getTravelCrmDestinations('domestic')).resolves.toEqual([
      {
        destination_id: DESTINATION_ID,
        destination_name: 'Goa',
        travel_type: 'domestic',
        assigned_employee_id: EMPLOYEE_ID,
        assignment_status: 'assigned',
        pdf_url: 'https://travel.example/signed/goa.pdf?token=temporary',
        pdf_available: true,
      },
    ]);
  });

  it('looks up a destination by ID from the current CRM result', async () => {
    stubDestinationLookup();
    await expect(
      getTravelCrmDestination('domestic', DESTINATION_ID)
    ).resolves.toMatchObject({
      destination_id: DESTINATION_ID,
      destination_name: 'Goa',
      assigned_employee_id: EMPLOYEE_ID,
    });
    await expect(
      getTravelCrmDestination('international', DESTINATION_ID)
    ).rejects.toThrow('invalid response');
  });
});

describe('Travel CRM enquiry completion callback', () => {
  it('sends the existing completion payload with timestamped HMAC and validates the response', async () => {
    vi.stubEnv(
      'TRAVEL_CRM_FLOW_SYNC_URL',
      'https://travel.example/api/wacrm/flow-completed'
    );
    vi.stubEnv('WACRM_BRIDGE_SECRET', SECRET);
    const request = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json(ENQUIRY_RESULT)
    );
    vi.stubGlobal('fetch', request);
    const payload: TravelCrmEnquiryPayload = {
      version: 1,
      flow_run_id: '55555555-5555-4555-8555-555555555555',
      flow_id: '66666666-6666-4666-8666-666666666666',
      wacrm_contact_id: '77777777-7777-4777-8777-777777777777',
      wacrm_conversation_id: null,
      flow_name: 'Travel Enquiry',
      completed_at: '2026-01-01T00:00:00.000Z',
      is_partial: false,
      handoff_requested: false,
      contact: {
        name: 'Sam',
        email: null,
        phone: '+919876543210',
      },
      destination: {
        id: DESTINATION_ID,
        name: 'Goa',
        scope: 'domestic',
        assignment_status: 'assigned',
        assigned_employee_id: EMPLOYEE_ID,
      },
      answers: { travel_date: '2026-12-01', adults: '2' },
    };

    await expect(completeTravelCrmEnquiry(payload)).resolves.toEqual(
      ENQUIRY_RESULT
    );
    const [url, init] = request.mock.calls[0];
    expect(url).toBeInstanceOf(URL);
    if (!init) throw new Error('fetch init was not provided');
    expect(init.method).toBe('POST');
    const body = String(init.body);
    expect(JSON.parse(body)).toEqual(payload);
    const headers = new Headers(init.headers);
    const expectedSignature = createHmac('sha256', SECRET)
      .update(`${headers.get('x-wacrm-timestamp')}.${body}`)
      .digest('hex');
    expect(headers.get('x-wacrm-signature')).toBe(expectedSignature);
  });

  it('rejects a success response without canonical enquiry identifiers', async () => {
    vi.stubEnv(
      'TRAVEL_CRM_FLOW_SYNC_URL',
      'https://travel.example/api/wacrm/flow-completed'
    );
    vi.stubEnv('WACRM_BRIDGE_SECRET', SECRET);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })));
    const payload = {
      version: 1,
      flow_run_id: '55555555-5555-4555-8555-555555555555',
      flow_id: '66666666-6666-4666-8666-666666666666',
      wacrm_contact_id: '77777777-7777-4777-8777-777777777777',
      wacrm_conversation_id: null,
      flow_name: 'Travel Enquiry',
      completed_at: '2026-01-01T00:00:00.000Z',
      is_partial: false,
      handoff_requested: false,
      contact: { name: 'Sam', email: null, phone: '+919876543210' },
      destination: null,
      answers: {},
    } satisfies TravelCrmEnquiryPayload;

    await expect(completeTravelCrmEnquiry(payload)).rejects.toThrow(
      'incomplete enquiry completion response'
    );
  });
});
