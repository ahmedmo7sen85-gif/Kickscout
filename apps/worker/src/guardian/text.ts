import type { GuardianCategory } from '@fp/domain';
import type { AudioFindings, AudioSafetyClassifier, TextSignal, VideoMetadataText } from './types.js';

interface Rule {
  name: string;
  category: GuardianCategory;
  probability: number;
  pattern: RegExp;
}

/**
 * Cheap, local first look at the uploader's title, description and hashtags (English and Arabic).
 * Text only supplements the visual checks: it can send a clip to a human, never approve or reject it.
 */
const RULES: Rule[] = [
  { name: 'explicit_terms', category: 'pornography', probability: 0.7, pattern: /\b(?:porn\w*|xxx|nsfw|nudes?|onlyfans|hentai|camgirls?|sexy?|sextape)\b|\b18\s*\+/i },
  { name: 'explicit_terms_ar', category: 'pornography', probability: 0.7, pattern: /(?<!\p{L})(?:سكس|إباحي|اباحي|إباحية|اباحية|عاري|عارية)(?!\p{L})/u },
  { name: 'escort_terms', category: 'sexual_exploitation', probability: 0.6, pattern: /\b(?:escort|hookup|sugar\s*daddy)\b/i },
  { name: 'gambling', category: 'scam', probability: 0.6, pattern: /\b(?:casino|1xbet|bet365|betting tips?|fixed matches?|sure odds)\b|(?<!\p{L})(?:مراهنات|كازينو)(?!\p{L})/iu },
  { name: 'engagement_selling', category: 'scam', probability: 0.6, pattern: /\b(?:buy|free|cheap)\s+(?:followers|likes|views|subscribers)\b/i },
  { name: 'crypto_giveaway', category: 'scam', probability: 0.6, pattern: /\b(?:crypto|bitcoin|forex|airdrop|giveaway)\b/i },
  { name: 'promo', category: 'advertising', probability: 0.5, pattern: /\b(?:promo\s*code|discount\s*code|use\s+code|shop\s+now|order\s+now)\b/i },
  { name: 'off_platform_contact', category: 'spam', probability: 0.4, pattern: /(?:https?:\/\/|wa\.me|t\.me|\bwhats\s?app\b|\btelegram\b|\bsnap(?:chat)?\b|واتس|تليجرام|سناب)/i },
];

export function textSignals(meta: VideoMetadataText): TextSignal[] {
  const fields: [TextSignal['field'], string][] = [
    ['title', meta.title],
    ['description', meta.description ?? ''],
    ['hashtags', meta.hashtags.join(' ')],
  ];
  const out: TextSignal[] = [];
  for (const rule of RULES) {
    for (const [field, text] of fields) {
      if (rule.pattern.test(text)) {
        out.push({ category: rule.category, probability: rule.probability, field, rule: rule.name });
        break;
      }
    }
  }
  return out;
}

/** No speech-to-text or audio-safety provider is wired in yet: the audio check reports itself unavailable. */
export class UnavailableAudioClassifier implements AudioSafetyClassifier {
  async analyze(input: { hasAudio: boolean }): Promise<AudioFindings> {
    return { available: false, reason: input.hasAudio ? 'no_provider' : 'no_audio_track', categories: [] };
  }
}
