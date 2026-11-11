import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { jsDoc } from "../src/jsdoc.ts";

describe("jsDoc", () => {
  it("keeps text from closing the comment, splitting lines and dropping missing ones", () => {
    assert.equal(
      jsDoc("  ", ["Use /* or */ freely", undefined, "", "a\nb"]),
      "  /**\n   * Use /* or *\\/ freely\n   *\n   * a\n   * b\n   */\n",
    );
  });

  it("renders nothing without lines", () => {
    assert.equal(jsDoc("  ", [undefined]), "");
  });
});
