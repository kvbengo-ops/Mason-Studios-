import { describe, expect, it, vi, beforeEach } from "vitest";
import { signedUrl } from "@/lib/storage";
import { GET } from "./route";

vi.mock("@/lib/storage", () => ({
  issueImageStorageKey: vi.fn((file: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/.test(file)
      ? `issue-reports/${file}`
      : null,
  ),
  signedUrl: vi.fn(),
}));

const mockedSignedUrl = vi.mocked(signedUrl);

function request(file: string): Promise<Response> {
  return GET({} as Request, { params: Promise.resolve({ file }) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/issue-image/[file]", () => {
  it("404s on a path-traversal attempt", async () => {
    const response = await request("../x.png");
    expect(response.status).toBe(404);
    expect(mockedSignedUrl).not.toHaveBeenCalled();
  });

  it("404s on a filename that isn't a uuid", async () => {
    const response = await request("abc.png");
    expect(response.status).toBe(404);
  });

  it("redirects to the signed URL for a valid filename", async () => {
    mockedSignedUrl.mockResolvedValue("https://storage.example/signed?token=abc");

    const response = await request("11111111-2222-3333-4444-555555555555.png");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://storage.example/signed?token=abc");
    expect(mockedSignedUrl).toHaveBeenCalledWith(
      "issue-reports/11111111-2222-3333-4444-555555555555.png",
      3600,
    );
  });

  it("404s when signedUrl throws", async () => {
    mockedSignedUrl.mockRejectedValue(new Error("object not found"));

    const response = await request("11111111-2222-3333-4444-555555555555.png");
    expect(response.status).toBe(404);
  });
});
