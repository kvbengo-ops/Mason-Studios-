import type { NextRequest } from "next/server";
import type { NextResponse } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function proxy(request: NextRequest): Promise<NextResponse> {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static, _next/image (Next.js internals)
     * - favicon.ico
     * - image/font/static asset file extensions
     * - api/health, api/issue-image (unauthenticated: Render's health poll
     *   and GitHub's image proxy have no session to refresh)
     *
     * Extension exclusion is scoped to a single path segment ([^/]+) on purpose:
     * this prevents application routes that end with something that looks like a
     * file extension (e.g. /projects/anything.js) from bypassing session refresh.
     * Static assets are served from the public/ directory (top-level), not nested routes.
     */
    "/((?!api/health|api/issue-image|_next/static|_next/image|favicon\\.ico|[^/]+\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|woff|woff2|ttf)$).*)",
  ],
};
