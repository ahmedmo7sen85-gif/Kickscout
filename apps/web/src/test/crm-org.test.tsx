import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PipelineBoard } from '@/components/crm/PipelineBoard';
import { SavedSearchList } from '@/components/crm/SavedSearchList';
import { OrgHeader } from '@/components/org/OrgHeader';
import { OrgMembers } from '@/components/org/OrgMembers';
import { ToastProvider } from '@/components/ui/Toast';
import { createI18nValue, I18nContext } from '@/lib/i18n/provider';
import type { CrmEntryView, Locale, OrganizationMemberView, OrgRole, SavedSearchView } from '@/lib/types';

const render = (node: ReactNode, locale: Locale = 'en') => renderToStaticMarkup(
  <I18nContext.Provider value={createI18nValue(locale)}><ToastProvider>{node}</ToastProvider></I18nContext.Provider>,
);

const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const card = (n: number, name: string) => ({
  userId: id(100 + n), handle: `player${n}`, displayName: name, avatarUrl: null, verified: false, isDemo: false, country: 'EG',
  position: 'LW' as const, foot: 'left' as const, ageGroup: null, followers: 0, videos: 1, topSkills: [],
});
const entry = (n: number, name: string, stage: CrmEntryView['stage'], extra: Partial<CrmEntryView> = {}): CrmEntryView => ({
  id: id(n), player: card(n, name), stage, tags: [], contactRequest: null,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...extra,
});
const items = [
  entry(1, 'Omar', 'new'),
  entry(2, 'Youssef', 'watching', { tags: ['left-foot'] }),
  entry(3, 'Karim', 'contact_requested', { contactRequest: { id: id(50), status: 'pending', viaGuardian: true } }),
];

/** The markup of one kanban column. */
const column = (html: string, stage: string) => html.match(new RegExp(`<section[^>]*data-stage="${stage}"[^>]*>[\\s\\S]*?</section>`))?.[0] ?? '';

describe('PipelineBoard', () => {
  it('renders all eight stages in order, in English and Arabic', () => {
    for (const [locale, first, last] of [['en', 'New', 'Archived'], ['ar', 'جديد', 'مؤرشف']] as const) {
      const html = render(<PipelineBoard items={items} canWrite />, locale);
      const stages = [...html.matchAll(/data-stage="([a-z_]+)"/g)].map((m) => m[1]);
      expect(stages).toEqual(['new', 'watching', 'shortlisted', 'monitoring', 'contact_requested', 'contacted', 'evaluation', 'archived']);
      expect(column(html, 'new')).toContain(first);
      expect(column(html, 'archived')).toContain(last);
    }
  });

  it('puts each card in its stage column, with tags and the contact status', () => {
    const html = render(<PipelineBoard items={items} canWrite />);
    expect(column(html, 'new')).toContain('Omar');
    expect(column(html, 'watching')).toContain('Youssef');
    expect(column(html, 'watching')).toContain('left-foot');
    expect(column(html, 'contact_requested')).toContain('Karim');
    expect(column(html, 'contact_requested')).toContain('Contact request: Pending');
    expect(column(html, 'contact_requested')).toContain('Sent to guardian');
    expect(column(html, 'shortlisted')).not.toContain('kanban__card');
  });

  it('is keyboard operable: labelled move buttons and a labelled stage select on every card', () => {
    const html = render(<PipelineBoard items={items} canWrite />);
    expect(html).toContain('aria-label="Move Omar to Watching"');
    expect(html).not.toContain('aria-label="Move Omar to Archived"'); // only neighbours get buttons
    expect(html).toContain('aria-label="Move Youssef to New"');
    expect(html).toMatch(/<label class="sr-only" for="move-[^"]+">Move Omar to<\/label>/);
    expect(html.match(/<select/g)).toHaveLength(3);
  });

  it('shows no move controls to read-only roles', () => {
    const html = render(<PipelineBoard items={items} canWrite={false} />);
    expect(html).toContain('Omar');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('<button');
  });
});

describe('SavedSearchList', () => {
  const searches: SavedSearchView[] = [
    { id: id(60), name: 'Left wingers', filters: { position: 'LW', country: 'EG' }, alerts: true, matches: 3, createdBy: { userId: id(1), handle: 'scout1' }, createdAt: '2026-10-01T00:00:00.000Z' },
    { id: id(61), name: 'Everyone', filters: {}, alerts: false, matches: 0, createdBy: { userId: id(1), handle: 'scout1' }, createdAt: '2026-10-01T00:00:00.000Z' },
  ];
  it('gives each search an accessible alert switch reflecting its state', () => {
    const html = render(<SavedSearchList items={searches} canWrite />);
    expect(html).toMatch(/role="switch" aria-checked="true"[^>]*aria-label="Alerts for Left wingers"/);
    expect(html).toMatch(/role="switch" aria-checked="false"[^>]*aria-label="Alerts for Everyone"/);
    expect(html).toContain('All players');
    expect(html).toContain('EG');
  });
  it('shows the state without controls to read-only roles, and translates', () => {
    const html = render(<SavedSearchList items={searches} canWrite={false} />, 'ar');
    expect(html).not.toContain('role="switch"');
    expect(html).toContain('التنبيهات مفعّلة');
  });
});

describe('OrgHeader', () => {
  it('shows the verified badge and never lists members', () => {
    const html = render(<OrgHeader org={{ id: id(70), name: 'Nile Academy', type: 'academy', country: 'EG', verified: true, logoKey: null, logoUrl: null, myRole: null }} />);
    expect(html).toContain('Nile Academy');
    expect(html).toContain('Academy · EG');
    expect(html).toContain('Members are never listed publicly.');
    expect(html).not.toContain('org-members');
    expect(html).toContain('badge--verified');
    expect(render(<OrgHeader org={{ id: id(70), name: 'X', type: 'club', country: null, verified: false, logoKey: null, logoUrl: null, myRole: null }} />))
      .not.toContain('badge--verified');
  });
});

describe('OrgMembers', () => {
  const members: OrganizationMemberView[] = (['owner', 'admin', 'scout', 'viewer'] as OrgRole[]).map((role, i) => ({
    userId: id(200 + i), handle: `m${i}`, displayName: `Member ${role}`, role, since: '2026-09-01T00:00:00.000Z',
  }));
  const controls = (myRole: OrgRole, me: number) => {
    const html = render(<OrgMembers members={members} myRole={myRole} myUserId={id(200 + me)} />);
    return {
      remove: [...html.matchAll(/aria-label="Remove Member (\w+)"/g)].map((m) => m[1]),
      change: [...html.matchAll(/for="role-[^"]+">Change role for Member (\w+)/g)].map((m) => m[1]),
    };
  };
  it('the owner manages everyone but themselves', () => {
    expect(controls('owner', 0)).toEqual({ remove: ['admin', 'scout', 'viewer'], change: ['admin', 'scout', 'viewer'] });
  });
  it('an admin manages scouts and viewers, not the owner, other admins or themselves', () => {
    expect(controls('admin', 1)).toEqual({ remove: ['scout', 'viewer'], change: ['scout', 'viewer'] });
  });
  it('scouts and viewers get no controls', () => {
    expect(controls('scout', 2)).toEqual({ remove: [], change: [] });
    expect(controls('viewer', 3)).toEqual({ remove: [], change: [] });
  });
});
