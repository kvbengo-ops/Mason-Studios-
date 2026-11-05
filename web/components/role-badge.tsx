import type { JSX } from "react";
import { Badge } from "@/components/ui/badge";
import type { ProfileRole } from "@/types/db";

// Three values now (0031_account_allowances.sql added 'trusted_editor'),
// two of them consequential in different ways: `admin` grants read access
// to every project of every user (0002_rls.sql's projects_select policy),
// so it should read as a fact worth noticing on a scanned list, not just
// another lowercase word next to "editor". `trusted_editor` is a SPEND
// tier only — is_admin() (0002_rls.sql) treats it exactly like 'editor',
// see 0031's header for the full audit — so it earns its own label (an
// admin scanning /users needs to tell who has the higher allowance) but
// not the same visual weight as `admin`; it reuses the quiet `outline`
// variant `editor` already has rather than borrowing admin's solid one,
// which would misrepresent it as a visibility escalation it isn't.
const ROLE_VARIANT: Record<ProfileRole, "default" | "outline"> = {
  admin: "default",
  trusted_editor: "outline",
  editor: "outline",
};

const ROLE_LABEL: Record<ProfileRole, string> = {
  admin: "Admin",
  trusted_editor: "Trusted editor",
  editor: "Editor",
};

export function RoleBadge({ role }: { role: ProfileRole }): JSX.Element {
  return <Badge variant={ROLE_VARIANT[role]}>{ROLE_LABEL[role]}</Badge>;
}
