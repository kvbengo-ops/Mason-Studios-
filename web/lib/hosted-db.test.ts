import { describe, expect, it } from "vitest";
import { isDevAgainstHostedDb, supabaseProjectRef } from "./hosted-db";

describe("isDevAgainstHostedDb", () => {
  const hosted = "https://wyaxxmwmhayanlviovsg.supabase.co";

  it("warns for a dev build against a hosted database", () => {
    // The actual configuration this exists for: web/.env's SUPABASE_URL is
    // the same project the deployed app uses.
    expect(isDevAgainstHostedDb("development", hosted)).toBe(true);
  });

  it("stays silent in a production build", () => {
    // The deployed app is SUPPOSED to talk to the hosted database. A banner
    // there would be on every page for every user, forever.
    expect(isDevAgainstHostedDb("production", hosted)).toBe(false);
  });

  it("stays silent for a local supabase", () => {
    expect(isDevAgainstHostedDb("development", "http://localhost:54321")).toBe(false);
    expect(isDevAgainstHostedDb("development", "http://127.0.0.1:54321")).toBe(false);
  });

  it("stays silent rather than firing on a missing or broken URL", () => {
    // A banner that fires on a misconfigured environment teaches the
    // operator to ignore it, and this one is only useful if it is never
    // noise.
    expect(isDevAgainstHostedDb("development", undefined)).toBe(false);
    expect(isDevAgainstHostedDb("development", "")).toBe(false);
    expect(isDevAgainstHostedDb("development", "not a url")).toBe(false);
  });

  it("warns in test builds too, not only development", () => {
    // NODE_ENV is a three-value field, and only one of them is safe.
    expect(isDevAgainstHostedDb("test", hosted)).toBe(true);
    expect(isDevAgainstHostedDb(undefined, hosted)).toBe(true);
  });
});

describe("supabaseProjectRef", () => {
  it("names which hosted database, not merely that it is hosted", () => {
    expect(supabaseProjectRef("https://wyaxxmwmhayanlviovsg.supabase.co")).toBe(
      "wyaxxmwmhayanlviovsg",
    );
  });

  it("returns null for a local one", () => {
    expect(supabaseProjectRef("http://localhost:54321")).toBeNull();
  });

  it("returns null rather than throwing on a broken URL", () => {
    expect(supabaseProjectRef("not a url")).toBeNull();
    expect(supabaseProjectRef(undefined)).toBeNull();
  });
});
