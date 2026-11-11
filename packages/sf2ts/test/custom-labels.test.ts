import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MetadataType, type Component } from "../src/index.ts";
import { convertOne, mappedText, typeCheck } from "./helpers.ts";

describe("Convert:CustomLabels", async () => {
  it("Generate declaration from custom labels", async (t) => {
    const component: Component = {
      path: "CustomLabels.labels-meta.xml",
      type: MetadataType.CustomLabels,
      content: `<?xml version="1.0" encoding="UTF-8"?>
<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">
    <labels>
        <fullName>Account</fullName>
        <categories>CategoryOne</categories>
        <language>en_US</language>
        <protected>false</protected>
        <shortDescription>Account Description</shortDescription>
        <value>Label Value</value>
    </labels>
    <labels>
        <fullName>Australia</fullName>
        <categories>CategoryOne</categories>
        <language>en_US</language>
        <protected>false</protected>
        <shortDescription>Australia</shortDescription>
        <value>Australia</value>
    </labels>
    <labels>
        <fullName>Austria</fullName>
        <categories>CategoryTwo</categories>
        <language>en_US</language>
        <protected>false</protected>
        <shortDescription>Austria</shortDescription>
        <value>Austria</value>
    </labels>
</CustomLabels>
`,
    };
    const convertedComp = await convertOne(component);
    t.assert.snapshot(convertedComp.text);

    assert.deepEqual(mappedText(convertedComp), [
      ['"@salesforce/label/c.Account"', "Account"],
      ["lblAccount", "Account"],
      ['"@salesforce/label/c.Australia"', "Australia"],
      ["lblAustralia", "Australia"],
      ['"@salesforce/label/c.Austria"', "Austria"],
      ["lblAustria", "Austria"],
    ]);
  });

  it("Maps labels whose names prefix other labels to their own element", async () => {
    const converted = await convertOne({
      path: "labels/CustomLabels.labels-meta.xml",
      type: MetadataType.CustomLabels,
      content: `<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata"><labels><fullName>Account</fullName><value>a</value></labels><labels><fullName>Acc</fullName><value>b</value></labels></CustomLabels>`,
    });
    const accStart = converted.content.indexOf("<fullName>Acc</fullName>") + "<fullName>".length;
    assert.deepEqual(
      converted.mapData.slice(4).map((m) => m.sourcePos),
      [accStart, accStart + 3, accStart, accStart + 3],
    );
    assert.deepEqual(mappedText(converted).slice(2), [
      [`"@salesforce/label/c.Acc"`, "Acc"],
      ["lblAcc", "Acc"],
    ]);
  });

  it("Maps each of two labels with the same name to its own element", async () => {
    const content = `<CustomLabels><labels><fullName>Same</fullName><value>a</value></labels><labels><fullName>Same</fullName><value>b</value></labels></CustomLabels>`;
    const converted = await convertOne({ path: "labels/CustomLabels.labels-meta.xml", type: MetadataType.CustomLabels, content });
    const first = content.indexOf("<fullName>Same</fullName>") + "<fullName>".length;
    const second = content.indexOf("<fullName>Same</fullName>", first) + "<fullName>".length;
    assert.deepEqual(
      converted.mapData.map((m) => m.sourcePos),
      [first, first + 4, first, first + 4, second, second + 4, second, second + 4],
    );
  });

  it("searches the file once for all its labels, not once for each", async () => {
    const count = 4000;
    const content = `<CustomLabels>${Array.from({ length: count }, (_, i) => `<labels><fullName>Label_${i}</fullName><value>Value ${i}</value></labels>`).join("\n")}</CustomLabels>`;
    // how much of the file indexOf reads: from where each search starts to the end of what it finds
    const indexOf = String.prototype.indexOf;
    let searched = 0;
    String.prototype.indexOf = function (this: string, search: string, position?: number) {
      const found = indexOf.call(this, search, position);
      if (this.length === content.length && this === content) {
        searched += (found === -1 ? content.length : found + search.length) - Math.max(0, position ?? 0);
      }
      return found;
    };
    let converted;
    try {
      converted = await convertOne({ path: "labels/CustomLabels.labels-meta.xml", type: MetadataType.CustomLabels, content });
    } finally {
      String.prototype.indexOf = indexOf;
    }
    assert.equal(mappedText(converted).length, count * 2);
    // a search from the start for each label reads about count / 2 times the file
    assert.ok(searched < content.length * 3, `searched ${(searched / content.length).toFixed(1)} times the file`);
  });

  it("Converts a file without labels to an empty declaration", async () => {
    const converted = await convertOne({
      path: "labels/CustomLabels.labels-meta.xml",
      type: MetadataType.CustomLabels,
      content: `<?xml version="1.0" encoding="UTF-8"?><CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata"></CustomLabels>`,
    });
    assert.equal(converted.text, "");
    assert.deepEqual(converted.mapData, []);
  });

  it("Skips a label without a name, such as one being written, and declares the others", async () => {
    const converted = await convertOne({
      path: "labels/CustomLabels.labels-meta.xml",
      type: MetadataType.CustomLabels,
      content: `<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata"><labels><value>new</value></labels><labels><fullName>Kept</fullName><value>x</value></labels></CustomLabels>`,
    });
    assert.equal(converted.diagnostics, undefined);
    assert.deepEqual(
      [...converted.text.matchAll(/^declare module "(.*)"/gm)].map((m) => m[1]),
      ["@salesforce/label/c.Kept"],
    );
    assert.deepEqual(mappedText(converted)[0], ['"@salesforce/label/c.Kept"', "Kept"]);
  });
});
