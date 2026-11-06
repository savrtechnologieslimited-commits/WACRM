'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  MessageCircle,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type EmbeddedSignupSdk = {
  init: (options: {
    appId: string;
    cookie: boolean;
    xfbml: boolean;
    version: string;
  }) => void;
  login: (
    callback: (response: {
      authResponse?: { code?: string };
      status?: string;
    }) => void,
    options: {
      config_id: string;
      response_type: 'code';
      override_default_response_type: boolean;
      extras: {
        setup: Record<string, never>;
        version: 'v5';
      };
    }
  ) => void;
};

declare global {
  interface Window {
    FB?: EmbeddedSignupSdk;
    __wacrmFacebookAppId?: string;
  }
}

type Props = {
  hasExistingConnection: boolean;
  canEditSettings: boolean;
  onConnected: () => Promise<void>;
};

let sdkPromise: Promise<EmbeddedSignupSdk> | null = null;
const META_GRAPH_API_VERSION = 'v27.0';

function loadFacebookSdk(appId: string): Promise<EmbeddedSignupSdk> {
  if (typeof window.FB !== 'undefined') {
    if (window.__wacrmFacebookAppId && window.__wacrmFacebookAppId !== appId) {
      return Promise.reject(
        new Error(
          'The Meta SDK is already initialized for another app. Reload this page and try again.'
        )
      );
    }
    if (!window.__wacrmFacebookAppId) {
      window.FB.init({
        appId,
        cookie: true,
        xfbml: false,
        version: META_GRAPH_API_VERSION,
      });
      window.__wacrmFacebookAppId = appId;
    }
    return Promise.resolve(window.FB);
  }
  if (sdkPromise) return sdkPromise;

  const pendingSdkPromise = new Promise<EmbeddedSignupSdk>(
    (resolve, reject) => {
      const scriptId = 'wacrm-facebook-sdk';
      const script =
        (document.getElementById(scriptId) as HTMLScriptElement | null) ??
        document.createElement('script');
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            'Meta’s login SDK did not load. Check browser network and privacy settings.'
          )
        );
      }, 15000);

      const finish = () => {
        if (settled) return;
        if (!window.FB) {
          settled = true;
          window.clearTimeout(timeout);
          reject(new Error('Meta’s login SDK loaded without its API.'));
          return;
        }
        settled = true;
        window.clearTimeout(timeout);
        window.FB.init({
          appId,
          cookie: true,
          xfbml: false,
          version: META_GRAPH_API_VERSION,
        });
        window.__wacrmFacebookAppId = appId;
        resolve(window.FB);
      };

      script.addEventListener('load', finish, { once: true });
      script.addEventListener(
        'error',
        () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          reject(new Error('Meta’s login SDK could not be loaded.'));
        },
        { once: true }
      );

      if (!script.isConnected) {
        script.id = scriptId;
        script.src = 'https://connect.facebook.net/en_US/sdk.js';
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
    }
  );
  const initializedSdkPromise = pendingSdkPromise.catch((error: unknown) => {
    sdkPromise = null;
    throw error;
  });
  sdkPromise = initializedSdkPromise;
  return initializedSdkPromise;
}

function waitForSignupMessage(): {
  promise: Promise<unknown | null>;
  cancel: () => void;
} {
  let resolveMessage: (value: unknown | null) => void = () => {};
  let settled = false;
  const finish = (value: unknown | null) => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timeout);
    window.removeEventListener('message', onMessage);
    resolveMessage(value);
  };
  const onMessage = (event: MessageEvent) => {
    let origin: URL;
    try {
      origin = new URL(event.origin);
    } catch {
      return;
    }
    if (
      origin.protocol !== 'https:' ||
      (origin.hostname !== 'facebook.com' &&
        !origin.hostname.endsWith('.facebook.com'))
    ) {
      return;
    }

    let data: unknown = event.data;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        return;
      }
    }
    if (
      data &&
      typeof data === 'object' &&
      'type' in data &&
      data.type === 'WA_EMBEDDED_SIGNUP'
    ) {
      finish(data);
    }
  };
  const promise = new Promise<unknown | null>((resolve) => {
    resolveMessage = resolve;
  });
  const timeout = window.setTimeout(() => finish(null), 120000);
  window.addEventListener('message', onMessage);

  return { promise, cancel: () => finish(null) };
}

async function runEmbeddedSignup(
  sdk: EmbeddedSignupSdk,
  configurationId: string
): Promise<{ code: string; sessionInfo: unknown }> {
  const messageWaiter = waitForSignupMessage();
  try {
    const code = await new Promise<string>((resolve, reject) => {
      sdk.login(
        (response) => {
          const value = response.authResponse?.code;
          if (typeof value === 'string' && value.length > 0) {
            resolve(value);
          } else {
            reject(
              new Error(
                'Meta signup was cancelled or did not return an authorization code.'
              )
            );
          }
        },
        {
          config_id: configurationId,
          response_type: 'code',
          override_default_response_type: true,
          extras: {
            setup: {},
            version: 'v5',
          },
        }
      );
    });
    const sessionInfo = await messageWaiter.promise;
    if (!sessionInfo) {
      throw new Error(
        'Meta did not send the signup completion event. Complete the business onboarding dialog and try again.'
      );
    }
    return { code, sessionInfo };
  } finally {
    messageWaiter.cancel();
  }
}

export function WhatsAppCoexistenceSignup({
  hasExistingConnection,
  canEditSettings,
  onConnected,
}: Props) {
  const t = useTranslations('Settings.whatsapp');
  const [appId, setAppId] = useState('');
  const [configurationId, setConfigurationId] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [starting, setStarting] = useState(false);
  const [signupState, setSignupState] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncWarning, setSyncWarning] = useState<string | null>(null);
  const [connectedPhone, setConnectedPhone] = useState<string | null>(null);
  const [coexistenceStatus, setCoexistenceStatus] = useState<string | null>(
    null
  );
  const mustUseSeparateWorkspace = hasExistingConnection && !connectedPhone;

  async function handlePrepareSignup() {
    setError(null);
    setSyncWarning(null);
    setConnectedPhone(null);
    setCoexistenceStatus(null);
    setStarting(true);

    try {
      const startResponse = await fetch('/api/whatsapp/embedded-signup/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id: appId.trim(),
          configuration_id: configurationId.trim(),
          verify_token: verifyToken.trim(),
        }),
      });
      const startPayload = await startResponse.json();
      if (!startResponse.ok) {
        throw new Error(startPayload.error || t('embeddedSignupFailed'));
      }

      await loadFacebookSdk(appId.trim());
      setSignupState(startPayload.state);
    } catch (signupError) {
      setSignupState(null);
      setError(
        signupError instanceof Error
          ? signupError.message
          : t('embeddedSignupFailed')
      );
    } finally {
      setStarting(false);
    }
  }

  async function handleContinueSignup() {
    if (!signupState || !window.FB) {
      setSignupState(null);
      setError(t('embeddedSignupFailed'));
      return;
    }

    setError(null);
    setStarting(true);
    try {
      // Launch FB.login directly from this click before any asynchronous work,
      // so browsers allow Meta to open its authorization popup.
      const signupPromise = runEmbeddedSignup(
        window.FB,
        configurationId.trim()
      );
      const { code, sessionInfo } = await signupPromise;
      const completeResponse = await fetch(
        '/api/whatsapp/embedded-signup/complete',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            state: signupState,
            code,
            session_info: sessionInfo,
          }),
        }
      );
      const completePayload = await completeResponse.json();
      if (!completeResponse.ok) {
        throw new Error(completePayload.error || t('embeddedSignupFailed'));
      }

      setConnectedPhone(completePayload.phone_number ?? null);
      setCoexistenceStatus(completePayload.coexistence_status);
      setSyncWarning(completePayload.sync_warning ?? null);
      setVerifyToken('');
      setSignupState(null);
      await onConnected();
    } catch (signupError) {
      setError(
        signupError instanceof Error
          ? signupError.message
          : t('embeddedSignupFailed')
      );
    } finally {
      setStarting(false);
    }
  }

  const canStart =
    canEditSettings &&
    !mustUseSeparateWorkspace &&
    !starting &&
    (signupState !== null ||
      (/^\d+$/.test(appId.trim()) &&
        /^\d+$/.test(configurationId.trim()) &&
        verifyToken.trim().length >= 16));

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <MessageCircle className="text-primary mt-1 size-5 shrink-0" />
          <div>
            <CardTitle className="text-base">
              {t('embeddedSignupTitle')}
            </CardTitle>
            <CardDescription className="mt-1">
              {t('embeddedSignupDesc')}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {mustUseSeparateWorkspace ? (
          <Alert className="border-amber-700/50 bg-amber-950/30">
            <AlertTriangle className="size-4 text-amber-400" />
            <AlertTitle>{t('embeddedExistingConnection')}</AlertTitle>
            <AlertDescription>
              {t('embeddedExistingConnectionDesc')}
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <p className="text-muted-foreground text-sm">
              {t('embeddedClientAuthHint')}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="embedded-meta-app-id">
                  {t('embeddedAppId')}
                </Label>
                <Input
                  id="embedded-meta-app-id"
                  inputMode="numeric"
                  value={appId}
                  onChange={(event) => {
                    setAppId(event.target.value);
                    setSignupState(null);
                  }}
                  placeholder={t('embeddedAppIdPlaceholder')}
                  disabled={starting || !canEditSettings}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="embedded-meta-config-id">
                  {t('embeddedConfigId')}
                </Label>
                <Input
                  id="embedded-meta-config-id"
                  inputMode="numeric"
                  value={configurationId}
                  onChange={(event) => {
                    setConfigurationId(event.target.value);
                    setSignupState(null);
                  }}
                  placeholder={t('embeddedConfigIdPlaceholder')}
                  disabled={starting || !canEditSettings}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="embedded-webhook-verify-token">
                {t('embeddedWebhookVerifyToken')}
              </Label>
              <Input
                id="embedded-webhook-verify-token"
                type="password"
                autoComplete="new-password"
                value={verifyToken}
                onChange={(event) => {
                  setVerifyToken(event.target.value);
                  setSignupState(null);
                }}
                placeholder={t('embeddedWebhookVerifyTokenPlaceholder')}
                disabled={starting || !canEditSettings}
              />
              <p className="text-muted-foreground text-xs">
                {t('embeddedWebhookVerifyTokenHint')}
              </p>
            </div>
            {!canEditSettings && (
              <p className="text-muted-foreground text-sm">
                {t('embeddedAdminOnly')}
              </p>
            )}
            <Button
              onClick={signupState ? handleContinueSignup : handlePrepareSignup}
              disabled={!canStart}
            >
              {starting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('embeddedStarting')}
                </>
              ) : (
                t(signupState ? 'embeddedContinue' : 'embeddedStart')
              )}
            </Button>
          </>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" />
            <AlertTitle>{t('embeddedSignupFailed')}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {connectedPhone && (
          <Alert className="border-emerald-700/50 bg-emerald-950/30">
            <CheckCircle2 className="size-4 text-emerald-400" />
            <AlertTitle>{t('embeddedSignupComplete')}</AlertTitle>
            <AlertDescription>
              {t('embeddedSignupConnected', {
                phone: connectedPhone,
                status:
                  coexistenceStatus === 'verified'
                    ? t('embeddedCoexistenceVerified')
                    : t('embeddedCoexistencePending'),
              })}
            </AlertDescription>
          </Alert>
        )}
        {syncWarning && (
          <Alert className="border-amber-700/50 bg-amber-950/30">
            <AlertTriangle className="size-4 text-amber-400" />
            <AlertTitle>{t('embeddedSyncNeedsAttention')}</AlertTitle>
            <AlertDescription>{syncWarning}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
