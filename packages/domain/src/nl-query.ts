/**
 * Natural-language scout search, rule-based. Turns a scout's sentence (English or Arabic) into the
 * same structured filters the scout search form sends. Used when no AI model is configured or the AI
 * answer is unusable, and as the reference behaviour for the AI parser. The query is only ever data:
 * it is matched against fixed vocabularies, so nothing in it can change what the parser does.
 */
import { FEET, POSITIONS } from './taxonomy.js';
import type { Foot, Position } from './taxonomy.js';
import type { AgeBand } from './age.js';

export interface ScoutFilters {
  q?: string;
  country?: string;
  position?: Position;
  foot?: Foot;
  skill?: string;
  ageGroup?: AgeBand;
  verifiedOnly?: boolean;
  minFollowers?: number;
}

export type ScoutFilterKey = keyof ScoutFilters;
export const SCOUT_FILTER_KEYS: readonly ScoutFilterKey[] = ['q', 'position', 'foot', 'ageGroup', 'country', 'skill', 'verifiedOnly', 'minFollowers'];

export interface SkillVocabulary {
  key: string;
  names: { en: string; ar: string };
}

export interface RuleParse {
  filters: ScoutFilters;
  /** What each filter was read from, in query order. */
  matched: { field: ScoutFilterKey; text: string }[];
}

export const MAX_NL_QUERY_LENGTH = 300;

// ---------------------------------------------------------------- normalisation

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

/** Lowercase, ASCII digits, unified Arabic letter forms, no diacritics or tatweel, hyphens as spaces. */
export function normalizeQuery(text: string): string {
  return text
    .normalize('NFKC')
    .replace(ARABIC_DIGITS, (d) => String((d.charCodeAt(0) & 0xf) % 10))
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .toLowerCase()
    .replace(/[-_/،,;:!?()"'“”«»]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const isArabic = (s: string) => /[؀-ۿ]/.test(s);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A matcher for one phrase. English phrases allow a plural "s"; Arabic phrases allow the attached
 * article and conjunctions in front (ال، و، ب، لل) and common plural/feminine endings.
 */
function phrase(term: string): RegExp {
  const t = normalizeQuery(term);
  if (isArabic(t)) {
    const words = t.split(' ').map((w) => escape(w.replace(/^ال/, '')));
    const body = words.map((w) => `(?:ال)?${w}(?:ين|ون|ات|ه|ي)?`).join('\\s+');
    return new RegExp(`(?<![\\p{L}\\p{N}])(?:و|ب|ل|لل|بال|وال|فال)?${body}(?![\\p{L}\\p{N}])`, 'u');
  }
  const body = t.split(' ').map(escape).join('\\s*');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?:s|es)?(?![\\p{L}\\p{N}])`, 'u');
}

/** Finds the first match of any phrase, longest phrases first; returns the match and blanks it out. */
class Text {
  constructor(public value: string) {}
  take(re: RegExp): RegExpExecArray | null {
    const m = re.exec(this.value);
    if (m) this.value = this.value.slice(0, m.index) + ' '.repeat(m[0].length) + this.value.slice(m.index + m[0].length);
    return m;
  }
  takeAny<T>(table: readonly [string, T][]): { value: T; text: string; index: number } | null {
    let best: { value: T; text: string; index: number; len: number; re: RegExp } | null = null;
    for (const [term, value] of [...table].sort((a, b) => b[0].length - a[0].length)) {
      const re = phrase(term);
      const m = re.exec(this.value);
      if (m && (!best || m.index < best.index || (m.index === best.index && m[0].length > best.len))) best = { value, text: m[0].trim(), index: m.index, len: m[0].length, re };
    }
    if (!best) return null;
    this.take(best.re);
    return best;
  }
}

// ---------------------------------------------------------------- vocabularies

const POSITION_TERMS: [string, Position][] = [
  ['goalkeeper', 'GK'], ['goal keeper', 'GK'], ['keeper', 'GK'], ['goalie', 'GK'], ['gk', 'GK'],
  ['centre back', 'CB'], ['center back', 'CB'], ['central defender', 'CB'], ['centreback', 'CB'], ['cb', 'CB'],
  ['left back', 'LB'], ['lb', 'LB'], ['right back', 'RB'], ['rb', 'RB'],
  ['wing back', 'WB'], ['wingback', 'WB'], ['wb', 'WB'],
  ['defensive midfielder', 'DM'], ['holding midfielder', 'DM'], ['defensive mid', 'DM'], ['cdm', 'DM'], ['dm', 'DM'],
  ['central midfielder', 'CM'], ['centre midfielder', 'CM'], ['center midfielder', 'CM'], ['midfielder', 'CM'], ['cm', 'CM'],
  ['attacking midfielder', 'AM'], ['attacking mid', 'AM'], ['playmaker', 'AM'], ['number 10', 'AM'], ['cam', 'AM'],
  ['left winger', 'LW'], ['left wing', 'LW'], ['lw', 'LW'], ['right winger', 'RW'], ['right wing', 'RW'], ['rw', 'RW'],
  ['forward', 'FW'], ['fw', 'FW'], ['striker', 'ST'], ['centre forward', 'ST'], ['center forward', 'ST'], ['number 9', 'ST'], ['st', 'ST'], ['cf', 'ST'],
  // Arabic
  ['حارس مرمى', 'GK'], ['حارس', 'GK'], ['قلب دفاع', 'CB'], ['ظهير ايسر', 'LB'], ['ظهير ايمن', 'RB'], ['ظهير جناح', 'WB'],
  ['لاعب وسط دفاعي', 'DM'], ['وسط دفاعي', 'DM'], ['محور', 'DM'], ['لاعب وسط هجومي', 'AM'], ['وسط هجومي', 'AM'], ['صانع العاب', 'AM'],
  ['لاعب وسط', 'CM'], ['وسط ملعب', 'CM'], ['جناح ايسر', 'LW'], ['جناح ايمن', 'RW'], ['مهاجم', 'FW'], ['راس حربه', 'ST'], ['مهاجم صريح', 'ST'],
];

const FOOT_TERMS: [string, Foot][] = [
  ['left footed', 'left'], ['left foot', 'left'], ['leftfooted', 'left'], ['lefty', 'left'], ['left footer', 'left'], ['weak right foot', 'left'],
  ['right footed', 'right'], ['right foot', 'right'], ['rightfooted', 'right'], ['right footer', 'right'],
  ['two footed', 'both'], ['both feet', 'both'], ['both footed', 'both'], ['either foot', 'both'], ['ambidextrous', 'both'],
  ['القدم اليسري', 'left'], ['قدم يسري', 'left'], ['اعسر', 'left'], ['يساري', 'left'],
  ['القدم اليمني', 'right'], ['قدم يمني', 'right'], ['ايمن القدم', 'right'],
  ['كلتا القدمين', 'both'], ['بالقدمين', 'both'], ['القدمين', 'both'],
];

/** Country names (English and Arabic, with demonyms) to ISO 3166-1 alpha-2. */
export const COUNTRY_TERMS: [string, string][] = [
  ['egypt', 'EG'], ['egyptian', 'EG'], ['مصر', 'EG'], ['مصري', 'EG'],
  ['saudi arabia', 'SA'], ['saudi', 'SA'], ['ksa', 'SA'], ['السعوديه', 'SA'], ['سعودي', 'SA'],
  ['united arab emirates', 'AE'], ['uae', 'AE'], ['emirates', 'AE'], ['emirati', 'AE'], ['الامارات', 'AE'], ['اماراتي', 'AE'],
  ['qatar', 'QA'], ['qatari', 'QA'], ['قطر', 'QA'], ['قطري', 'QA'],
  ['kuwait', 'KW'], ['kuwaiti', 'KW'], ['الكويت', 'KW'], ['كويتي', 'KW'],
  ['bahrain', 'BH'], ['البحرين', 'BH'], ['oman', 'OM'], ['omani', 'OM'], ['عمان', 'OM'],
  ['jordan', 'JO'], ['jordanian', 'JO'], ['الاردن', 'JO'], ['اردني', 'JO'],
  ['lebanon', 'LB'], ['lebanese', 'LB'], ['لبنان', 'LB'], ['syria', 'SY'], ['سوريا', 'SY'], ['iraq', 'IQ'], ['iraqi', 'IQ'], ['العراق', 'IQ'], ['عراقي', 'IQ'],
  ['palestine', 'PS'], ['palestinian', 'PS'], ['فلسطين', 'PS'],
  ['morocco', 'MA'], ['moroccan', 'MA'], ['المغرب', 'MA'], ['مغربي', 'MA'],
  ['algeria', 'DZ'], ['algerian', 'DZ'], ['الجزائر', 'DZ'], ['جزائري', 'DZ'],
  ['tunisia', 'TN'], ['tunisian', 'TN'], ['تونس', 'TN'], ['تونسي', 'TN'],
  ['libya', 'LY'], ['ليبيا', 'LY'], ['sudan', 'SD'], ['السودان', 'SD'], ['yemen', 'YE'], ['اليمن', 'YE'],
  ['nigeria', 'NG'], ['nigerian', 'NG'], ['نيجيريا', 'NG'], ['ghana', 'GH'], ['غانا', 'GH'], ['senegal', 'SN'], ['السنغال', 'SN'],
  ['cameroon', 'CM'], ['الكاميرون', 'CM'], ['turkey', 'TR'], ['turkiye', 'TR'], ['تركيا', 'TR'],
  ['france', 'FR'], ['فرنسا', 'FR'], ['spain', 'ES'], ['اسبانيا', 'ES'], ['germany', 'DE'], ['المانيا', 'DE'], ['italy', 'IT'], ['ايطاليا', 'IT'],
  ['portugal', 'PT'], ['البرتغال', 'PT'], ['netherlands', 'NL'], ['هولندا', 'NL'], ['united kingdom', 'GB'], ['uk', 'GB'], ['england', 'GB'], ['بريطانيا', 'GB'], ['انجلترا', 'GB'],
  ['brazil', 'BR'], ['البرازيل', 'BR'], ['argentina', 'AR'], ['الارجنتين', 'AR'], ['united states', 'US'], ['usa', 'US'], ['امريكا', 'US'],
];
const COUNTRY_CODES = new Set(COUNTRY_TERMS.map(([, c]) => c));
const POSITION_CODES = new Set<string>(POSITIONS);

/** Extra ways people name skills, on top of the taxonomy's English and Arabic names. */
const SKILL_SYNONYMS: [string, string][] = [
  ['dribbler', 'dribbling'], ['dribble', 'dribbling'], ['stepover', 'step_over'], ['step over', 'step_over'], ['rainbow', 'rainbow_flick'],
  ['one on one', 'one_v_one'], ['1v1', 'one_v_one'], ['1 v 1', 'one_v_one'], ['nutmeg', 'nutmeg'], ['panna', 'nutmeg'],
  ['free kick', 'free_kick'], ['freekick', 'free_kick'], ['finisher', 'finishing'], ['shot stopper', 'goalkeeping'], ['saves', 'reflexes'],
  ['crosser', 'crossing'], ['passer', 'passing'], ['tackler', 'tackling'], ['pace', 'speed'], ['fast', 'speed'], ['quick', 'speed'],
  ['keepie uppie', 'juggling'], ['keepy uppy', 'juggling'], ['croqueta', 'la_croqueta'], ['long shots', 'long_range_shooting'],
  ['مراوغ', 'dribbling'], ['مراوغه', 'dribbling'], ['تسديد', 'shooting'], ['سريع', 'speed'], ['ركلات حره', 'free_kick'],
];

// ---------------------------------------------------------------- ages and numbers

export function ageToBand(age: number): AgeBand {
  if (age < 13) return 'u13';
  if (age < 16) return 'u16';
  if (age < 18) return 'u18';
  return 'adult';
}

/** "under 16", "u16", "u-16" -> the age band whose players are all younger than that. */
function bandUnder(limit: number): AgeBand | null {
  if (limit <= 13) return 'u13';
  if (limit <= 16) return 'u16';
  if (limit <= 18) return 'u18';
  return null;
}

function takeAge(t: Text): { band: AgeBand; text: string } | null {
  let m = t.take(/(?<![\p{L}\p{N}])(?:under|below|younger than|u|تحت|دون|اقل من)\s*(\d{1,2})(?:s)?(?![\p{L}\p{N}])/u);
  if (m) {
    const band = bandUnder(Number(m[1]));
    if (band) return { band, text: m[0].trim() };
  }
  m = t.take(/(?<![\p{L}\p{N}])(?:adults?|seniors?|over 18|18\s*\+|بالغ(?:ين)?|كبار)(?![\p{L}\p{N}])/u);
  if (m) return { band: 'adult', text: m[0].trim() };
  m = t.take(/(?<![\p{L}\p{N}])(?:aged?\s*|عمر(?:ه)?\s*|سن\s*)?(\d{1,2})\s*(?:years?\s*old|year olds?|yo|y\/o|yrs?|سنه|سنوات|سنين|عام|عاما|اعوام)(?![\p{L}\p{N}])/u)
    ?? t.take(/(?<![\p{L}\p{N}])(?:aged?|عمر(?:ه)?|سن)\s*(\d{1,2})(?![\p{L}\p{N}])/u);
  if (m) {
    const age = Number(m[1]);
    if (age >= 5 && age <= 60) return { band: ageToBand(age), text: m[0].trim() };
  }
  return null;
}

function takeFollowers(t: Text): { n: number; text: string } | null {
  const num = '(\\d+(?:[.,]\\d+)?)\\s*(k|m|الف|ألف)?';
  const m = t.take(new RegExp(`(?:(?:at least|over|more than|min(?:imum)?|اكثر من|على الاقل)\\s*)?${num}\\s*\\+?\\s*(?:followers?|fans|متابع(?:ين)?)`, 'u'));
  if (!m) return null;
  let n = Number(m[1]!.replace(',', '.'));
  const unit = m[2];
  if (unit === 'k' || unit === 'الف' || unit === 'ألف') n *= 1_000;
  if (unit === 'm') n *= 1_000_000;
  n = Math.round(n);
  return n > 0 && n <= 100_000_000 ? { n, text: m[0].trim() } : null;
}

// ---------------------------------------------------------------- the parser

/**
 * Reads filters out of free text. Only fixed vocabularies are matched; everything else is ignored.
 * At most one value per filter (the scout search takes one), the first one mentioned.
 */
export function parseScoutQueryRules(query: string, skills: readonly SkillVocabulary[]): RuleParse {
  const filters: ScoutFilters = {};
  const matched: RuleParse['matched'] = [];
  const raw = query.slice(0, MAX_NL_QUERY_LENGTH);
  const note = (field: ScoutFilterKey, text: string) => matched.push({ field, text });

  // A handle is the only free text passed through, and only in handle form.
  const handle = /(?:^|\s)@([a-zA-Z0-9_.]{3,30})(?![a-zA-Z0-9_.])/.exec(raw);
  if (handle) {
    filters.q = handle[1]!;
    note('q', `@${handle[1]}`);
  }
  // Bare country codes are read from the original casing ("EG"), never from lower-case words.
  const upperCodes = [...raw.matchAll(/(?<![A-Za-z])([A-Z]{2})(?![A-Za-z])/g)].map((m) => m[1]!);

  const t = new Text(normalizeQuery(raw.replace(/(?:^|\s)@[a-zA-Z0-9_.]{3,30}/g, ' ')));

  const followers = takeFollowers(t);
  if (followers) {
    filters.minFollowers = followers.n;
    note('minFollowers', followers.text);
  }
  const age = takeAge(t);
  if (age) {
    filters.ageGroup = age.band;
    note('ageGroup', age.text);
  }
  // Feet before positions, so "left footed" is not read as "left wing"; positions before skills and countries.
  const foot = t.takeAny(FOOT_TERMS);
  if (foot) {
    filters.foot = foot.value;
    note('foot', foot.text);
  }
  const position = t.takeAny(POSITION_TERMS);
  if (position) {
    filters.position = position.value;
    note('position', position.text);
  }
  const verified = t.take(/(?<![\p{L}\p{N}])(?:verified|موثق(?:ين|ون)?)(?![\p{L}\p{N}])/u);
  if (verified) {
    filters.verifiedOnly = true;
    note('verifiedOnly', verified[0].trim());
  }
  const country = t.takeAny(COUNTRY_TERMS);
  if (country) {
    filters.country = country.value;
    note('country', country.text);
  } else {
    const code = upperCodes.find((c) => COUNTRY_CODES.has(c) && !POSITION_CODES.has(c));
    if (code) {
      filters.country = code;
      note('country', code);
    }
  }
  const skillTable: [string, string][] = [
    ...skills.flatMap((s): [string, string][] => [[s.names.en, s.key], [s.names.ar, s.key], [s.key.replaceAll('_', ' '), s.key]]),
    ...SKILL_SYNONYMS.filter(([, key]) => skills.some((s) => s.key === key)),
  ];
  const skill = t.takeAny(skillTable);
  if (skill) {
    filters.skill = skill.value;
    note('skill', skill.text);
  }
  matched.sort((a, b) => normalizeQuery(raw).indexOf(normalizeQuery(a.text)) - normalizeQuery(raw).indexOf(normalizeQuery(b.text)));
  return { filters, matched };
}

// ---------------------------------------------------------------- explaining filters

export const POSITION_NAMES: Record<Position, { en: string; ar: string }> = {
  GK: { en: 'Goalkeeper', ar: 'حارس مرمى' }, CB: { en: 'Centre-back', ar: 'قلب دفاع' }, LB: { en: 'Left-back', ar: 'ظهير أيسر' },
  RB: { en: 'Right-back', ar: 'ظهير أيمن' }, WB: { en: 'Wing-back', ar: 'ظهير جناح' }, DM: { en: 'Defensive midfielder', ar: 'لاعب وسط دفاعي' },
  CM: { en: 'Central midfielder', ar: 'لاعب وسط' }, AM: { en: 'Attacking midfielder', ar: 'لاعب وسط هجومي' }, LW: { en: 'Left winger', ar: 'جناح أيسر' },
  RW: { en: 'Right winger', ar: 'جناح أيمن' }, FW: { en: 'Forward', ar: 'مهاجم' }, ST: { en: 'Striker', ar: 'رأس حربة' },
};
const FOOT_NAMES: Record<Foot, { en: string; ar: string }> = {
  left: { en: 'left foot', ar: 'القدم اليسرى' }, right: { en: 'right foot', ar: 'القدم اليمنى' }, both: { en: 'both feet', ar: 'كلتا القدمين' },
};
const AGE_NAMES: Record<AgeBand, { en: string; ar: string }> = {
  u13: { en: 'under 13', ar: 'دون 13' }, u16: { en: 'under 16', ar: 'دون 16' }, u18: { en: 'under 18', ar: 'دون 18' }, adult: { en: '18+', ar: '18 فأكثر' },
};

/**
 * One plain sentence saying what will be searched, built from the validated filters only (never
 * from model text), in English and Arabic.
 */
export function describeScoutFilters(f: ScoutFilters, skillName: (key: string) => { en: string; ar: string }): { en: string; ar: string } {
  const en: string[] = [];
  const ar: string[] = [];
  if (f.position) { en.push(POSITION_NAMES[f.position].en.toLowerCase() + 's'); ar.push(POSITION_NAMES[f.position].ar); }
  if (f.foot) { en.push(`who prefer the ${FOOT_NAMES[f.foot].en}`); ar.push(`يفضّل ${FOOT_NAMES[f.foot].ar}`); }
  if (f.ageGroup) { en.push(`aged ${AGE_NAMES[f.ageGroup].en}`); ar.push(`الفئة العمرية ${AGE_NAMES[f.ageGroup].ar}`); }
  if (f.country) { en.push(`from ${f.country}`); ar.push(`من ${f.country}`); }
  if (f.skill) { const n = skillName(f.skill); en.push(`with ${n.en} clips`); ar.push(`لديهم مقاطع ${n.ar}`); }
  if (f.verifiedOnly) { en.push('verified only'); ar.push('الموثقون فقط'); }
  if (f.minFollowers) { en.push(`with at least ${f.minFollowers} followers`); ar.push(`لديهم ${f.minFollowers} متابع على الأقل`); }
  if (f.q) { en.push(`matching “${f.q}”`); ar.push(`يطابق «${f.q}»`); }
  if (!en.length) return { en: 'All players open to scouts (no filters recognised).', ar: 'كل اللاعبين المتاحين للكشافين (لم يُتعرّف على أي فلتر).' };
  return {
    en: `Searching ${f.position ? '' : 'players '}${en.join(', ')}.`,
    ar: `البحث عن ${f.position ? '' : 'لاعبين '}${ar.join('، ')}.`,
  };
}

/** Feet and positions are re-exported for parsers that build their own prompts. */
export const NL_FILTER_VOCABULARY = { positions: POSITIONS, feet: FEET } as const;
