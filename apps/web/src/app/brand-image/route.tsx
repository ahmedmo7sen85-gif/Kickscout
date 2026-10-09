import { ImageResponse } from 'next/og';

/** The brand share card (1200×630) used as the default Open Graph and Twitter image. Built once at build time. */
export const dynamic = 'force-static';

export function GET() {
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', background: '#07090c', color: '#ffffff', padding: '72px 80px', fontFamily: 'sans-serif' }}>
        <div style={{ display: 'flex', fontSize: 64, fontWeight: 900, letterSpacing: -1 }}>
          <span>KICK</span><span style={{ color: '#b7ff00' }}>SCOUT</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', fontSize: 92, fontWeight: 900, lineHeight: 1.02 }}>
          <span>YOUR SKILL.</span>
          <span>YOUR MOMENT.</span>
          <span style={{ color: '#b7ff00' }}>GET DISCOVERED.</span>
        </div>
      </div>
    ),
    { width: 1200, height: 630 },
  );
}
