import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MetadataType, type Component } from "../src/index.ts";
import { convertOne, mappedText, typeCheck } from "./helpers.ts";

describe("Convert:CustomPermission", async () => {
  it("Transform Custom Permission", async (t) => {
    let component: Component = {
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
    const convertedComp = await convertOne(component);
    t.assert.snapshot(convertedComp.text);

    assert.deepEqual(mappedText(convertedComp), [
      [`"@salesforce/customPermission/TestPerm"`, "Disable DLRS"],
      ["hasTestPerm", "Disable DLRS"],
    ]);
  });

  it("Types a permission as true when the user has it, and undefined otherwise, never false", async () => {
    const converted = await convertOne({
      path: "customPermissions/Perm.customPermission-meta.xml",
      type: MetadataType.CustomPermission,
      content: `<CustomPermission xmlns="http://soap.sforce.com/2006/04/metadata"><label>Perm</label></CustomPermission>`,
    });
    assert.deepEqual(
      typeCheck(
        [converted.text],
        `import hasPerm from "@salesforce/customPermission/Perm";
const granted: boolean = hasPerm === true;
const shown: boolean = !!hasPerm;
// @ts-expect-error it's undefined, not false, without the permission
const denied = hasPerm === false;
// @ts-expect-error it can be undefined
const strict: boolean = hasPerm;
export { granted, shown, denied, strict };`,
      ),
      [],
    );
  });

  it("Omits a missing description", async (t) => {
    const converted = await convertOne({
      path: "customPermissions/Perm.customPermission-meta.xml",
      type: MetadataType.CustomPermission,
      content: `<CustomPermission xmlns="http://soap.sforce.com/2006/04/metadata"><label>Perm</label></CustomPermission>`,
    });
    t.assert.snapshot(converted.text);
  });
});
