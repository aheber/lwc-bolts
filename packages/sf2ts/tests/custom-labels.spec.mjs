/** @import { Component } from "../lib/index.mjs" */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { convert, MetadataType } from "../lib/index.mjs";

describe("Convert:CustomLabels", async () => {
  it("Generate declaration from custom labels", async () => {
    /** @type { Component } */
    const component = {
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
declare module "@salesforce/label/c.Australia" {
  /**
   * @description Australia
   */
  const lblAustralia = 'Australia';
  export default lblAustralia;
}
declare module "@salesforce/label/c.Austria" {
  /**
   * @description Austria
   */
  const lblAustria = 'Austria';
  export default lblAustria;
}
`
    );

    assert.deepEqual(convertedComp[0].mapData, [
      { sourcePos: 133, destPos: 15 },
      { sourcePos: 140, destPos: 44 },
      { sourcePos: 133, destPos: 105 },
      { sourcePos: 140, destPos: 115 },
      { sourcePos: 414, destPos: 179 },
      { sourcePos: 423, destPos: 210 },
      { sourcePos: 414, destPos: 261 },
      { sourcePos: 423, destPos: 273 },
      { sourcePos: 685, destPos: 337 },
      { sourcePos: 692, destPos: 366 },
      { sourcePos: 685, destPos: 415 },
      { sourcePos: 692, destPos: 425 },
    ]);
  });
});
