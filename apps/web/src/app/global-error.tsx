'use client';

/** Last-resort boundary when the root layout itself fails; it cannot use providers, so copy is bilingual inline. */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ background: '#07090C', color: '#FFFFFF', fontFamily: 'system-ui, sans-serif', display: 'grid', placeItems: 'center', minHeight: '100dvh', margin: 0, padding: 16 }}>
        <main style={{ textAlign: 'center', display: 'grid', gap: 12 }}>
          <h1 style={{ margin: 0 }}>KICK<span style={{ color: '#B7FF00' }}>SCOUT</span></h1>
          <p>Something went wrong. <span lang="ar" dir="rtl">حدث خطأ ما.</span></p>
          <button type="button" onClick={reset} style={{ background: '#B7FF00', color: '#07090C', border: 0, borderRadius: 999, padding: '10px 20px', fontWeight: 700, cursor: 'pointer' }}>
            Try again · حاول مرة أخرى
          </button>
        </main>
      </body>
    </html>
  );
}
