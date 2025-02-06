/** @import { Component } from "../lib/index.mjs" */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { convert, MetadataType } from "../lib/index.mjs";

describe("Convert:StaticResource", async () => {
  it("Generate declaration from static resource", async () => {
    /** @type { Component } */
    let component = {
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
    let convertedComp = convert([component]);
    assert.equal(
      convertedComp[0].declarationContent,
      `declare module "@salesforce/resourceUrl/TextRaw" {
  /**
   * @description Logo for the the package
   * @access Private
   */
  const TextRaw:string;
  export default TextRaw;
}`
    );

    assert.deepEqual(convertedComp[0].mapData, [
      { sourcePos: 204, destPos: 15 },
      { sourcePos: 228, destPos: 48 },
      { sourcePos: 204, destPos: 135 },
      { sourcePos: 228, destPos: 142 },
    ]);
  });
});
