'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { MessageSquare, CheckCircle, ArrowLeft } from 'lucide-react';

export default function ForgotPasswordPage() {
  const t = useTranslations('ForgotPasswordPage');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const supabase = createClient();

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    // The emailed link returns to /auth/callback, which exchanges it
    // for a recovery session and forwards to /reset-password (issue
    // #592). Supabase must allow this origin under Authentication →
    // URL Configuration → Redirect URLs, or it silently falls back to
    // its Site URL; see docs/auth-emails.md.
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent('/reset-password')}`,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
  };

  if (success) {
    return (
      <div className="relative isolate flex min-h-screen items-center justify-center overflow-hidden bg-[#0b141a] px-4 py-10">
        <div className="pointer-events-none absolute -top-40 left-1/2 -z-10 h-96 w-96 -translate-x-1/2 rounded-full bg-[#25d366]/10 blur-3xl" />
        <Card className="relative w-full max-w-md overflow-hidden rounded-2xl border-[#26343b] bg-[#111b21] text-[#e9edef] shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
          <div className="absolute inset-x-0 top-0 h-1 bg-[#25d366]" />
          <CardHeader className="items-center text-center">
            <div className="bg-primary/10 mb-2 flex h-12 w-12 items-center justify-center rounded-xl">
              <CheckCircle className="h-6 w-6 text-[#25d366]" />
            </div>
            <CardTitle className="text-foreground text-xl">
              {t('checkEmailTitle')}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t.rich('checkEmailDesc', {
                email,
                strong: (chunks) => (
                  <span className="text-foreground">{chunks}</span>
                ),
              })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/login">
              <Button
                variant="outline"
                className="w-full border-[#2a3942] text-[#cbd5d9] hover:bg-[#202c33] hover:text-[#e9edef]"
              >
                {t('backToSignIn')}
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="relative isolate flex min-h-screen items-center justify-center overflow-hidden bg-[#0b141a] px-4 py-10">
      <div className="pointer-events-none absolute -top-40 left-1/2 -z-10 h-96 w-96 -translate-x-1/2 rounded-full bg-[#25d366]/10 blur-3xl" />
      <Card className="relative w-full max-w-md overflow-hidden rounded-2xl border-[#26343b] bg-[#111b21] text-[#e9edef] shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
        <div className="absolute inset-x-0 top-0 h-1 bg-[#25d366]" />
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#25d366]/10">
            <MessageSquare className="h-6 w-6 text-[#25d366]" />
          </div>
          <CardTitle className="text-xl text-[#e9edef]">{t('title')}</CardTitle>
          <CardDescription className="text-[#8696a0]">
            {t('desc')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleReset} className="flex flex-col gap-4">
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="email" className="text-[#cbd5d9]">
                {t('emailLabel')}
              </Label>
              <Input
                id="email"
                type="email"
                placeholder={t('emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="border-[#2a3942] bg-[#202c33] text-[#e9edef] placeholder:text-[#8696a0] focus-visible:border-[#25d366] focus-visible:ring-[#25d366]/25"
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="mt-2 h-12 w-full bg-[#25d366] font-semibold text-[#08210f] hover:bg-[#55e889] disabled:opacity-50"
            >
              {loading ? t('sending') : t('sendLink')}
            </Button>
          </form>

          <Link
            href="/login"
            className="mt-6 flex items-center justify-center gap-2 text-sm text-[#8696a0] hover:text-[#e9edef]"
          >
            <ArrowLeft className="h-4 w-4" />
            {t('backToSignIn')}
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
