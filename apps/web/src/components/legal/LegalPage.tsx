import Link from 'next/link';
import type { LegalDoc } from '@/lib/legal';
import { LEGAL_UPDATED } from '@/lib/legal';
import { fmt } from '@/lib/i18n';
import type { Dict } from '@/lib/i18n';
import type { Locale } from '@/lib/types';

/** Renders a legal document with the draft banner. Body text is English only for now. */
export function LegalPage({ doc, t, locale }: { doc: LegalDoc; t: Dict; locale: Locale }) {
  const sections = doc.sections.filter((s) => s.id !== 'draft');
  const draft = doc.sections.find((s) => s.id === 'draft');
  return (
    <div className="wrap wrap--mid page">
      <header className="page-head">
        <p className="kicker"><Link href="/legal">{t.legal.hubTitle}</Link></p>
        <h1 className="page-title">{t.legal[doc.titleKey]}</h1>
        <p className="page-intro" lang="en" dir="ltr">{doc.summary}</p>
      </header>
      <div className="notice notice--warn" role="note" data-testid="legal-draft">
        <strong>{t.legal.draftBanner}</strong>
        {draft?.body.map((p) => <p key={p} lang="en" dir="ltr">{p}</p>)}
        {locale !== 'en' ? <p>{t.legal.englishOnly}</p> : null}
        <p className="small muted">{fmt(t.legal.lastUpdated, { date: LEGAL_UPDATED })}</p>
      </div>
      <nav className="legal-toc" aria-label={t.legal.contents}>
        <ol>{sections.map((s) => <li key={s.id}><a className="link" href={`#${s.id}`} lang="en">{s.heading}</a></li>)}</ol>
      </nav>
      <article className="legal-doc" lang="en" dir="ltr">
        {sections.map((s) => (
          <section key={s.id} id={s.id} aria-labelledby={`${s.id}-h`}>
            <h2 id={`${s.id}-h`}>{s.heading}</h2>
            {s.body.map((p) => <p key={p}>{p}</p>)}
          </section>
        ))}
      </article>
    </div>
  );
}
