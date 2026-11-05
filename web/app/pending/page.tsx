import { redirect } from "next/navigation";
import type { JSX } from "react";
import { signOut } from "@/actions/auth";
import { createClient } from "@/lib/supabase/server";
import { canUseApp } from "@/lib/account-approval";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Where requireUser() (actions/guard.ts) sends an account an admin has not
// approved yet — see 0052_account_approval.sql.
//
// Deliberately OUTSIDE the (app) route group: that group's layout calls
// requireUser() itself, so a page inside it would be redirected here by the
// very guard that sent the user here, forever. It lives next to /login and
// /signup, the app's other two pre-approval pages, and is listed in
// lib/supabase/middleware.ts's PUBLIC_PATHS so the signed-out bounce leaves
// it alone.
//
// For the same reason it does NOT call requireUser() to find out who is
// asking — it reads the session and the one column it needs directly. The
// two redirects below are what keep it from becoming a page anyone can
// linger on: a signed-out visitor belongs at /login, and an account that
// may use the app belongs at /create (which matters both when an editor is
// approved and when an account is promoted to admin while this tab is open).
export default async function PendingPage(): Promise<JSX.Element> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Session client, not createAdminClient(): profiles_select_own
  // (0002_rls.sql) already lets any account read its own row, which is all
  // this page asks for, and 0052 deliberately left the SELECT policies
  // alone so a pending or rejected account can still read exactly this.
  const { data: profile } = await supabase
    .from("profiles")
    .select("role, status")
    .eq("id", user.id)
    .single();

  if (profile && canUseApp(profile)) {
    redirect("/create");
  }

  // A missing profile row means the 0004 bootstrap trigger did not run —
  // requireUser() throws on that, and this page has no better answer, but
  // it is also not the place to surface it: whoever arrived here cannot act
  // on it either way. Treat it like any other not-yet-usable account and
  // let the thrown AuthorizationError happen on the next guarded route.
  const rejected = profile?.status === "rejected";
  // Deactivated is its own case, not a rejection: this person worked here.
  // Telling them their application was refused would be both wrong and
  // insulting, and it would send them to the wrong conversation.
  const deactivated = profile?.status === "deactivated";

  return (
    <div className="flex min-h-svh w-full items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            {deactivated
              ? "Account deactivated"
              : rejected
                ? "Account not approved"
                : "Waiting for approval"}
          </CardTitle>
          <CardDescription>
            {deactivated
              ? "An admin has turned off access for this account."
              : rejected
                ? "An admin reviewed this account and did not approve it."
                : "Your account has been created but an admin has not approved it yet."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {deactivated
              ? "Your work is still here and nothing has been deleted. An admin can turn access back on from the Users page."
              : rejected
                ? "If you think that was a mistake, talk to an admin — they can approve it from the Users page."
                : "You will be able to sign in as soon as one of them approves it. Nothing else is needed from you."}
          </p>
        </CardContent>
        <CardFooter>
          {/* Sign-out has to happen here rather than in the guard that
              redirected here: clearing the session cookie is a write, and
              lib/supabase/server.ts's createClient can only make it stick
              from a Server Action (which this form's submission is) or a
              Route Handler — never from a Server Component. */}
          <ActionForm
            action={signOut}
            fallbackErrorMessage="Failed to sign out."
            className="w-full"
          >
            <SubmitButton variant="outline" className="w-full" pendingLabel="Signing out…">
              Sign out
            </SubmitButton>
          </ActionForm>
        </CardFooter>
      </Card>
    </div>
  );
}
