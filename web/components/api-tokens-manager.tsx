"use client";

import { useEffect, useState, type JSX } from "react";
import { createApiToken, revokeApiToken, type ApiTokenMetadata } from "@/actions/api-tokens";
import { Button } from "@/components/ui/button";
import { PendingButton } from "@/components/pending-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatUsd } from "@/lib/format-usd";

export function ApiTokensManager({
  initialTokens,
}: {
  initialTokens: ApiTokenMetadata[];
}): JSX.Element {
  const [tokens, setTokens] = useState<ApiTokenMetadata[]>(initialTokens);
  const [newlyCreatedToken, setNewlyCreatedToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Read the clock in a callback, not during render (react-hooks/purity) — same
  // shape as scene-workbench.tsx's useElapsedLabel. Until it lands, nothing
  // shows as expired; the server still refuses an expired token either way.
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    const tick = setTimeout(() => setNowMs(Date.now()), 0);
    return (): void => clearTimeout(tick);
  }, []);

  async function handleCreate(formData: FormData): Promise<void> {
    setError(null);
    setNewlyCreatedToken(null);
    setCopied(false);
    setCreating(true);
    try {
      const res = await createApiToken(formData);
      if (res.error) {
        setError(res.error);
        return;
      }
      if (res.rawToken && res.token) {
        setNewlyCreatedToken(res.rawToken);
        setTokens((prev) => [res.token, ...prev]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create API token.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(tokenId: string): Promise<void> {
    setError(null);
    setRevokingId(tokenId);
    try {
      const res = await revokeApiToken(tokenId);
      if (res?.error) {
        setError(res.error);
        return;
      }
      const nowIso = new Date().toISOString();
      setTokens((prev) => prev.map((t) => (t.id === tokenId ? { ...t, revoked_at: nowIso } : t)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke API token.");
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Create Personal API Token</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={handleCreate} className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="token-name">Token Name</Label>
                <Input
                  id="token-name"
                  name="name"
                  placeholder="e.g. Ced MCP / CLI"
                  maxLength={80}
                  required
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="token-cap">Optional Monthly Cap (USD)</Label>
                <Input
                  id="token-cap"
                  name="monthlyCapUsd"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="Unlimited (account caps apply)"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="token-expiry">Expires In (Days)</Label>
                <Input
                  id="token-expiry"
                  name="expiresInDays"
                  type="number"
                  min="1"
                  max="3650"
                  placeholder="Never expires"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4 text-sm">
              <span className="text-xs font-medium text-muted-foreground">Scopes:</span>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" name="scopes" value="read" defaultChecked />
                <span>read</span>
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" name="scopes" value="upload" defaultChecked />
                <span>upload</span>
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" name="scopes" value="generate" defaultChecked />
                <span>generate</span>
              </label>
            </div>

            <div>
              <PendingButton type="submit" size="sm" pending={creating}>
                Create token
              </PendingButton>
            </div>
          </form>

          {newlyCreatedToken ? (
            <div className="mt-4 rounded-md border border-border bg-muted/40 p-4">
              <p className="text-xs font-medium text-foreground">
                Copy your personal API token now — it will never be shown again:
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code className="rounded bg-background px-2 py-1 font-mono text-xs text-foreground">
                  {newlyCreatedToken}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    await navigator.clipboard.writeText(newlyCreatedToken);
                    setCopied(true);
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
          ) : null}

          {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your API Tokens</CardTitle>
        </CardHeader>
        <CardContent>
          {tokens.length === 0 ? (
            <p className="text-sm text-muted-foreground">No personal API tokens created yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Prefix</TableHead>
                  <TableHead>Scopes</TableHead>
                  <TableHead numeric>Monthly Cap</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last Used</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.map((t) => {
                  const isRevoked = t.revoked_at !== null;
                  const isExpired =
                    !isRevoked &&
                    t.expires_at !== null &&
                    nowMs !== null &&
                    new Date(t.expires_at).getTime() <= nowMs;
                  return (
                    <TableRow key={t.id}>
                      <TableCell className="font-medium text-foreground">{t.name}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {t.token_prefix}…
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {t.scopes.join(", ")}
                      </TableCell>
                      <TableCell numeric className="text-muted-foreground">
                        {t.monthly_cap_usd !== null ? formatUsd(t.monthly_cap_usd) : "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {isRevoked ? (
                          <span className="text-destructive">Revoked</span>
                        ) : isExpired ? (
                          <span className="text-muted-foreground">Expired</span>
                        ) : (
                          <span className="text-foreground">Active</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {t.last_used_at ? new Date(t.last_used_at).toLocaleString() : "Never"}
                      </TableCell>
                      <TableCell className="text-right">
                        {!isRevoked ? (
                          <PendingButton
                            type="button"
                            variant="outline"
                            size="sm"
                            pending={revokingId === t.id}
                            onClick={() => handleRevoke(t.id)}
                          >
                            Revoke
                          </PendingButton>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
