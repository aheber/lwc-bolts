import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MetadataType, type Component } from "../src/index.ts";
import { convertOne, mappedText, typeCheck } from "./helpers.ts";

describe("Convert:CustomLabel", async () => {
  it("Generate declaration from custom label", async (t) => {
    const component: Component = {
      path: "Account.label-meta.xml",
      type: MetadataType.CustomLabel,
      content: `<?xml version="1.0" encoding="UTF-8"?>
<CustomLabel>
    <fullName>Account</fullName>
    <categories>CategoryOne</categories>
    <language>en_US</language>
    <protected>false</protected>
    <shortDescription>Account Description</shortDescription>
    <value>Label Value</value>
</CustomLabel>
`,
    };
    const convertedComp = await convertOne(component);
    t.assert.snapshot(convertedComp.text);
    assert.deepEqual(mappedText(convertedComp), [
      ['"@salesforce/label/c.Account"', "Account"],
      ["lblAccount", "Account"],
    ]);
  });

  it("Types a label as any string, since it's translated, and documents its default value", async () => {
    const converted = await convertOne({
      path: "labels/Tricky.label-meta.xml",
      type: MetadataType.CustomLabel,
      content: `<?xml version="1.0" encoding="UTF-8"?>
<CustomLabel xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Tricky</fullName>
    <value>Don't */ close
on a new line</value>
</CustomLabel>
`,
    });
    assert.match(converted.text, /   \* "Don't \*\\\/ close\n   \* on a new line"\n/);
    assert.deepEqual(
      typeCheck(
        [converted.text],
        `import l from "@salesforce/label/c.Tricky";
const text: string = l;
// @ts-expect-error a translation can be any text
const exact: "on a new line" = l;
export { text, exact };`,
      ),
      [],
    );
  });

  it("Omits a missing description", async (t) => {
    const withoutDescription = await convertOne({
      path: "labels/NoDesc.label-meta.xml",
      type: MetadataType.CustomLabel,
      content: `<CustomLabel xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>NoDesc</fullName><value>x</value></CustomLabel>`,
    });
    t.assert.snapshot(withoutDescription.text);
  });

  it("Fails a label without a name, which can't be imported", async () => {
    const converted = await convertOne({
      path: "labels/Nameless.label-meta.xml",
      type: MetadataType.CustomLabel,
      content: `<CustomLabel xmlns="http://soap.sforce.com/2006/04/metadata"><value>x</value></CustomLabel>`,
    });
    assert.equal(converted.text, "");
    assert.deepEqual(
      converted.diagnostics?.map((d) => d.message),
      ["Unable to convert CustomLabel to TypeScript: the label has no <fullName>"],
    );
  });
});
