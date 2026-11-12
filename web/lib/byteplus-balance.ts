// BytePlus's real USD balance — server-side only, display only (Accounts Control).
//
// POST https://billing.byteplusapi.com/?Action=QueryBalanceAcct&Version=2022-01-01
//   signed HMAC-SHA256 with an IAM AK/SK (not BYTEPLUS_API_KEY, which only renders)
//   -> {"Result":{"AvailableBalance":"50","CashBalance":"50","Currency":"USD",…}}
//
// Signing mirrors byteplus-sdk-golang base/sign.go; verified live 2026-11-06.
// The IAM user needs BillingCenterReadOnlyAccess. Prepaid cash only: card
// billing or a savings plan can read $0 on an account that still pays.
//
// Same contract as lib/kie-balance.ts: null (never throws, never 0) on any
// failure, no outbound call in development, 60s per-process cache.
import { createHash, createHmac } from "node:crypto";
import { isDev } from "@/lib/mode";

const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 3_000;
const HOST = "billing.byteplusapi.com";
const REGION = "ap-singapore-1";
const SERVICE = "billing";
const QUERY = "Action=QueryBalanceAcct&Version=2022-01-01";
const BODY = "{}";

let cache: { balanceUsd: number; fetchedAtMs: number } | null = null;

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
const hmac = (key: string | Buffer, s: string) => createHmac("sha256", key).update(s).digest();

/** Signed headers for the balance call. `xDate` is `YYYYMMDDTHHMMSSZ` (UTC). */
export function signBalanceRequest(
  accessKeyId: string,
  secretAccessKey: string,
  xDate: string,
): Record<string, string> {
  const date = xDate.slice(0, 8);
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    host: HOST,
    "x-content-sha256": sha256Hex(BODY),
    "x-date": xDate,
  };
  const signed = Object.keys(headers).sort();
  const canonical = [
    "POST",
    "/",
    QUERY,
    signed.map((k) => `${k}:${headers[k]}\n`).join(""),
    signed.join(";"),
    sha256Hex(BODY),
  ].join("\n");
  const scope = `${date}/${REGION}/${SERVICE}/request`;
  const stringToSign = ["HMAC-SHA256", xDate, scope, sha256Hex(canonical)].join("\n");
  let key = hmac(secretAccessKey, date);
  for (const part of [REGION, SERVICE, "request"]) key = hmac(key, part);
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  return {
    ...headers,
    authorization: `HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${signature}`,
  };
}

export async function getBytePlusBalanceUsd(now: number = Date.now()): Promise<number | null> {
  if (isDev()) return null;
  if (cache && now - cache.fetchedAtMs < CACHE_TTL_MS) return cache.balanceUsd;

  const ak = process.env.BYTEPLUS_ACCESS_KEY_ID?.trim();
  const sk = process.env.BYTEPLUS_SECRET_ACCESS_KEY?.trim();
  if (!ak || !sk) return null; // ponytail: optional — unset just means "Unavailable" on the tile

  try {
    const xDate = new Date(now).toISOString().replace(/[-:]|\.\d{3}/g, "");
    const response = await fetch(`https://${HOST}/?${QUERY}`, {
      method: "POST",
      headers: signBalanceRequest(ak, sk, xDate),
      body: BODY,
      // Admin pages await this; a hung BytePlus must not hang them.
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const body = (await response.json()) as {
      ResponseMetadata?: { Error?: { Code?: string } };
      Result?: { AvailableBalance?: string; Currency?: string };
    };
    const balanceUsd = Number(body.Result?.AvailableBalance);
    if (!response.ok || body.Result?.Currency !== "USD" || !Number.isFinite(balanceUsd)) {
      console.error(
        `getBytePlusBalanceUsd: HTTP ${response.status} ${body.ResponseMetadata?.Error?.Code ?? ""} — balance unavailable.`,
      );
      return null;
    }
    cache = { balanceUsd, fetchedAtMs: now };
    return balanceUsd;
  } catch (err) {
    console.error("getBytePlusBalanceUsd: failed —", err instanceof Error ? err.message : err);
    return null;
  }
}
