/** @import { Component } from "../lib/index.mjs" */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { convert, MetadataType } from "../lib/index.mjs";

describe("Convert:CustomLabel", async () => {
  it("Generate declaration from custom label", async () => {
    /** @type { Component } */
    const component = {
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
    let convertedComp = convert([component]);
    assert.equal(
      convertedComp[0].declarationContent,
      `declare module "@salesforce/label/c.Account" {
  /**
   * @description Account Description
   */
  const lblAccount = 'Label Value';
  export default lblAccount;
}
`
    );

    assert.deepEqual(convertedComp[0].mapData, [
      { sourcePos: 67, destPos: 15 },
      { sourcePos: 74, destPos: 44 },
      { sourcePos: 67, destPos: 105 },
      { sourcePos: 74, destPos: 115 },
    ]);
  });
});
