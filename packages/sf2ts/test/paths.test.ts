import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MetadataType } from "../src/index.ts";
import { convertOne } from "./helpers.ts";

// Names come from the file's path, which can use either separator (Windows paths use backslashes). Most types
// take their name from metadataName (see names.test.ts); a field also takes its object's from the folders.
describe("Paths", () => {
  it("names CustomField modules from Windows and POSIX paths alike", async () => {
    for (const path of [
      "C:\\project\\force-app\\main\\default\\objects\\Thing__c\\fields\\Size__c.field-meta.xml",
      "/project/force-app/main/default/objects/Thing__c/fields/Size__c.field-meta.xml",
    ]) {
      const converted = await convertOne({
        path,
        type: MetadataType.CustomField,
        content: "<CustomField><fullName>Size__c</fullName><type>Number</type></CustomField>",
      });
      assert.ok(converted.text.includes('declare module "@salesforce/schema/Thing__c.Size__c"'), `${path}:\n${converted.text}`);
    }
  });
});
