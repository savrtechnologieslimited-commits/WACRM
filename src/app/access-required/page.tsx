import { useTranslations } from 'next-intl';

export default function AccessRequiredPage() {
  const t = useTranslations('AccessRequired');

  return (
    <main className="bg-background flex min-h-screen items-center justify-center px-6 py-12">
      <section className="border-border bg-card w-full max-w-lg rounded-xl border p-8 text-center shadow-sm">
        <h1 className="text-foreground text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground mt-3 text-sm leading-6">
          {t('description')}
        </p>
      </section>
    </main>
  );
}
