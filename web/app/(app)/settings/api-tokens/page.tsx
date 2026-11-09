import type { JSX } from "react";
import Link from "next/link";
import { listApiTokens } from "@/actions/api-tokens";
import { requireUser } from "@/actions/guard";
import { ApiTokensManager } from "@/components/api-tokens-manager";
import { canUseApiTokens } from "@/lib/api-auth";

export default async function ApiTokensSettingsPage(): Promise<JSX.Element> {
  const { profile } = await requireUser();
  const allowed = canUseApiTokens(profile);
  const tokens = allowed ? await listApiTokens() : [];

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-medium text-foreground">Personal API Tokens</h1>
          <p className="text-sm text-muted-foreground">
            Authenticate external scripts and MCP tools against <code>/api/v1/*</code> using your
            account&rsquo;s existing USD spend caps.
          </p>
        </div>
        <Link href="/profile" className="text-sm text-muted-foreground hover:text-foreground">
          &larr; Back to Profile
        </Link>
      </div>

      {allowed ? (
        <ApiTokensManager initialTokens={tokens} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Personal API tokens are available to trusted editors and admins only.
        </p>
      )}
    </div>
  );
}
