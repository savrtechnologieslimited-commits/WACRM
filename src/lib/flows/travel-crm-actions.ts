import { createHmac } from 'node:crypto';
import {
  fetchTravelDestinations,
  type TravelDestination,
  type TravelDestinationScope,
} from './travel-destinations';

export interface TravelCrmDestination {
  destination_id: string;
  destination_name: string;
  travel_type: TravelDestinationScope;
  assigned_employee_id: string;
  assignment_status: TravelDestination['assignment_status'];
  pdf_url: string | null;
  pdf_available: boolean;
}

export interface TravelCrmEnquiryPayload {
  version: 1;
  flow_run_id: string;
  flow_id: string;
  wacrm_contact_id: string;
  wacrm_conversation_id: string | null;
  flow_name: string;
  completed_at: string;
  is_partial: boolean;
  handoff_requested: boolean;
  contact: {
    name: string | null;
    email: string | null;
    phone: string | null;
  };
  destination: {
    id: string;
    name: string;
    scope: TravelDestinationScope;
    assignment_status: TravelDestination['assignment_status'];
    assigned_employee_id: string | null;
  } | null;
  answers: Record<string, unknown>;
}

export interface TravelCrmEnquiryResult {
  enquiry_id: string;
  enquiry_number: string;
  customer_id: string;
  lead_id: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function getTravelCrmDestinations(
  scope: TravelDestinationScope,
): Promise<TravelCrmDestination[]> {
  const results = await fetchTravelDestinations(scope);
  return results
    .filter((destination) => destination.assignment_status === 'assigned')
    .map((destination) => {
      if (!UUID_PATTERN.test(destination.id) || !UUID_PATTERN.test(destination.assigned_employee_id)) {
        throw new Error('Travel CRM returned an invalid destination assignment.');
      }
    return {
      destination_id: destination.id,
      destination_name: destination.name,
      travel_type: destination.scope,
      assigned_employee_id: destination.assigned_employee_id,
      assignment_status: destination.assignment_status,
      pdf_url: destination.pdf?.url ?? null,
      pdf_available: destination.pdf !== null,
    };
    });
}

export async function getTravelCrmDestination(
  scope: TravelDestinationScope,
  destinationId: string,
): Promise<TravelCrmDestination> {
  if (!UUID_PATTERN.test(destinationId)) {
    throw new Error('Destination ID is invalid.');
  }
  const destinations = await getTravelCrmDestinations(scope);
  const destination = destinations.find(
    (item) => item.destination_id === destinationId,
  );
  if (!destination) {
    throw new Error('Destination is inactive or has no valid employee assignment.');
  }
  return destination;
}

export async function completeTravelCrmEnquiry(
  payload: TravelCrmEnquiryPayload,
): Promise<TravelCrmEnquiryResult> {
  const endpoint = process.env.TRAVEL_CRM_FLOW_SYNC_URL;
  const response = await signedTravelCrmPost(endpoint, payload, 10_000);
  if (!response.ok) {
    throw new Error(`Travel CRM enquiry completion returned HTTP ${response.status}.`);
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new Error('Travel CRM returned an invalid enquiry completion response.');
  }
  if (!isTravelCrmEnquiryResult(result)) {
    throw new Error('Travel CRM returned an incomplete enquiry completion response.');
  }
  return result;
}

function isTravelCrmEnquiryResult(
  value: unknown,
): value is TravelCrmEnquiryResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.enquiry_id === 'string' &&
    UUID_PATTERN.test(result.enquiry_id) &&
    typeof result.enquiry_number === 'string' &&
    result.enquiry_number.length > 0 &&
    typeof result.customer_id === 'string' &&
    UUID_PATTERN.test(result.customer_id) &&
    typeof result.lead_id === 'string' &&
    UUID_PATTERN.test(result.lead_id)
  );
}

async function signedTravelCrmPost(
  endpointValue: string | undefined,
  payload: unknown,
  timeoutMs: number,
): Promise<Response> {
  const secret = process.env.WACRM_BRIDGE_SECRET;
  if (!endpointValue || !secret || Buffer.byteLength(secret) < 32) {
    throw new Error('Travel CRM integration is not configured.');
  }
  const endpoint = new URL(endpointValue);
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (
    (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && isLocal)) ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error('Travel CRM integration URL must use HTTPS.');
  }

  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-wacrm-timestamp': timestamp,
      'x-wacrm-signature': signature,
    },
    body,
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  });
}
