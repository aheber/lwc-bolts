import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MetadataType, type Component } from "../src/index.ts";
import { convertOne, mappedText, typeCheck } from "./helpers.ts";

describe("Convert:StaticResource", async () => {
  it("Generate declaration from static resource", async (t) => {
    let component: Component = {
      path: "staticresources/TextRaw.resource-meta.xml",
      type: MetadataType.StaticResource,
      content: `<?xml version="1.0" encoding="UTF-8"?>
<StaticResource xmlns="http://soap.sforce.com/2006/04/metadata">
    <cacheControl>Private</cacheControl>
    <contentType>text/plain</contentType>
    <description>Logo for the the package</description>
</StaticResource>
`,
    };
    const convertedComp = await convertOne(component);
    t.assert.snapshot(convertedComp.text);

    // go-to-definition lands on the description, the resource's only text
    assert.deepEqual(mappedText(convertedComp), [
      [`"@salesforce/resourceUrl/TextRaw"`, "Logo for the the package"],
      ["TextRaw", "Logo for the the package"],
    ]);
  });

  it("Maps the declaration to the root element without a description", async (t) => {
    const converted = await convertOne({
      path: "staticresources/lib.resource-meta.xml",
      type: MetadataType.StaticResource,
      content: `<StaticResource xmlns="http://soap.sforce.com/2006/04/metadata"><cacheControl>Public</cacheControl><contentType>application/zip</contentType></StaticResource>`,
    });
    t.assert.snapshot(converted.text);
    assert.deepEqual(mappedText(converted), [
      ['"@salesforce/resourceUrl/lib"', "StaticResource"],
      ["lib", "StaticResource"],
    ]);
  });

  it("Prefixes a name that's a reserved word, so the declaration stays valid", async () => {
    const converted = await convertOne({
      path: "staticresources/delete.resource-meta.xml",
      type: MetadataType.StaticResource,
      content: `<StaticResource xmlns="http://soap.sforce.com/2006/04/metadata"><cacheControl>Public</cacheControl></StaticResource>`,
    });
    assert.match(converted.text, /\n  const _delete: string;\n  export default _delete;\n/);
    assert.deepEqual(typeCheck([converted.text], `import url from "@salesforce/resourceUrl/delete"; const s: string = url;`), []);
  });
});
