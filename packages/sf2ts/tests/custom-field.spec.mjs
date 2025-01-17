/** @import { Component } from "../lib/index.mjs" */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { convert, MetadataType } from "../lib/index.mjs";

describe("Convert:CustomField", async () => {
  it("Transform Custom Field", async () => {
    /** @type { Component } */
    const component = {
      path: "objects/Test_Object__c/fields/Test_Checkbox__c.field-meta.xml",
      type: MetadataType.CustomField,
      content: `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Test_Checkbox__c</fullName>
    <defaultValue>false</defaultValue>
    <description>Test field of type checkbox</description>
    <externalId>false</externalId>
    <inlineHelpText>Test it helptest</inlineHelpText>
    <label>Test Checkbox</label>
    <trackTrending>false</trackTrending>
    <type>Checkbox</type>
</CustomField>
`,
    };
    let convertedComp = convert([component]);
    assert.equal(
      convertedComp[0].declarationContent,
      `declare module '@salesforce/schema/Test_Object__c.Test_Checkbox__c' {
  /**
   * @description Test it helptest
   * @description Test field of type checkbox
   */
  const Test_Checkbox__c: {
    fieldApiName: 'Test_Checkbox__c';
    objectApiName: 'Test_Object__c';
  }
  export default Test_Checkbox__c;
}`
    );
  });
});
