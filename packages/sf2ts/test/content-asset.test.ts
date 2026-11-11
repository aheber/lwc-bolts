import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MetadataType, type Component } from "../src/index.ts";
import { convertOne, mappedText, typeCheck } from "./helpers.ts";

describe("Convert:ContentAsset", async () => {
  it("Generate declaration from content asset", async (t) => {
    let component: Component = {
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
    const convertedComp = await convertOne(component);
    t.assert.snapshot(convertedComp.text);

    assert.deepEqual(mappedText(convertedComp), [
      [`"@salesforce/contentAssetUrl/Image9"`, "Image9"],
      ["Image9", "Image9"],
    ]);
  });

  it("Names the module after the asset's developer name, not its label", async (t) => {
    const converted = await convertOne({
      path: "contentassets/companyLogo.asset-meta.xml",
      type: MetadataType.ContentAsset,
      content: `<?xml version="1.0" encoding="UTF-8"?>
<ContentAsset xmlns="http://soap.sforce.com/2006/04/metadata">
    <language>en_US</language>
    <masterLabel>Company Logo</masterLabel>
</ContentAsset>
`,
    });
    t.assert.snapshot(converted.text);
    assert.deepEqual(mappedText(converted), [
      [`"@salesforce/contentAssetUrl/companyLogo"`, "Company Logo"],
      ["companyLogo", "Company Logo"],
    ]);
    assert.deepEqual(
      typeCheck([converted.text], `import logo from "@salesforce/contentAssetUrl/companyLogo"; const url: string = logo;`),
      [],
    );
  });
});
