import { describe, expect, it } from "vitest";
import { csvField, csvRow, toCsv } from "@/lib/csv";

describe("csvField", () => {
  it("returns a plain field unchanged", () => {
    expect(csvField("cut to product")).toBe("cut to product");
  });

  it("treats an empty string as an empty, unquoted field", () => {
    expect(csvField("")).toBe("");
  });

  it("treats null the same as an empty field, not the literal text 'null'", () => {
    expect(csvField(null)).toBe("");
  });

  it("quotes a field containing a comma", () => {
    expect(csvField("wide shot, then close-up")).toBe('"wide shot, then close-up"');
  });

  it("quotes a field containing a newline", () => {
    expect(csvField("line one\nline two")).toBe('"line one\nline two"');
  });

  it("quotes a field containing a carriage return", () => {
    expect(csvField("line one\rline two")).toBe('"line one\rline two"');
  });

  it("quotes and doubles embedded double quotes", () => {
    expect(csvField('she said "hi"')).toBe('"she said ""hi"""');
  });

  // The case that ships broken and nobody notices: a single field carrying
  // a comma, a double quote, AND a newline all at once. A hand-rolled
  // `.join(",")` would silently fragment this into extra columns; the
  // pronunciation-guide and video-prompt fields are exactly the kind of
  // free text where all three can land in one cell together.
  it("handles a field with a comma, a double quote, and a newline together", () => {
    const value = 'Say "hi", then\ncut to product';
    expect(csvField(value)).toBe('"Say ""hi"", then\ncut to product"');
  });

  it.each(["=", "+", "-", "@"])(
    "prefixes a field starting with formula-trigger char %s with a defensive apostrophe",
    (trigger) => {
      expect(csvField(`${trigger}SUM(A1:A9)`)).toBe(`'${trigger}SUM(A1:A9)`);
    },
  );

  it("does not touch a formula-trigger char that isn't the first character", () => {
    expect(csvField("total = 5")).toBe("total = 5");
  });

  it("combines formula-injection neutralisation with RFC 4180 quoting when both apply", () => {
    // Leading "-" triggers the apostrophe prefix; the comma still forces
    // quoting around the (now apostrophe-prefixed) result.
    expect(csvField("-1, 2")).toBe('"\'-1, 2"');
  });

  it("does not add a defensive apostrophe to an empty field", () => {
    expect(csvField("")).toBe("");
  });
});

describe("csvRow", () => {
  it("joins escaped fields with commas", () => {
    expect(csvRow(["1", "plain", "has, a comma"])).toBe('1,plain,"has, a comma"');
  });

  it("passes null fields through as empty", () => {
    expect(csvRow(["a", null, "c"])).toBe("a,,c");
  });
});

describe("toCsv", () => {
  it("builds a header + rows document with CRLF line endings", () => {
    const csv = toCsv(
      ["Scene", "Script line"],
      [
        ["1", "Hello"],
        ["2", "World, and more"],
      ],
    );
    expect(csv).toBe('Scene,Script line\r\n1,Hello\r\n2,"World, and more"\r\n');
  });

  it("produces an empty-body document (header only) for zero rows", () => {
    expect(toCsv(["Scene"], [])).toBe("Scene\r\n");
  });
});
