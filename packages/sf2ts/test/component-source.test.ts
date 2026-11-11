import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseComponentSource } from "../src/lightning-component-bundle/component-source.ts";

describe("Component source parsing", () => {
  it("parses JavaScript and TypeScript components with decorators", () => {
    const javascript = `import { LightningElement, api, wire } from "lwc";
export default class Card extends LightningElement {
  @api recordId;
  @wire(getRecord, { recordId: "$recordId" }) record;
}`;
    const typescript = `import { LightningElement, api } from "lwc";
export default class Card<T> extends LightningElement {
  @api recordId?: string;
  private items: T[] = [];
  handle(event: CustomEvent<{ id: string }>): void {}
}`;
    for (const source of [javascript, typescript]) {
      assert.deepEqual(
        parseComponentSource(source)?.body.map((node) => node.type),
        ["ImportDeclaration", "ExportDefaultDeclaration"],
      );
    }
  });

  it("reads regular expression literals as code, whatever quotes they contain", () => {
    const program = parseComponentSource("const r = /`'\"/;\nexport default class Card {}");
    assert.deepEqual(
      program?.body.map((node) => node.type),
      ["VariableDeclaration", "ExportDefaultDeclaration"],
    );
  });

  it("returns undefined for a module that doesn't parse", () => {
    assert.equal(parseComponentSource("export default class Card {"), undefined);
  });
});
