import { NextResponse } from "next/server";
import { requireApiToken } from "@/lib/api-auth";
import { apiClipQuote, parseApiClipInput, prepareApiClip, teamModelRefusal } from "@/lib/api-clip";
import { apiError, readJsonObject } from "@/lib/api-v1";
import { createAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const auth = await requireApiToken(request, "read");
  if (!auth.ok) return auth.response;

  const parsedBody = await readJsonObject(request);
  if (parsedBody.response) return parsedBody.response;
  const parsedInput = parseApiClipInput(parsedBody.value);
  if ("ok" in parsedInput) {
    return apiError(parsedInput.error, parsedInput.code, parsedInput.status);
  }
  const teamRefusal = teamModelRefusal(auth.profile.team, parsedInput.modelId);
  if (teamRefusal) return apiError(teamRefusal.error, teamRefusal.code, teamRefusal.status);

  try {
    const prepared = await prepareApiClip(createAdminClient(), auth.userId, parsedInput);
    if (!prepared.ok) return apiError(prepared.error, prepared.code, prepared.status);
    return NextResponse.json({
      quote: apiClipQuote(prepared),
      provider_reference_prompt: prepared.references.providerReferencePrompt,
      references: [
        ...prepared.references.orderedReferences.images,
        ...prepared.references.orderedReferences.videos,
        ...prepared.references.orderedReferences.audios,
      ].map(({ elementId, refKind, ordinal, name }) => ({
        element_id: elementId,
        kind: refKind,
        ordinal,
        tag: name,
      })),
    });
  } catch (error) {
    console.error("POST /api/v1/quote failed", error);
    return apiError("Could not quote this clip.", "quote_failed", 500);
  }
}
