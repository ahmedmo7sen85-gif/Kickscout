import { ButtonLink } from '@/components/ui/Button';
import { getServerDict } from '@/lib/i18n/server';

export default async function NotFound() {
  const { t } = await getServerDict();
  return (
    <div className="wrap page notfound">
      <div className="stack" style={{ justifyItems: 'center' }}>
        <p className="kicker">404</p>
        <h1 className="display">{t.pages.notFoundTitle}</h1>
        <p className="lede">{t.pages.notFoundText}</p>
        <div className="cta-row"><ButtonLink href="/" variant="primary">{t.pages.goHome}</ButtonLink><ButtonLink href="/discover">{t.nav.discover}</ButtonLink></div>
      </div>
    </div>
  );
}
