import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TextBuilder } from "../src/text-builder.ts";

describe("TextBuilder", () => {
  it("maps each mapped piece's start and end, leaving unmapped text out", () => {
    const builder = new TextBuilder();
    builder.write("ab", 0, 2);
    builder.write("--");
    builder.writeMapped("cd", { start: 5, end: 7 });
    builder.writeMapped("!", null);
    assert.equal(builder.text, "ab--cd!");
    assert.deepEqual(builder.mapData, [
      { sourcePos: 0, destPos: 0 },
      { sourcePos: 2, destPos: 2 },
      { sourcePos: 5, destPos: 4 },
      { sourcePos: 7, destPos: 6 },
    ]);
  });

  it("leaves text with only a start unmapped, since a mapped piece needs both ends", () => {
    const builder = new TextBuilder();
    builder.write("ab", 0);
    assert.equal(builder.text, "ab");
    assert.deepEqual(builder.mapData, []);
  });
});
