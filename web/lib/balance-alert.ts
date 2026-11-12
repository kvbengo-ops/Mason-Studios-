import { createAdminClient, createClient } from "@/lib/supabase/server";
import { isDev } from "@/lib/mode";
import { buildBalanceAlertEmail } from "@/lib/balance-alert-email";

export type BalanceVendor = "kie" | "byteplus";

const VENDOR_LABEL: Record<BalanceVendor, string> = { kie: "Kie", byteplus: "BytePlus" };
const DEFAULT_FROM = "Maison Studios <no-reply@vbgstudio.site>";
const DEFAULT_APP_URL = "https://app.vbgstudio.site";

/**
 * Emails the chosen admins once when a vendor balance drops below its threshold
 * (balance_alert_settings, 0140). Called by lib/kie-balance.ts and
 * lib/byteplus-balance.ts after each FRESH read (at most once a minute per
 * process), so it rides along with every priced render and admin page.
 *
 * One dip, one email: the *_alerted_at latch is claimed atomically before
 * sending (a second process finds it taken), and cleared once the balance is
 * back at or above the threshold. A failed send clears it so the next read
 * retries. Never throws: an alert must not break a render.
 */
export async function checkLowBalance(vendor: BalanceVendor, balanceUsd: number): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (isDev() || !apiKey) return;
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return;
  }
  const latch = vendor === "kie" ? "kie_alerted_at" : "byteplus_alerted_at";
  const latchValue = (value: string | null) =>
    vendor === "kie" ? { kie_alerted_at: value } : { byteplus_alerted_at: value };
  const setLatch = (value: string | null) =>
    admin.from("balance_alert_settings").update(latchValue(value)).eq("id", true);
  let claimed = false;
  try {
    const { data: settings, error } = await admin
      .from("balance_alert_settings")
      .select(
        "kie_threshold_usd, byteplus_threshold_usd, recipient_ids, kie_alerted_at, byteplus_alerted_at",
      )
      .eq("id", true)
      .maybeSingle();
    if (error || !settings) return;

    const threshold =
      vendor === "kie" ? settings.kie_threshold_usd : settings.byteplus_threshold_usd;
    const alertedAt = settings[latch];
    if (threshold === null) return;

    if (balanceUsd >= threshold) {
      if (alertedAt !== null) await setLatch(null);
      return;
    }
    if (alertedAt !== null || settings.recipient_ids.length === 0) return;

    // Claim the latch; only the writer that flips it from null sends.
    const { data: claim } = await admin
      .from("balance_alert_settings")
      .update(latchValue(new Date().toISOString()))
      .eq("id", true)
      .is(latch, null)
      .select("id");
    if (!claim?.length) return;
    claimed = true;

    const { data: recipients } = await admin
      .from("profiles")
      .select("email")
      .in("id", settings.recipient_ids)
      .eq("role", "admin");
    const to = (recipients ?? []).flatMap((row) => (row.email ? [row.email] : []));
    if (to.length === 0) throw new Error("no admin recipient has an email");

    const email = buildBalanceAlertEmail({
      vendorLabel: VENDOR_LABEL[vendor],
      balanceUsd,
      thresholdUsd: threshold,
      appUrl: process.env.NEXT_PUBLIC_APP_URL?.trim() || DEFAULT_APP_URL,
      sentAt: new Date(),
    });
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.RESEND_FROM?.trim() || DEFAULT_FROM,
        to,
        subject: email.subject,
        html: email.html,
        text: email.text,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Resend returned HTTP ${response.status}`);
  } catch (error) {
    // Released so the next fresh read retries, rather than staying silent until recovery.
    if (claimed) await setLatch(null).then(undefined, () => undefined);
    console.warn(
      `checkLowBalance: ${vendor} alert failed —`,
      error instanceof Error ? error.message : error,
    );
  }
}

export interface BalanceAlertSettings {
  kieThresholdUsd: number | null;
  bytePlusThresholdUsd: number | null;
  recipientIds: string[];
  /** When each vendor's alert last went out; null = armed (or off). */
  kieAlertedAt: string | null;
  bytePlusAlertedAt: string | null;
  /** Every active admin, the only accounts that can be picked. */
  admins: { id: string; label: string }[];
  /** False until RESEND_API_KEY is in the web env (web/.env.local): nothing sends. */
  emailConfigured: boolean;
}

/**
 * For Accounts Control. An admin session read (RLS); null hides the card rather
 * than breaking the page.
 */
export async function loadBalanceAlertSettings(): Promise<BalanceAlertSettings | null> {
  try {
    const supabase = await createClient();
    const [{ data: settings, error }, { data: admins }] = await Promise.all([
      supabase
        .from("balance_alert_settings")
        .select(
          "kie_threshold_usd, byteplus_threshold_usd, recipient_ids, kie_alerted_at, byteplus_alerted_at",
        )
        .eq("id", true)
        .maybeSingle(),
      supabase
        .from("profiles")
        .select("id, email, username")
        .eq("role", "admin")
        .neq("status", "deactivated")
        .order("email"),
    ]);
    if (error || !settings) return null;
    return {
      kieThresholdUsd: settings.kie_threshold_usd,
      bytePlusThresholdUsd: settings.byteplus_threshold_usd,
      recipientIds: settings.recipient_ids,
      kieAlertedAt: settings.kie_alerted_at,
      bytePlusAlertedAt: settings.byteplus_alerted_at,
      admins: (admins ?? []).map((row) => ({
        id: row.id,
        label: row.email ?? row.username ?? row.id,
      })),
      emailConfigured: Boolean(process.env.RESEND_API_KEY?.trim()),
    };
  } catch (error) {
    console.error("Failed to load balance alert settings", error);
    return null;
  }
}
