import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { metadataName } from "../src/names.ts";

describe("metadataName", () => {
  it("takes the file name up to its first dot, from either kind of path", () => {
    assert.equal(metadataName("force-app/objects/Account/Account.object-meta.xml"), "Account");
    assert.equal(metadataName("force-app\\lwc\\card\\card.js-meta.xml"), "card");
  });

  it("throws for a path without a name", () => {
    assert.throws(() => metadataName("force-app/objects/.object-meta.xml"), /no metadata name/);
  });
});
