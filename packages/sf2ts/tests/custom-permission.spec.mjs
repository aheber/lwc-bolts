/** @import { Component } from "../lib/index.mjs" */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { convert, MetadataType } from "../lib/index.mjs";

describe("Convert:CustomPermission", async () => {
  it("Transform Custom Permission", async () => {
    /** @type { Component } */
    let component = {
      path: "customPermissions/TestPerm.customPermission-meta.xml",
      type: MetadataType.CustomPermission,
      content: `<?xml version="1.0" encoding="UTF-8"?>
<CustomPermission xmlns="http://soap.sforce.com/2006/04/metadata">
  <description>Test permission that does stuff</description>
  <isLicensed>false</isLicensed>
  <label>Disable DLRS</label>
</CustomPermission>
`,
    };
    let convertedComp = convert([component]);
    assert.equal(
      convertedComp[0].declarationContent,
      `declare module "@salesforce/customPermission/TestPerm" {
  /**
   * Disable DLRS
   *
   * @description Test permission that does stuff
   */
  const hasTestPerm:boolean;
  export default hasTestPerm;
}`
    );
  });
});
