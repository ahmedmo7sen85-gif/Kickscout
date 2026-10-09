import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { BottomNav } from '@/components/nav/BottomNav';
import { SiteFooter } from '@/components/nav/SiteFooter';
import { TopNav } from '@/components/nav/TopNav';
import { Providers } from '@/components/Providers';
import { publicEnv } from '@/lib/env';
import { dirFor, getDict } from '@/lib/i18n';
import { getLocale } from '@/lib/i18n/server';
import { BRAND_IMAGE } from '@/lib/seo';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const t = getDict(await getLocale());
  return {
    metadataBase: new URL(publicEnv.siteUrl),
    title: { default: t.meta.title, template: '%s · KICKSCOUT' },
    description: t.meta.description,
    applicationName: 'KICKSCOUT',
    // No canonical here: each indexable page sets its own (see lib/seo.ts), so none inherits the home page's.
    openGraph: { type: 'website', siteName: 'KICKSCOUT', title: t.meta.title, description: t.meta.description, images: [{ ...BRAND_IMAGE, alt: t.meta.ogAlt }] },
    twitter: { card: 'summary_large_image', title: t.meta.title, description: t.meta.description, images: [BRAND_IMAGE.url] },
  };
}

export const viewport: Viewport = {
  themeColor: '#07090C',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const t = getDict(locale);
  return (
    <html lang={locale} dir={dirFor(locale)}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@700;800;900&family=Instrument+Sans:wght@400;500;600;700&family=Tajawal:wght@400;500;700;800&display=swap"
        />
      </head>
      <body>
        <Providers locale={locale}>
          <a href="#main" className="skip-link">{t.common.skipToContent}</a>
          <TopNav />
          <main id="main" tabIndex={-1}>{children}</main>
          <SiteFooter />
          <BottomNav />
        </Providers>
      </body>
    </html>
  );
}
