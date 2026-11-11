import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeSpanMappings, spanKind, toSpanMappings, utf8Offsets } from "../src/spans.ts";
import { SpanMapKind } from "../src/protocol.ts";

const pair = (sourcePos: number, destPos: number) => ({ sourcePos, destPos });

describe("toSpanMappings", () => {
  it("pairs start/end MapPairs into spans and picks a kind for each", () => {
    const original = "<fullName>Foo</fullName><label>My Foo</label>";
    const virtual = `declare module "@salesforce/x/Foo" { const Foo: string; const hasFoo: boolean; }`;
    const spans = toSpanMappings([pair(10, 15), pair(13, 34), pair(10, 43), pair(13, 46), pair(31, 62), pair(37, 68)], virtual, original);
    assert.deepEqual(spans, [
      [15, 19, 10, 3, SpanMapKind.Alias],
      [43, 3, 10, 3, SpanMapKind.Verbatim],
      [62, 6, 31, 6, SpanMapKind.Atom],
    ]);
  });

  it("drops inverted and out-of-bounds spans", () => {
    // sf2ts StaticResource maps to <description>; without one, indexOf(-1) yields start 12, end -1.
    const original = "<StaticResource></StaticResource>";
    const virtual = `declare module "@salesforce/resourceUrl/r" {}`;
    assert.deepEqual(toSpanMappings([pair(12, 15), pair(-1, 42)], virtual, original), []);
    assert.deepEqual(toSpanMappings([pair(0, 0), pair(5, 999)], virtual, original), []);
    assert.deepEqual(toSpanMappings([pair(0, 0), pair(999, 5)], virtual, original), []);
  });

  it("drops empty spans and an unpaired trailing entry", () => {
    assert.deepEqual(toSpanMappings([pair(3, 1), pair(3, 1), pair(0, 0)], "abcdef", "abcdef"), []);
  });

  it("keeps the features a span takes part in, when it doesn't take part in all of them", () => {
    const spans = toSpanMappings([{ ...pair(0, 0), features: 8 }, pair(2, 2), pair(2, 2), pair(4, 4)], "abcdef", "abcdef");
    assert.deepEqual(spans, [
      [0, 2, 0, 2, SpanMapKind.Verbatim, 8],
      [2, 2, 2, 2, SpanMapKind.Verbatim],
    ]);
  });

  it("drops spans overlapping earlier ones in the virtual text", () => {
    const spans = toSpanMappings([pair(0, 0), pair(2, 4), pair(4, 2), pair(6, 6)], "abcdefgh", "abcdefgh");
    assert.deepEqual(spans, [[0, 4, 0, 2, SpanMapKind.Alias]]);
  });

  it("keeps shared original ranges but drops partial original overlaps", () => {
    const spans = toSpanMappings([pair(0, 0), pair(4, 2), pair(0, 3), pair(4, 5), pair(2, 6), pair(6, 8)], "abcdefghij", "abcdefghij");
    assert.deepEqual(spans, [
      [0, 2, 0, 4, SpanMapKind.Atom],
      [3, 2, 0, 4, SpanMapKind.Atom],
    ]);
  });
});

describe("spanKind", () => {
  it("uses Verbatim for identical text", () => {
    assert.equal(spanKind("File1", "File1"), SpanMapKind.Verbatim);
  });

  it("uses Alias for names built from an API name", () => {
    for (const [virtual, original] of [
      ["lblAustralia", "Australia"],
      [`"@salesforce/label/c.Australia"`, "Australia"],
      [`"@salesforce/apex/File1.getFile1Data"`, "getFile1Data"],
      ["Apex.Widget", "Widget"],
      ["string", "String"],
    ]) {
      assert.equal(spanKind(virtual!, original!), SpanMapKind.Alias, virtual);
    }
  });

  it("uses Atom for labels, descriptions and type expressions", () => {
    for (const [virtual, original] of [
      ["hasTestPerm", "Can do cool stuff!"],
      [`"@salesforce/resourceUrl/bolt"`, "Sample image of a Lightning Bolt"],
      ["Test_Object__c", "Test Object"],
      ["Apex.Account[]", "List<Account>"],
      ["number", "Integer"],
    ]) {
      assert.equal(spanKind(virtual!, original!), SpanMapKind.Atom, virtual);
    }
  });
});

describe("encodeSpanMappings", () => {
  it("returns UTF-16 spans unchanged", () => {
    const spans = toSpanMappings([pair(0, 0), pair(1, 1)], "é", "é");
    assert.equal(encodeSpanMappings(spans, "é", "é", "utf-16"), spans);
  });

  it("converts to UTF-8 byte offsets", () => {
    const original = "é😀<x>";
    const virtual = "<x>";
    const spans = encodeSpanMappings([[0, 3, 3, 3, SpanMapKind.Verbatim]], virtual, original, "utf-8");
    assert.deepEqual(spans, [[0, 3, 6, 3, SpanMapKind.Verbatim]]);
  });
});

describe("utf8Offsets", () => {
  it("counts bytes for every UTF-16 offset", () => {
    const toUtf8 = utf8Offsets("aé€😀");
    assert.deepEqual([0, 1, 2, 3, 5].map(toUtf8), [0, 1, 3, 6, 10]);
  });
});
