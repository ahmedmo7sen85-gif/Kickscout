'use client';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { authConfigured, publicEnv } from './env';

let client: SupabaseClient | null = null;

/** The browser Supabase client, or null when auth is not configured for this deployment. */
export function getSupabase(): SupabaseClient | null {
  if (!authConfigured || typeof window === 'undefined') return null;
  client ??= createClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
  });
  return client;
}
