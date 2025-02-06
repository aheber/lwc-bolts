/** @import { Component } from "../lib/index.mjs" */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { convert, MetadataType } from "../lib/index.mjs";

describe("Convert:CustomObject", async () => {
  it("Transform Custom Object", async () => {
    /** @type { Component } */
    let component = {
      path: "objects/Test_Object__c.object-meta.xml",
      type: MetadataType.CustomObject,
      content: `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <deploymentStatus>Deployed</deploymentStatus>
    <description>Object representing test data</description>
    <label>Test Object</label>
    <nameField>
        <label>Test Object Id</label>
        <type>Text</type>
    </nameField>
    <pluralLabel>Test Objects</pluralLabel>
</CustomObject>
`,
    };
    let convertedComp = convert([component]);
    assert.equal(
      convertedComp[0].declarationContent,
      `declare module "@salesforce/schema/Test_Object__c" {
  /**
   * @description Object representing test data
   */
  const Test_Object__c: {
      objectApiName: 'Test_Object__c';
  }
  export default Test_Object__c;
}`
    );

    assert.deepEqual(convertedComp[0].mapData, [
      { sourcePos: 224, destPos: 15 },
      { sourcePos: 235, destPos: 50 },
      { sourcePos: 224, destPos: 121 },
      { sourcePos: 235, destPos: 135 },
    ]);
  });
});
