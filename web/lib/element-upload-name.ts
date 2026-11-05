import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";

export async function elementUploadNameError(
  client: SupabaseClient<Database>,
  userId: string,
  name: string,
  shared = true,
): Promise<string | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
    return "Enter a tag using 1-64 letters, numbers, - or _, starting with a letter or number.";
  }
  // Escape LIKE wildcards: underscores are literal characters in a tag.
  const pattern = name.replace(/_/g, "\\_");
  const query = client
    .from("elements")
    .select("id")
    .is("deleted_at", null)
    .ilike("name", pattern)
    .limit(1);
  const { data, error } = await (shared
    ? query.or(`is_shared.eq.true,user_id.eq.${userId}`)
    : query.eq("user_id", userId));
  if (error) throw new Error("Could not check that tag. Try again.");
  return data?.length ? `@${name} is already used. Choose another tag.` : null;
}
