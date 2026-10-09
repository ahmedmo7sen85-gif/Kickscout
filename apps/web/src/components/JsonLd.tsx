import { serializeJsonLd } from '@/lib/seo';

/** Structured data for search engines. The JSON is escaped so user text cannot close the script tag. */
export function JsonLd({ data }: { data: unknown }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} />;
}
