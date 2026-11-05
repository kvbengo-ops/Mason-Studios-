"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/types/db";

/**
 * Browser-side Supabase client. Anon key, subject to RLS.
 *
 * Used for auth state (onAuthStateChange) and Realtime subscriptions only —
 * regular reads/writes go through Server Components / Server Actions using
 * lib/supabase/server.ts instead.
 */
export function createClient(): ReturnType<typeof createBrowserClient<Database>> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY environment variables.",
    );
  }

  return createBrowserClient<Database>(supabaseUrl, supabaseAnonKey);
}
