import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FlagsContext, KNOWN_FLAGS, useFlag } from '@/lib/flags';

function Probe({ k }: { k: string }) {
  return <span>{useFlag(k) ? 'on' : 'off'}</span>;
}

describe('useFlag', () => {
  it('is off unless the server evaluated the flag as on', () => {
    expect(renderToStaticMarkup(<Probe k="nl_scout_search" />)).toBe('<span>off</span>');
    const flags = { nl_scout_search: true, hls_streaming: false };
    const html = renderToStaticMarkup(
      <FlagsContext.Provider value={flags}><Probe k="nl_scout_search" /><Probe k="hls_streaming" /><Probe k="unknown" /></FlagsContext.Provider>,
    );
    expect(html).toBe('<span>on</span><span>off</span><span>off</span>');
    expect(KNOWN_FLAGS).toEqual(['nl_scout_search', 'for_you_personalization', 'hls_streaming']);
  });
});
