/**
 * Public configuration only. Every value here is inlined into the client bundle at build time,
 * so nothing secret may ever be read in this module.
 */
const trimSlash = (s: string) => s.replace(/\/+$/, '');

export const publicEnv = {
  apiUrl: trimSlash(process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080'),
  siteUrl: trimSlash(process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'),
  promoBaseUrl: trimSlash(process.env.NEXT_PUBLIC_PROMO_BASE_URL || '/promo'),
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
  policyVersion: process.env.NEXT_PUBLIC_POLICY_VERSION || '2026-10-draft',
  /** Optional: where the Enterprise "Contact sales" button sends email. */
  salesEmail: process.env.NEXT_PUBLIC_SALES_EMAIL || '',
};

export const authConfigured = Boolean(publicEnv.supabaseUrl && publicEnv.supabaseAnonKey);
