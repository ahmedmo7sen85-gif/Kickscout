/**
 * Legal documents. English only for now (the page says so in Arabic); titles live in the i18n
 * dictionaries. Every document is a draft pending legal review and opens by saying so.
 * Do not present anything here as final until counsel has signed it off.
 */
import type { Dict } from './i18n';

export const LEGAL_VERSION = '2026-10-draft';
export const LEGAL_UPDATED = '2026-10-08';

export interface LegalSection {
  id: string;
  heading: string;
  body: string[];
}

export interface LegalDoc {
  slug: string;
  titleKey: keyof Pick<Dict['legal'], 'terms' | 'privacy' | 'community' | 'copyright' | 'safety' | 'scouts' | 'subscriptions'>;
  summary: string;
  sections: LegalSection[];
}

export const DRAFT_NOTICE =
  'Draft pending legal review. This document has not yet been reviewed by a lawyer. It describes how KICKSCOUT works today and is published so you can read it, but it may change before it becomes final, and the final version will say so.';

const draft = (extra?: string): LegalSection => ({ id: 'draft', heading: 'Status of this document', body: extra ? [DRAFT_NOTICE, extra] : [DRAFT_NOTICE] });

const NO_GUARANTEE =
  'KICKSCOUT does not guarantee any contract, trial, employment, selection, sponsorship, transfer or professional success. Being seen, followed, shortlisted or contacted on KICKSCOUT is not an offer of anything, and nothing on the platform (including Talent Radar, skill tags or verification badges) is a rating of ability or potential.';

const DUE_DILIGENCE =
  'Scouts, clubs, academies, agents and other organisations remain fully responsible for their own due diligence: checking a player’s identity, age, eligibility, registration status and any consent required, and complying with the football regulations and laws that apply to them. KICKSCOUT verifies that a scout’s organisation exists and that the scout is linked to it; it does not vouch for any decision a scout or organisation makes.';

export const LEGAL_DOCS: readonly LegalDoc[] = [
  {
    slug: 'terms',
    titleKey: 'terms',
    summary: 'The agreement between you and KICKSCOUT when you use the platform.',
    sections: [
      draft('The legal entity that operates KICKSCOUT, its registered address and the governing law will be added here after legal review.'),
      {
        id: 'who', heading: 'Who can use KICKSCOUT', body: [
          'You must be at least 13 years old to create an account. If you are under 18, a parent or guardian must approve your account before it becomes active, and they manage your consents, your contact requests and the deletion of your account.',
          'You must give accurate information when you sign up, including your date of birth. We use it only to apply age protections; it is stored encrypted and never shown.',
          'Scout tools are only available after our team has verified your organisation. Moderator and admin roles are granted by KICKSCOUT staff and can never be chosen at sign-up.',
        ],
      },
      {
        id: 'content', heading: 'Your content stays yours', body: [
          'You keep ownership of the videos, text and other content you post. We do not claim ownership of anything you upload.',
          'To run the service you give KICKSCOUT a limited, non-exclusive, royalty-free licence to host, store, copy, transcode, trim, create thumbnails of, analyse (including with AI to suggest skill tags and screen for safety), display and distribute your content on KICKSCOUT, to the audience you choose in your privacy settings, and in KICKSCOUT’s own promotion of the platform only with your separate permission.',
          'This licence is only for operating, securing and improving the service. We do not sell your content, and we use your clips to improve our AI only if you (or your guardian) turn on the “Help improve AI” consent.',
          'The licence ends when you delete the content or your account, except for copies we must keep for a limited time in backups, to resolve a dispute or report, or because the law requires it.',
          'Other users get no right to download, re-upload or reuse your content outside KICKSCOUT.',
        ],
      },
      {
        id: 'rights', heading: 'What you confirm when you upload', body: [
          'Each time you upload, you confirm that you filmed the clip or own it, or have permission from whoever does, and that posting it follows the Community Guidelines. We record when you gave this confirmation.',
          'Uploading someone else’s footage without permission can lead to its removal under our Copyright Policy, and repeated upheld copyright claims can lead to your account being restricted or suspended.',
        ],
      },
      { id: 'no-guarantee', heading: 'No guarantee of opportunities', body: [NO_GUARANTEE, 'Any agreement you make with a scout, club, academy, agent or sponsor is between you (or your guardian) and them. KICKSCOUT is not a party to it, is not an agent or intermediary, and does not take a fee from it.'] },
      { id: 'scouts', heading: 'Scouts and organisations', body: [DUE_DILIGENCE, 'Scouts must also follow the Scout & Organization Terms.'] },
      {
        id: 'conduct', heading: 'How you must behave', body: [
          'Follow the Community Guidelines and the Safety Policy. Do not harass anyone, share anyone’s contact details, impersonate others, post content that is not yours, try to get around our safety features, or scrape or bulk-collect data from KICKSCOUT.',
        ],
      },
      {
        id: 'ai', heading: 'AI features', body: [
          'KICKSCOUT uses AI to suggest skill tags and to screen uploads for safety. AI suggestions can be wrong; they are labelled as AI-suggested and you can correct them. AI is never used to rate a player’s ability or potential, and anything unclear is decided by a person.',
        ],
      },
      {
        id: 'moderation', heading: 'Moderation and enforcement', body: [
          'We may hold, restrict or remove content and suspend accounts that break these terms or the guidelines, or to protect users, especially minors. Where we can, we tell you what happened. You can ask us to look again, and copyright removals can be disputed with a counter-notice.',
        ],
      },
      { id: 'paid', heading: 'Paid features', body: ['KICKSCOUT does not sell anything today. If paid plans are introduced, the Subscription & Refund Terms will apply to them.'] },
      {
        id: 'ending', heading: 'Leaving KICKSCOUT', body: [
          'You can download your data and delete your account at any time in Settings. Deletion removes your profile and videos from the platform straight away. For a player under 18 with a linked guardian, the profile is hidden immediately and the guardian confirms the deletion.',
        ],
      },
      {
        id: 'liability', heading: 'Disclaimers and liability', body: [
          'KICKSCOUT is provided as it is. To the extent the law allows, we are not responsible for what users post or agree with each other, or for losses caused by relying on content or contacts made on the platform. Nothing in these terms limits rights you have under consumer law that cannot be limited. The exact wording of this section will be set during legal review.',
        ],
      },
      { id: 'changes', heading: 'Changes to these terms', body: ['We will tell you in the app before material changes take effect and record which version you accepted.'] },
    ],
  },
  {
    slug: 'privacy',
    titleKey: 'privacy',
    summary: 'What we collect, why, who can see it, and the controls you have.',
    sections: [
      draft('The identity of the data controller, the contact for privacy requests and the legal bases for each use will be added after legal review.'),
      {
        id: 'collect', heading: 'What we collect', body: [
          'Account: the email address and sign-in details from your sign-in provider (email and password, or Google), your handle, display name, bio, avatar, language, roles, and the country and optional region you choose.',
          'Age: your date of birth, stored encrypted and converted to an age group (under 13, under 16, under 18, 18+) used to apply protections. It is never shown to anyone else.',
          'Player details you add: positions, preferred foot and the details of your clips (title, description, skill, position, foot, category, hashtags and privacy).',
          'Videos: the files you upload, the processed versions, thumbnails, technical details (length, size, format, a fingerprint used to detect duplicates), AI skill-tag suggestions and safety results, and the time you confirmed you have the rights to post the clip.',
          'Activity: follows, likes, saves, comments, reports, blocks, challenge entries, contact requests and responses, notifications and your settings. Views are counted once per viewer per day; for signed-out visitors we store a daily salted hash, never a raw IP address.',
          'Guardians and consents: guardian invitations (the invitation token is stored hashed), guardian links, and a record of every consent granted or withdrawn and by whom.',
          'Scouts: verification applications and evidence, shortlists, and private notes (visible only to the scout who wrote them).',
          'Copyright: the name, email and statements of anyone who sends a takedown request, and counter-notices.',
          'Security and audit: an append-only log of sensitive actions such as consent changes, moderation decisions, scout searches, data exports and account deletions.',
        ],
      },
      {
        id: 'use', heading: 'How we use it', body: [
          'To run the platform (accounts, uploads, feeds, search, Talent Radar, challenges, scout tools and notifications), to protect users and especially minors, to moderate content, to answer copyright requests and reports, to keep the service secure, and to meet legal obligations.',
          'To improve our AI skill tagging only if you (or your guardian) turned on the “Help improve AI” consent.',
          'We do not sell your personal data and we do not show advertising.',
        ],
      },
      {
        id: 'visible', heading: 'Who can see what', body: [
          'Others only ever see what our servers allow for their relationship to you. Your email and date of birth are never shown. Your country, region and age group are shown according to your settings.',
          'Profile visibility can be public, unlisted (anyone with your link, but never listed in feeds, search, Discover, Talent Radar or scout search), followers only, or private. You can also turn off scout discovery, contact requests, and showing your country, region or age group.',
          'Players under 18 always have stricter rules: they start private, their city and email are never shown, direct messages are off, and scout contact goes to their guardian. Settings can make a minor’s profile stricter but never looser than these rules, and only the guardian can loosen them.',
        ],
      },
      {
        id: 'processors', heading: 'Service providers', body: [
          'We use providers to run KICKSCOUT: database, sign-in and file storage (Supabase), web and API hosting (Vercel or a similar host), and AI analysis of sampled video frames (Anthropic’s Claude API) for skill tags and safety screening. If you sign in with Google, Google handles that sign-in. Providers process data only on our instructions. The full list and the locations of processing will be confirmed during legal review.',
        ],
      },
      {
        id: 'cookies', heading: 'Cookies and similar technologies', body: [
          'KICKSCOUT does not use analytics, advertising or tracking cookies, so we do not show a cookie consent banner.',
          'We set one cookie, ks_locale, which remembers the language you chose. Your sign-in session is kept in your browser’s local storage by our sign-in provider so you stay logged in. Both are needed for the features you use.',
          'Our pages load fonts from Google Fonts, so Google’s servers receive your IP address and browser details when the fonts load. If we add any non-essential cookie in future, we will ask for your consent first and update this policy.',
        ],
      },
      {
        id: 'rights', heading: 'Your choices and rights', body: [
          'In Settings you can change your profile, privacy and notification settings, grant or withdraw consents, download a copy of your data as a JSON file, and delete your account.',
          'The download contains your account, profile, settings, consents, video details, comments, the accounts you follow, your likes, saves and notifications (and, for scouts, your shortlists and notes). It does not contain other people’s private data.',
          'For a player under 18, the guardian exercises these rights with them.',
          'Depending on where you live you may have further rights (for example to object or to complain to a data protection authority). These will be listed here after legal review.',
        ],
      },
      {
        id: 'retention', heading: 'How long we keep data', body: [
          'When you delete your account, your profile and videos are removed from the platform immediately, your email address and profile details are cleared, and your follows, likes and saves are deleted. Your handle stays reserved, and we keep a minimal record in our audit log. Video files are purged from storage in the background. Backup and audit retention periods will be set during legal review.',
        ],
      },
      { id: 'children', heading: 'Children', body: ['Nobody under 13 can create an account. Players aged 13 to 17 need a guardian’s approval, and the protections described above always apply to them.'] },
      { id: 'changes', heading: 'Changes', body: ['We will tell you in the app before material changes take effect.'] },
    ],
  },
  {
    slug: 'community-guidelines',
    titleKey: 'community',
    summary: 'What belongs on KICKSCOUT and what does not.',
    sections: [
      draft(),
      { id: 'football', heading: 'Keep it football', body: ['Post clips of football: skills, matches, training, freestyle, challenges, goals, saves. Content that is not football may be held for review or removed.'] },
      { id: 'yours', heading: 'Post only your own clips', body: ['Upload footage you filmed, own, or have permission to post. Do not re-upload broadcasts, other players’ highlight videos or clips from other platforms without permission. Do not claim someone else’s skills as your own.'] },
      {
        id: 'respect', heading: 'Respect people', body: [
          'No harassment, bullying, threats, hate speech or discrimination. No sexual content, and nothing that sexualises minors in any way. No violence, dangerous stunts that invite copying, or content that promotes self-harm.',
          'Criticise skills, not people. Comments on young players’ clips are held for review if they look like an attempt to get contact details.',
        ],
      },
      {
        id: 'contact', heading: 'Keep contact on the platform', body: [
          'Do not ask for or share phone numbers, emails, messaging handles or addresses in comments, especially on clips by players under 18. Scouts use KICKSCOUT contact requests, which go to the guardian for minors.',
        ],
      },
      {
        id: 'honest', heading: 'Be who you say you are', body: [
          'No impersonation, fake accounts or fake scouts. Never ask a player for money for a trial, a review or “guaranteed” opportunities. Report anyone who does; scout-related reports are reviewed ahead of ordinary ones.',
        ],
      },
      {
        id: 'enforcement', heading: 'What happens if rules are broken', body: [
          'Content can be held, made private or removed, and accounts can be restricted or suspended. Child-safety reports and anything involving a minor go to the front of the moderation queue. Automated checks only flag content; people make the decisions that are not clear-cut.',
        ],
      },
    ],
  },
  {
    slug: 'copyright',
    titleKey: 'copyright',
    summary: 'How ownership works on KICKSCOUT and how to ask for a video to be removed.',
    sections: [
      draft('The designated contact for copyright notices and the statutory wording required in each country will be added after legal review.'),
      { id: 'ownership', heading: 'Ownership', body: ['You keep ownership of what you upload and give KICKSCOUT only the limited licence described in the Terms of Service. Every upload requires you to confirm that you filmed the clip or own it, or have permission from whoever does.'] },
      {
        id: 'takedown', heading: 'Asking for a takedown', body: [
          'If a video uses your work without permission, use the takedown request form. You do not need an account. Tell us your name, an email for our reply, the link to the video, a description of your work and how the video uses it, and confirm that you believe in good faith the use is not authorised and that the information is accurate.',
          'Each request opens a priority case for our moderators. While it is reviewed the video may stay up; if the claim is upheld the video is removed and the uploader is told.',
          'Knowingly false or abusive requests may be ignored and may have legal consequences.',
        ],
      },
      {
        id: 'counter', heading: 'Counter-notices', body: [
          'If your video was removed after a copyright claim and you believe that was a mistake, you can file a counter-notice explaining why. A moderator reviews it; if it is accepted the video is restored and the claim no longer counts against you. For a player under 18, the guardian files the counter-notice.',
        ],
      },
      {
        id: 'repeat', heading: 'Repeat infringers', body: [
          'We count upheld copyright claims for each account (once per video). Our staff see this count when reviewing cases, and accounts with repeated upheld claims may be restricted or suspended. A claim reversed by an accepted counter-notice no longer counts.',
        ],
      },
    ],
  },
  {
    slug: 'safety',
    titleKey: 'safety',
    summary: 'The protections KICKSCOUT enforces, especially for players under 18.',
    sections: [
      draft(),
      {
        id: 'minors', heading: 'Players under 18', body: [
          'Under-13s cannot sign up. Players under 18 need a guardian’s approval, start with a private profile, never show their city or email, cannot receive direct messages, and get scout contact only through their guardian, and only if the guardian allows it. Privacy settings can make a minor’s profile stricter but never looser than this, and only the guardian can loosen anything.',
        ],
      },
      { id: 'contact', heading: 'Contact', body: ['Direct messaging is not available. Verified scouts send contact requests that the player, or the guardian of a minor, accepts or declines. Contact details are never shared by KICKSCOUT.'] },
      { id: 'scouts', heading: 'Scouts', body: ['Scout tools open only after our team verifies the scout’s organisation. Scout searches are logged. Players can turn off scout discovery and contact requests at any time.'] },
      {
        id: 'reporting', heading: 'Reporting', body: [
          'Report any clip, comment or profile, including a scout’s. Child-safety reports and anything about a minor are reviewed first. If someone is in immediate danger, contact your local emergency services.',
        ],
      },
      { id: 'ai', heading: 'AI', body: ['AI suggests skill tags and screens uploads. It never rates ability or potential, and anything unclear is decided by a person.'] },
    ],
  },
  {
    slug: 'scout-terms',
    titleKey: 'scouts',
    summary: 'Extra terms for verified scouts and the organisations they represent.',
    sections: [
      draft('Organisation accounts (clubs and academies) are not built yet; these terms will be extended when they are.'),
      { id: 'verification', heading: 'Verification', body: ['You may use scout tools only after verification, only on behalf of the organisation you were verified for, and only while you still represent it. Tell us if that changes.'] },
      { id: 'no-guarantee', heading: 'No guarantees and your responsibility', body: [NO_GUARANTEE, DUE_DILIGENCE] },
      {
        id: 'conduct', heading: 'Conduct', body: [
          'Contact players only through KICKSCOUT contact requests. Requests about players under 18 go to their guardian; respect a declined request. Never ask a player or family for money, and never promise outcomes you cannot deliver.',
          'Your shortlists and notes are private to you. Do not copy, scrape, export in bulk or share player data outside your organisation, and use it only to assess and contact players.',
        ],
      },
      { id: 'enforcement', heading: 'Enforcement', body: ['Players can report scouts. We may remove scout access or suspend accounts that break these terms, and searches and contact requests are logged for this purpose.'] },
    ],
  },
  {
    slug: 'subscription-terms',
    titleKey: 'subscriptions',
    summary: 'How paid plans, cancellations and refunds will work.',
    sections: [
      draft(),
      { id: 'today', heading: 'Nothing is for sale today', body: ['KICKSCOUT has no paid plans yet and takes no payments. Paid scout plans are labelled “Coming Soon” in the app.'] },
      {
        id: 'principles', heading: 'When paid plans arrive', body: [
          'Players will never pay to be seen, ranked or recommended to scouts, and paying will never change Talent Radar.',
          'The price, billing period, renewal and how to cancel will be shown before you pay. You will be able to cancel at any time, effective at the end of the current period.',
          'Refunds will follow the law where you live and the rules of the store you paid through. The detailed refund terms will be published here before any payment is taken.',
        ],
      },
    ],
  },
];

export function legalDoc(slug: string): LegalDoc | undefined {
  return LEGAL_DOCS.find((d) => d.slug === slug);
}

/** Exported for tests: the non-negotiable statements. */
export const LEGAL_STATEMENTS = { NO_GUARANTEE, DUE_DILIGENCE };
