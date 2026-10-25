import type { MetadataRoute } from 'next';

/** Web app manifest: lets phones install KICKSCOUT with its icon; the service worker only handles push alerts. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'KICKSCOUT',
    short_name: 'KICKSCOUT',
    description: 'Football scores, match alerts and the next generation of football talent.',
    start_url: '/scores',
    scope: '/',
    display: 'standalone',
    background_color: '#07090C',
    theme_color: '#07090C',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
