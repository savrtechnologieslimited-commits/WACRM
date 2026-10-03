'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
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
import { MessageSquare, CheckCircle, UsersRound } from 'lucide-react';

// `useSearchParams` opts the component out of static prerendering
// unless wrapped in Suspense — same pattern as /login.
export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupPageInner />
    </Suspense>
  );
}

function SignupPageInner() {
  const searchParams = useSearchParams();
  // When the user lands here from `/join/<token>` we carry the
  // invite token in the query so it survives the signup → email
  // verification → redirect round-trip. `emailRedirectTo` below
  // sends the verified user to /join/<token> so they land on the
  // redeem step instead of being dropped on /dashboard.
  const inviteToken = searchParams.get('invite');
  const t = useTranslations('SignupPage');

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const supabase = createClient();

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError(t('passwordsMismatch'));
      return;
    }

    if (password.length < 6) {
      setError(t('passwordTooShort'));
      return;
    }

    setLoading(true);

    // Always name our own origin as the place the confirmation link
    // returns to. Previously this was left unset unless an invite was
    // involved, so Supabase fell back to its Site URL — which on a
    // freshly-created or self-hosted project is `http://localhost:3000`
    // (issue #595) — and even when the Site URL was right the link
    // landed on `/` with an unexchanged `?code=`, so the user had to
    // sign in again after verifying. /auth/callback exchanges the link
    // for a session and forwards to `next` (issue #592). Supabase still
    // has to allow this origin under Authentication → URL Configuration
    // → Redirect URLs; see docs/auth-emails.md.
    const next = inviteToken
      ? `/join/${encodeURIComponent(inviteToken)}`
      : '/dashboard';
    const emailRedirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
        },
        emailRedirectTo,
      },
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
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#25d366]/10">
              <CheckCircle className="h-6 w-6 text-[#25d366]" />
            </div>
            <CardTitle className="text-xl text-[#e9edef]">
              {t('checkEmailTitle')}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t.rich('checkEmailDesc', {
                email,
                strong: (chunks) => (
                  <span className="text-[#e9edef]">{chunks}</span>
                ),
              })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href={
                inviteToken
                  ? `/login?invite=${encodeURIComponent(inviteToken)}`
                  : '/login'
              }
            >
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
            {inviteToken ? (
              <UsersRound className="h-6 w-6 text-[#25d366]" />
            ) : (
              <MessageSquare className="h-6 w-6 text-[#25d366]" />
            )}
          </div>
          <CardTitle className="text-xl text-[#e9edef]">
            {inviteToken ? t('titleJoin') : t('title')}
          </CardTitle>
          <CardDescription className="text-[#8696a0]">
            {inviteToken ? t('descJoin') : t('desc')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSignup} className="flex flex-col gap-4">
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="fullName" className="text-[#cbd5d9]">
                {t('fullNameLabel')}
              </Label>
              <Input
                id="fullName"
                type="text"
                placeholder={t('fullNamePlaceholder')}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
                className="border-[#2a3942] bg-[#202c33] text-[#e9edef] placeholder:text-[#8696a0] focus-visible:border-[#25d366] focus-visible:ring-[#25d366]/25"
              />
            </div>

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

            <div className="flex flex-col gap-2">
              <Label htmlFor="password" className="text-[#cbd5d9]">
                {t('passwordLabel')}
              </Label>
              <Input
                id="password"
                type="password"
                placeholder={t('passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="border-[#2a3942] bg-[#202c33] text-[#e9edef] placeholder:text-[#8696a0] focus-visible:border-[#25d366] focus-visible:ring-[#25d366]/25"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="confirmPassword" className="text-[#cbd5d9]">
                {t('confirmPasswordLabel')}
              </Label>
              <Input
                id="confirmPassword"
                type="password"
                placeholder={t('confirmPasswordPlaceholder')}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                className="border-[#2a3942] bg-[#202c33] text-[#e9edef] placeholder:text-[#8696a0] focus-visible:border-[#25d366] focus-visible:ring-[#25d366]/25"
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="mt-2 h-12 w-full bg-[#25d366] font-semibold text-[#08210f] hover:bg-[#55e889] disabled:opacity-50"
            >
              {loading ? t('creating') : t('submit')}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-[#8696a0]">
            {t('haveAccount')}{' '}
            <Link
              href={
                inviteToken
                  ? `/login?invite=${encodeURIComponent(inviteToken)}`
                  : '/login'
              }
              className="text-[#25d366] hover:text-[#55e889]"
            >
              {t('signIn')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
