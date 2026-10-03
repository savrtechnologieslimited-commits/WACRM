'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import { MessageTemplate } from '@/types';
import { Step1ChooseTemplate } from '@/components/broadcasts/step1-choose-template';
import { Step2SelectAudience } from '@/components/broadcasts/step2-select-audience';
import { Step3Personalize } from '@/components/broadcasts/step3-personalize';
import { Step4ScheduleSend } from '@/components/broadcasts/step4-schedule-send';
import { useBroadcastSending } from '@/hooks/use-broadcast-sending';
import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  DEMO_WHATSAPP_NUMBERS,
  isDemoWhatsAppNumber,
} from '@/lib/whatsapp/demo-data';

const steps = [
  { label: 'template', key: 'template' },
  { label: 'audience', key: 'audience' },
  { label: 'personalize', key: 'personalize' },
  { label: 'send', key: 'send' },
] as const;

export default function NewBroadcastPage() {
  const router = useRouter();
  const t = useTranslations('Broadcasts.new');
  const { accountId } = useAuth();
  const { createAndSendBroadcast, isProcessing, progress } = useBroadcastSending();
  const [phoneNumbers, setPhoneNumbers] = useState<
    { id: string; label: string; isPrimary: boolean; wabaId: string | null }[]
  >([]);
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [loadingPhoneNumbers, setLoadingPhoneNumbers] = useState(true);
  const [demoMode, setDemoMode] = useState(false);
  const [demoResult, setDemoResult] = useState<string | null>(null);

  const [currentStep, setCurrentStep] = useState(0);
  const [template, setTemplate] = useState<MessageTemplate | null>(null);
  const [audience, setAudience] = useState<{
    type: 'all' | 'tags' | 'custom_field' | 'csv';
    tagIds?: string[];
    customField?: {
      fieldId: string;
      operator: 'is' | 'is_not' | 'contains';
      value: string;
    };
    csvContacts?: { phone: string; name?: string }[];
    excludeTagIds?: string[];
  }>({ type: 'all' });
  const [variables, setVariables] = useState<
    Record<string, { type: 'static' | 'field' | 'custom_field'; value: string }>
  >({});
  const [headerMediaUrl, setHeaderMediaUrl] = useState('');
  const [name, setName] = useState('');

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    void (async () => {
      const { data, error } = await createClient()
        .from('whatsapp_config')
        .select('phone_number_id, display_phone_number, is_primary, waba_id')
        .eq('account_id', accountId)
        .order('is_primary', { ascending: false });
      if (cancelled) return;
      if (error) {
        toast.error(`Failed to load WhatsApp numbers: ${error.message}`);
      } else {
        const rows = (data ?? []).map((row) => ({
          id: row.phone_number_id,
          label: row.display_phone_number || row.phone_number_id,
          isPrimary: row.is_primary,
          wabaId: row.waba_id,
        }));
        const usingDemoNumbers = rows.length === 0;
        setDemoMode(usingDemoNumbers);
        setPhoneNumbers(
          usingDemoNumbers
            ? DEMO_WHATSAPP_NUMBERS.map((number) => ({ ...number }))
            : rows,
        );
        setPhoneNumberId(
          (rows.find((row) => row.isPrimary) ??
            (usingDemoNumbers ? DEMO_WHATSAPP_NUMBERS[0] : rows[0]))?.id ?? '',
        );
      }
      setLoadingPhoneNumbers(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  async function handleSend() {
    if (!template) return;
    if (!phoneNumberId) {
      toast.error('Connect a WhatsApp number before sending a broadcast.');
      return;
    }
    if (demoMode && isDemoWhatsAppNumber(phoneNumberId)) {
      const recipientCount =
        audience.type === 'csv'
          ? (audience.csvContacts?.length ?? 0)
          : audience.type === 'tags'
            ? Math.min(3, (audience.tagIds?.length ?? 0) * 2)
            : audience.type === 'custom_field'
              ? 2
              : 3;
      setDemoResult(
        `Demo complete: simulated ${recipientCount} message${recipientCount === 1 ? '' : 's'} from ${phoneNumbers.find((number) => number.id === phoneNumberId)?.label}. No WhatsApp messages were sent.`,
      );
      toast.success('Demo broadcast completed. No messages were sent.');
      return;
    }

    try {
      setDemoResult(null);
      const broadcastId = await createAndSendBroadcast({
        name,
        phoneNumberId,
        template,
        audience: {
          type: audience.type,
          tagIds: audience.tagIds,
          customField: audience.customField,
          csvContacts: audience.csvContacts,
          excludeTagIds: audience.excludeTagIds,
        },
        variables,
        headerMediaUrl,
      });
      router.push(`/broadcasts/${broadcastId}`);
    } catch (err) {
      // Previously swallowed with console.error — the wizard would
      // just no-op, leaving the user confused. Surface the reason.
      const message = err instanceof Error ? err.message : 'Broadcast failed';
      console.error('Broadcast failed:', err);
      toast.error(message);
    }
  }

  /**
   * Writes a draft broadcast row — no recipients, no sending. The user
   * can revisit it via the list page to finish the flow later. We
   * don't persist the in-progress audience/variable config here
   * because the current schema doesn't carry it past `audience_filter`
   * and `template_variables`; those are enough for the user to
   * recognize the draft but not to exactly round-trip into the wizard.
   * A full resume-draft UX is a future polish.
   */
  async function handleSaveDraft() {
    if (!template || !name.trim()) {
      toast.error(t('toastGiveName'));
      return;
    }
    if (!phoneNumberId) {
      toast.error('Connect a WhatsApp number before saving a broadcast.');
      return;
    }
    if (demoMode && isDemoWhatsAppNumber(phoneNumberId)) {
      setDemoResult(
        `Demo draft saved locally for ${phoneNumbers.find((number) => number.id === phoneNumberId)?.label}. Nothing was written to your account.`,
      );
      toast.success('Demo draft saved locally.');
      return;
    }
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      toast.error(t('toastNotSignedIn'));
      return;
    }
    if (!accountId) {
      toast.error(t('toastNotLinked'));
      return;
    }

    const { error } = await supabase.from('broadcasts').insert({
      user_id: user.id,
      account_id: accountId,
      name: name.trim(),
      template_name: template.name,
      template_language: template.language ?? 'en_US',
      phone_number_id: phoneNumberId || null,
      template_variables: variables,
      audience_filter: {
        type: audience.type,
        tagIds: audience.tagIds,
      },
      status: 'draft',
      total_recipients: 0,
      sent_count: 0,
      delivered_count: 0,
      read_count: 0,
      replied_count: 0,
      failed_count: 0,
    });

    if (error) {
      toast.error(t('toastFailedDraft', { error: error.message }));
      return;
    }
    toast.success(t('toastDraftSaved'));
    router.push('/broadcasts');
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('subtitle')}
        </p>
        <div className="mt-4 max-w-sm space-y-2">
          <label
            htmlFor="broadcast-sender"
            className="text-sm font-medium text-foreground"
          >
            Sending WhatsApp number
          </label>
          <select
            id="broadcast-sender"
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            value={phoneNumberId}
            onChange={(event) => {
              setPhoneNumberId(event.target.value);
              setTemplate(null);
            }}
            disabled={loadingPhoneNumbers || phoneNumbers.length === 0}
          >
            {phoneNumbers.length === 0 ? (
              <option value="">
                {loadingPhoneNumbers
                  ? 'Loading WhatsApp numbers…'
                  : 'No WhatsApp number connected'}
              </option>
            ) : (
              phoneNumbers.map((number) => (
                <option key={number.id} value={number.id}>
                  {number.label}
                  {number.isPrimary ? ' (primary)' : ''}
                  {demoMode ? ' (demo)' : ''}
                </option>
              ))
            )}
          </select>
        </div>
        {demoMode && (
          <p className="mt-3 max-w-xl rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
            Demo mode: sample senders, template, and audience are shown so you can try the broadcast flow. Sending and drafts are simulated locally; no Meta or database writes are made.
          </p>
        )}
        {demoResult && (
          <p
            role="status"
            className="mt-3 max-w-xl rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200"
          >
            {demoResult}
          </p>
        )}
      </div>

      {/* Step Indicator */}
      <div className="flex items-center justify-between">
        {steps.map((step, index) => {
          const isActive = index === currentStep;
          const isCompleted = index < currentStep;

          return (
            <div key={step.key} className="flex flex-1 items-center">
              <div className="flex items-center gap-2">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-all ${
                    isCompleted
                      ? 'bg-primary text-primary-foreground'
                      : isActive
                        ? 'border-2 border-primary bg-primary/10 text-primary'
                        : 'border border-border bg-muted text-muted-foreground'
                  }`}
                >
                  {isCompleted ? <Check className="h-4 w-4" /> : index + 1}
                </div>
                <span
                  className={`hidden text-sm font-medium sm:block ${
                    isActive ? 'text-foreground' : isCompleted ? 'text-primary' : 'text-muted-foreground'
                  }`}
                >
                  {t(`steps.${step.label}`)}
                </span>
              </div>
              {index < steps.length - 1 && (
                <div
                  className={`mx-3 h-px flex-1 ${
                    index < currentStep ? 'bg-primary' : 'bg-muted'
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Step Content */}
      <div className="relative min-h-[400px]">
        <div
          className="transition-all duration-300 ease-in-out"
          style={{
            opacity: isProcessing ? 0.6 : 1,
            pointerEvents: isProcessing ? 'none' : 'auto',
          }}
        >
          {currentStep === 0 && (
            <Step1ChooseTemplate
              selectedTemplate={template}
              wabaId={
                phoneNumbers.find((number) => number.id === phoneNumberId)
                  ?.wabaId ?? null
              }
              onSelect={setTemplate}
              onNext={() => setCurrentStep(1)}
              onBack={() => router.push('/broadcasts')}
              demoMode={demoMode}
            />
          )}
          {currentStep === 1 && (
            <Step2SelectAudience
              audience={audience}
              onUpdate={setAudience}
              onNext={() => setCurrentStep(2)}
              onBack={() => setCurrentStep(0)}
              demoMode={demoMode}
            />
          )}
          {currentStep === 2 && template && (
            <Step3Personalize
              template={template}
              variables={variables}
              onUpdate={setVariables}
              headerMediaUrl={headerMediaUrl}
              onHeaderMediaUrlChange={setHeaderMediaUrl}
              onNext={() => setCurrentStep(3)}
              onBack={() => setCurrentStep(1)}
              demoMode={demoMode}
            />
          )}
          {currentStep === 3 && template && (
            <Step4ScheduleSend
              name={name}
              onNameChange={setName}
              template={template}
              audience={audience}
              onSend={handleSend}
              onSaveDraft={handleSaveDraft}
              onBack={() => setCurrentStep(2)}
              isProcessing={isProcessing}
              progress={progress}
              demoMode={demoMode}
            />
          )}
        </div>
      </div>
    </div>
  );
}
