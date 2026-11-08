import { NextResponse } from "next/server";

export function apiError(
  error: string,
  code: string,
  status: number,
  headers?: HeadersInit,
): NextResponse {
  return NextResponse.json({ error, code }, { status, headers });
}

export async function readJsonObject(
  request: Request,
): Promise<
  { value: Record<string, unknown>; response?: never } | { response: NextResponse; value?: never }
> {
  try {
    const value: unknown = await request.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { response: apiError("Request body must be a JSON object.", "invalid_body", 400) };
    }
    return { value: value as Record<string, unknown> };
  } catch {
    return { response: apiError("Request body must be valid JSON.", "invalid_json", 400) };
  }
}
