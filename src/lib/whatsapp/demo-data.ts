import type { MessageTemplate } from '@/types';

export const DEMO_WHATSAPP_NUMBERS = [
  {
    id: 'demo-phone-number-1',
    label: '+1 (555) 010-1001',
    isPrimary: true,
    wabaId: 'demo-waba-1',
  },
  {
    id: 'demo-phone-number-2',
    label: '+44 20 7946 0102',
    isPrimary: false,
    wabaId: 'demo-waba-2',
  },
] as const;

export const DEMO_BROADCAST_TEMPLATE: MessageTemplate = {
  id: 'demo-template-welcome',
  user_id: 'demo-user',
  waba_id: 'demo-waba-1',
  name: 'welcome_offer',
  category: 'Marketing',
  language: 'en_US',
  body_text: 'Hi {{1}}, thanks for connecting with us! Here is your welcome offer.',
  status: 'APPROVED',
  created_at: '2026-01-01T00:00:00.000Z',
};

export const DEMO_BROADCAST_TEMPLATE_SECONDARY: MessageTemplate = {
  ...DEMO_BROADCAST_TEMPLATE,
  id: 'demo-template-shipping',
  waba_id: 'demo-waba-2',
  name: 'shipping_update',
  category: 'Utility',
  body_text: 'Hi {{1}}, your order {{2}} is on its way.',
};

export const isDemoWhatsAppNumber = (id: string) =>
  DEMO_WHATSAPP_NUMBERS.some((number) => number.id === id);

export function getDemoTemplateForNumber(phoneNumberId: string) {
  return phoneNumberId === DEMO_WHATSAPP_NUMBERS[1].id
    ? DEMO_BROADCAST_TEMPLATE_SECONDARY
    : DEMO_BROADCAST_TEMPLATE;
}
