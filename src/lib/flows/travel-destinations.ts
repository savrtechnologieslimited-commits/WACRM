import { createHmac } from 'node:crypto';

export type TravelDestinationScope = 'domestic' | 'international';
export type DestinationAssignmentStatus =
  'assigned' | 'unassigned' | 'ambiguous';

export interface TravelDestination {
  id: string;
  name: string;
  scope: TravelDestinationScope;
  pdf: { name: string; url: string } | null;
  assignment_status: DestinationAssignmentStatus;
  assigned_employee_id: string;
}

interface DestinationLookupResponse {
  version: 1;
  scope: TravelDestinationScope;
  destinations: TravelDestination[];
}

export interface DestinationListRow {
  id: string;
  title: string;
  description?: string;
}

export interface DestinationPage {
  rows: DestinationListRow[];
  pageCount: number;
}

const DESTINATION_PAGE_SIZE = 8;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function fetchTravelDestinations(
  scope: TravelDestinationScope
): Promise<TravelDestination[]> {
  const endpoint = process.env.TRAVEL_CRM_DESTINATIONS_URL;
  const secret = process.env.WACRM_BRIDGE_SECRET;
  if (!endpoint || !secret || Buffer.byteLength(secret) < 32) {
    throw new Error('Travel destination lookup is not configured');
  }

  const url = new URL(endpoint);
  const isLocal =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]';
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) ||
    url.username ||
    url.password
  ) {
    throw new Error('Travel destination lookup URL must use HTTPS');
  }

  const body = JSON.stringify({ scope });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-wacrm-timestamp': timestamp,
      'x-wacrm-signature': signature,
    },
    body,
    cache: 'no-store',
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new Error(
      `Travel destination lookup returned HTTP ${response.status}`
    );
  }

  const payload = (await response.json()) as Partial<DestinationLookupResponse>;
  if (
    payload.version !== 1 ||
    payload.scope !== scope ||
    !Array.isArray(payload.destinations)
  ) {
    throw new Error('Travel destination lookup returned an invalid response');
  }

  return payload.destinations.map((destination) => {
    if (
      !destination ||
      typeof destination.id !== 'string' ||
      !UUID_PATTERN.test(destination.id) ||
      typeof destination.name !== 'string' ||
      !destination.name.trim() ||
      destination.scope !== scope ||
      !['assigned', 'unassigned', 'ambiguous'].includes(
        destination.assignment_status
      ) ||
      typeof destination.assigned_employee_id !== 'string' ||
      !UUID_PATTERN.test(destination.assigned_employee_id)
    ) {
      throw new Error(
        'Travel destination lookup returned an invalid destination'
      );
    }
    let pdf: TravelDestination['pdf'] = null;
    if (destination.pdf !== null) {
      if (
        !destination.pdf ||
        typeof destination.pdf.name !== 'string' ||
        typeof destination.pdf.url !== 'string'
      ) {
        throw new Error('Travel destination lookup returned an invalid PDF');
      }
      const pdfUrl = new URL(destination.pdf.url);
      if (
        (pdfUrl.protocol !== 'https:' &&
          !(
            pdfUrl.protocol === 'http:' &&
            ['localhost', '127.0.0.1', '[::1]'].includes(pdfUrl.hostname)
          )) ||
        pdfUrl.username ||
        pdfUrl.password
      ) {
        throw new Error('Travel destination lookup returned an unsafe PDF URL');
      }
      pdf = { name: destination.pdf.name, url: pdfUrl.toString() };
    }
    return {
      id: destination.id,
      name: destination.name.trim(),
      scope,
      pdf,
      assignment_status: destination.assignment_status,
      assigned_employee_id: destination.assigned_employee_id,
    };
  });
}

export function buildDestinationPage(
  destinations: TravelDestination[],
  requestedPage: number
): DestinationPage {
  const pageCount = Math.max(
    1,
    Math.ceil(destinations.length / DESTINATION_PAGE_SIZE)
  );
  const page = Math.min(
    Math.max(Math.floor(requestedPage) || 0, 0),
    pageCount - 1
  );
  const start = page * DESTINATION_PAGE_SIZE;
  const rows = destinations
    .slice(start, start + DESTINATION_PAGE_SIZE)
    .map((destination) => ({
      id: `destination:${destination.id}`,
      title: destination.name.slice(0, 24),
    }));

  if (page > 0)
    rows.push({ id: 'destination:previous', title: 'Previous page' });
  if (page < pageCount - 1)
    rows.push({ id: 'destination:next', title: 'Next page' });

  return { rows, pageCount };
}
