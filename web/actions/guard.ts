import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canUseApp } from "@/lib/account-approval";
import { deriveProjectStatus, deriveReachedSteps, type ReachedSteps } from "@/lib/project-status";
import type { Database } from "@/types/db";

type Profile = Database["public"]["Tables"]["profiles"]["Row"];
type Project = Database["public"]["Tables"]["projects"]["Row"];
type Scene = Database["public"]["Tables"]["scenes"]["Row"];
type User = { id: string; email: string | undefined };

/**
 * Thrown when a caller is signed in but not authorized to act on a
 * resource, so a missed check fails loudly instead of silently returning
 * null/undefined and letting a write through.
 */
export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

/**
 * Every one of these guards MUST run — and pass — before any
 * `createAdminClient()` call in a Server Action. The admin client bypasses
 * RLS entirely, so these functions are the only thing standing between a
 * request and cross-user access once that client is in play.
 */

/**
 * Requires a signed-in user who may use the app, with a profile row. Admins
 * are trusted by role; editor and trusted-editor accounts must first be
 * approved. Redirects
 * to /login if there is no session (this is the expected, non-exceptional
 * path for a page load); throws AuthorizationError if a session exists but
 * the profile row is missing, since that indicates the 0004
 * profile-bootstrap trigger did not run and should not be silently
 * swallowed.
 *
 * The approval check (0052_account_approval.sql) lives HERE, and only here,
 * for two reasons.
 *
 * It is the only chokepoint all three session-creating paths pass through.
 * `signIn` is not: a self-serve signup never calls it, because signUp
 * returns a live session directly whenever enable_confirmations is off
 * (supabase/config.toml), and /auth/callback mints one from a confirmation
 * link if that setting is ever turned back on. Guarding signIn alone would
 * gate the one path a new account is least likely to take first. Everything
 * downstream — every page under (app), every Server Action, requireAdmin,
 * requireProject, requireScene — already goes through this function, and it
 * has already fetched the profile row by the time the check runs, so the
 * check costs nothing extra.
 *
 * It redirects to /pending rather than /login, and does not sign the user
 * out, because neither alternative works from here:
 *   - lib/supabase/middleware.ts bounces an authenticated request off
 *     /login to /projects, so redirecting there would ping-pong forever.
 *   - lib/supabase/server.ts's createClient swallows cookie writes when it
 *     is called from a Server Component (it has to — Next forbids them), so
 *     a signOut() on this path would appear to succeed and leave the
 *     session cookie exactly where it was. /pending carries a sign-out
 *     button instead, where the write happens in a Server Action and lands.
 */
export async function requireUser(): Promise<{ user: User; profile: Profile }> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (error || !profile) {
    throw new AuthorizationError(
      `No profile found for authenticated user ${user.id}. The profiles-bootstrap trigger (0004_profile_trigger.sql) may not have run.`,
    );
  }

  if (!canUseApp(profile)) {
    redirect("/pending");
  }

  return { user: { id: user.id, email: user.email }, profile };
}

/**
 * Requires the current user to be the owner of the given project.
 *
 * Admins do NOT pass this check. Per 0002_rls.sql, admins have read-only
 * access to every project via RLS `is_admin()` clauses, but every write
 * policy on every table is owner-only (`user_id = auth.uid()`) with no
 * admin bypass. Mirroring that here means an admin session can never
 * reach a `createAdminClient()` write through this guard — an admin who
 * hits either branch below is refused exactly like a stranger, via the
 * same notFound(), not a distinct "you're an admin, this isn't yours"
 * message: telling an admin the row exists (just isn't theirs) would be
 * more information than a non-owner is told, and RLS already can't tell
 * the two cases apart on the read side (see below).
 *
 * Both the row-missing and the not-owner branches call notFound() instead
 * of throwing. Before this, both threw AuthorizationError, which nothing
 * caught, so opening someone else's project (or a deleted/mistyped one)
 * rendered Next's default unstyled 500 page. notFound() is Next's
 * control-flow signal, not a failure — the nearest not-found.tsx renders
 * instead (app/(app)/not-found.tsx for any route under this layout, which
 * every requireProject call site is). This does not weaken the check:
 * ownership is still verified server-side before any admin-client write is
 * reachable, and a non-owner still cannot obtain `project` — the function
 * still never returns for them, it just fails via notFound() rather than a
 * throw that happened to go uncaught.
 */
/**
 * Shared body for requireProject/requireProjectReadable: runs the one query
 * both need (project row + embedded scene statuses, so `project.status`
 * matches lib/project-status.ts's deriveProjectStatus rather than the raw
 * column — see that file for why the column itself can't just be trusted
 * directly) and derives `reached` from it. Factored out so the strict and
 * permissive guards can never drift on how status/reached are computed —
 * only on who is allowed to receive the result, which each caller decides
 * for itself afterward.
 *
 * Does NOT check ownership — that's each caller's job, since requireProject
 * and requireProjectReadable disagree about it. Row-missing is the one
 * outcome both guards treat identically, so it's handled once, here: it
 * covers both "no project has this id" and "RLS's projects_select filtered
 * it out because some other user owns it and the caller isn't an admin" —
 * 0002_rls.sql filters rather than refuses, so a query for someone else's
 * project comes back looking identical to a query for a deleted one.
 * notFound() is the honest response to that: it renders the same "may have
 * been deleted, or you may not have access" copy either way, rather than
 * fabricating a distinction the query result doesn't contain.
 */
async function fetchProjectForCaller(
  projectId: string,
): Promise<{ project: Project; reached: ReachedSteps; ownerId: string }> {
  const supabase = await createClient();

  const { data: row, error } = await supabase
    .from("projects")
    .select("*, scenes ( status, ref_frame_asset_id )")
    .eq("id", projectId)
    .single();

  if (error || !row) {
    notFound();
  }

  const { scenes, ...projectRow } = row as unknown as Project & {
    scenes: {
      status: Database["public"]["Tables"]["scenes"]["Row"]["status"];
      ref_frame_asset_id: string | null;
    }[];
  };

  const project: Project = {
    ...projectRow,
    status: deriveProjectStatus(projectRow.status, scenes),
  };

  // Which steps the project has EVER reached — a different question from
  // project.status above once status can legitimately move backwards (a
  // reopened scene, or a scene added after rendering already started). See
  // lib/project-status.ts's deriveReachedSteps doc comment for the
  // regression this closes.
  const reached = deriveReachedSteps(projectRow.status, scenes);

  return { project, reached, ownerId: projectRow.user_id };
}

export async function requireProject(
  projectId: string,
): Promise<{ user: User; profile: Profile; project: Project; reached: ReachedSteps }> {
  const { user, profile } = await requireUser();
  const { project, reached, ownerId } = await fetchProjectForCaller(projectId);

  // Reachable only for an admin: RLS already filtered out a stranger's
  // project inside fetchProjectForCaller (they never get a row back at
  // all), so the only way to get a row here whose owner isn't the caller is
  // admin's read-only `is_admin()` SELECT policy. Same notFound() as a
  // missing row — deliberately not a different message — so an admin
  // poking at another user's project id learns nothing beyond "you can't
  // get this," same as anyone else. This is the entire security boundary:
  // no caller of requireProject, admin or not, ever receives a project they
  // don't own.
  if (ownerId !== user.id) {
    notFound();
  }

  return { user, profile, project, reached };
}

/**
 * READ-ONLY entry point for pages under /projects/[id]/*. Same query and
 * same derived status/reached as requireProject (via fetchProjectForCaller,
 * above) — the two can never drift on how a project's shape is computed,
 * only on who is let through.
 *
 * Unlike requireProject, an admin viewing a project they don't own is let
 * through here rather than refused — `isOwner: false` — because
 * 0002_rls.sql's projects_select policy already grants admins read access
 * to every project, and /projects lists every user's project as a clickable
 * link on that basis. requireProject's blanket refusal was the app
 * advertising a door the database had already unlocked; this function is
 * that door, opened only as far as RLS already opens it.
 *
 * requireProject stays completely unmodified and is still what every write
 * path (every `actions/*.ts` Server Action) calls — this function must
 * NEVER be used where a write follows. That split is deliberate and
 * fail-safe by construction: a new Server Action that reaches for
 * `requireProject` out of habit — the name every other action in this
 * codebase already calls — gets owner-only enforcement for free, with
 * nothing extra to remember. Only a page doing a plain read has any reason
 * to reach for the differently-named, more-permissive
 * `requireProjectReadable` instead, and picking the permissive one by
 * accident requires noticing its name is different and choosing it anyway.
 * If you are about to call this from something that mutates data, use
 * requireProject instead.
 */
export async function requireProjectReadable(projectId: string): Promise<{
  user: User;
  profile: Profile;
  project: Project;
  reached: ReachedSteps;
  isOwner: boolean;
}> {
  const { user, profile } = await requireUser();
  const { project, reached, ownerId } = await fetchProjectForCaller(projectId);

  const isOwner = ownerId === user.id;

  // Belt-and-suspenders alongside RLS: a non-admin non-owner should never
  // get a row back from fetchProjectForCaller at all (RLS's projects_select
  // already filtered it out), so this branch should be unreachable in
  // practice. It stays as an explicit check anyway rather than relying
  // solely on that: the cost of asserting it here is one field lookup, and
  // the alternative — trusting RLS silently and finding out later it didn't
  // filter what this assumed it did — is exactly the class of bug this
  // whole guard file exists to make impossible to miss.
  if (!isOwner && !isAdmin(profile)) {
    notFound();
  }

  return { user, profile, project, reached, isOwner };
}

/**
 * Requires the current user to own the project that the given scene
 * belongs to. Same admin-excluded semantics as requireProject.
 */
export async function requireScene(
  sceneId: string,
): Promise<{ user: User; profile: Profile; project: Project; scene: Scene }> {
  const supabase = await createClient();

  const { data: scene, error } = await supabase
    .from("scenes")
    .select("*")
    .eq("id", sceneId)
    .single();

  if (error || !scene) {
    throw new AuthorizationError(`Scene ${sceneId} not found.`);
  }

  const { user, profile, project } = await requireProject(scene.project_id);

  return { user, profile, project, scene };
}

/** True when the given profile has the 'admin' role. Read-only everywhere — see requireProject/requireScene. */
export function isAdmin(profile: Profile): boolean {
  return profile.role === "admin";
}

/**
 * Requires the current user to have the 'admin' role — the boundary behind
 * every Character Library write (web/actions/character-library.ts) and the
 * /library page, same treatment /spend already gives its own admin-only
 * read. Throws AuthorizationError rather than returning an ActionResult:
 * every admin-only control in the UI is already hidden from a non-admin
 * (see character/page.tsx's editor-restricted Character card), so reaching
 * this at all means the UI was bypassed, not that an operator hit an
 * ordinary, expected refusal the way a locked project is.
 */
export async function requireAdmin(): Promise<{ user: User; profile: Profile }> {
  const { user, profile } = await requireUser();
  if (!isAdmin(profile)) {
    throw new AuthorizationError(`User ${user.id} is not an admin.`);
  }
  return { user, profile };
}

/**
 * True when the given profile may decide SOMEBODY's allowance request — an
 * admin, or a trusted editor (docs/credit-display-plan.md § P6). The
 * application-level twin of 0074_peer_allowance_approval.sql's
 * `can_approve_allowance()`, exactly as isAdmin() is of `is_admin()`.
 *
 * Deliberately a DIFFERENT question from isAdmin(), and the two must never
 * be merged. Approval authority is the only privilege a trusted editor
 * gains here; isAdmin() also gates the Character Library, /users, /spend
 * and every cross-account read in 0002_rls.sql, so widening that instead
 * would hand all of it over as a side effect nobody decided to grant.
 */
export function isApprover(profile: Profile): boolean {
  return profile.role === "admin" || profile.role === "trusted_editor";
}

/**
 * requireAdmin's wider twin, for the one workflow trusted editors now share
 * with admins: deciding another editor's allowance request. Throws
 * AuthorizationError for the same reason requireAdmin does — every decide
 * control is hidden from a non-approver, so reaching this means the UI was
 * bypassed, not that an operator hit an ordinary, expected refusal.
 *
 * Passing this is NOT permission to decide a PARTICULAR request. It answers
 * only "may this account decide anything at all". Whether this approver may
 * decide THIS request — not their own, not one above their ceiling — is
 * lib/allowance.ts's decisionBlockReason, and every caller of this guard on
 * a decision path must ask it too. The split is deliberate: this question
 * has one answer per account and belongs with the other role guards; that
 * one has an answer per (approver, request) pair and is a pure function
 * three different callers (this action, the page, the dialog) need to agree
 * on.
 */
export async function requireApprover(): Promise<{ user: User; profile: Profile }> {
  const { user, profile } = await requireUser();
  if (!isApprover(profile)) {
    throw new AuthorizationError(`User ${user.id} is not an allowance approver.`);
  }
  return { user, profile };
}
