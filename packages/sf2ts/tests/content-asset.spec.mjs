/** @import { Component } from "../lib/index.mjs" */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { convert, MetadataType } from "../lib/index.mjs";

describe("Convert:StaticResource", async () => {
  it("Generate declaration from static resource", async () => {
    /** @type { Component } */
    let component = {
      path: "contentassets/Image9.asset-meta.xml",
      type: MetadataType.ContentAsset,
      content: `<?xml version="1.0" encoding="UTF-8"?>
<ContentAsset xmlns="http://soap.sforce.com/2006/04/metadata">
    <isVisibleByExternalUsers>false</isVisibleByExternalUsers>
    <language>en_US</language>
    <masterLabel>Image9</masterLabel>
    <relationships>
        <organization>
            <access>VIEWER</access>
        </organization>
    </relationships>
    <versions>
        <version>
            <number>1</number>
            <pathOnClient>Image-9.png</pathOnClient>
        </version>
    </versions>
</ContentAsset>
`,
    };
    let convertedComp = convert([component]);
    assert.equal(
      convertedComp[0].declarationContent,
      `declare module "@salesforce/contentAssetUrl/Image9" {
  const Image9: string;
  export default Image9;
}`
    );

    assert.deepEqual(convertedComp[0].mapData, [
      { sourcePos: 213, destPos: 15 },
      { sourcePos: 219, destPos: 51 },
      { sourcePos: 213, destPos: 62 },
      { sourcePos: 219, destPos: 68 },
    ]);
  });
});
