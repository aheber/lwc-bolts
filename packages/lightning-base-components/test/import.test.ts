// The base components' definitions: how scripts/generate.ts combines its sources and the
// overrides (without fetching anything), and that the shipped definitions reflect the overrides.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { parse } from "jsonc-parser";
import { LIGHTNING_COMPONENTS } from "../src/components.generated.ts";
import {
  applyOverrides,
  consolidate,
  importJestStubs,
  importLanguageServer,
  stubTag,
  validateOverrides,
} from "../scripts/lightning/import.ts";

const METADATA = {
  tags: [
    {
      name: "lightning-thing",
      description:
        "A thing.\n[View in Component Library](https://example.com)\n### Attributes\n* **label**: *STRING* The label.\n* **max-rows**: *INTEGER* Rows.\n* **class**: *STRING* A class.\n* **value**\n* **untyped**",
      attributes: [{ name: "label", description: "The label,\nshown above." }],
    },
    { name: "lightning-navigation", description: "A module, without attributes." },
    { name: "not-lightning", description: "* **x**: *STRING*" },
  ],
};
/** Converts attribute names as LWC does, leaving out the host's class. */
const toProperties = (_tag: string, attributes: string[]): [string, string][] =>
  attributes.filter((a) => a !== "class").map((a) => [a.replace(/-([a-z])/g, (_: string, l: string) => l.toUpperCase()), a]);

const STUBS = [
  {
    folder: "thing",
    source: `import { LightningElement, api } from 'lwc';
export default class Thing extends LightningElement {
    @api label;
    @api extra = 1;
    @api get computed() { return 1; }
    @api focusFirst() {}
}`,
  },
  { folder: "buttonIcon", source: "export default class ButtonIcon extends LightningElement { @api iconName; }" },
  { folder: "uiRecordApi", source: "export const getRecord = createLdsTestWireAdapter(jest.fn());" },
];

describe("importing the base components", () => {
  it("reads the language server's components, types and descriptions", () => {
    assert.deepEqual(importLanguageServer(METADATA, toProperties), {
      "lightning-thing": {
        description: "A thing. [View in Component Library](https://example.com)",
        properties: {
          label: { type: "string | number", description: "The label, shown above." },
          maxRows: { type: "number | string" },
          value: { type: "any" },
          untyped: { type: "any" },
        },
        methods: {},
        events: {},
      },
    });
  });

  it("reads the Jest stubs' components, properties and methods, skipping module stubs", () => {
    assert.equal(stubTag("buttonIconStateful"), "lightning-button-icon-stateful");
    assert.deepEqual(importJestStubs(STUBS), {
      "lightning-thing": {
        properties: { label: { type: "any" }, extra: { type: "any" }, computed: { type: "any" } },
        methods: { focusFirst: { type: "(...args: any[]) => any" } },
        events: {},
      },
      "lightning-button-icon": { properties: { iconName: { type: "any" } }, methods: {}, events: {} },
    });
  });

  it("consolidates both, preferring the language server's types and descriptions", () => {
    const components = consolidate(importLanguageServer(METADATA, toProperties), importJestStubs(STUBS));
    assert.deepEqual(Object.keys(components).sort(), ["lightning-button-icon", "lightning-thing"]);
    const thing = components["lightning-thing"]!;
    assert.deepEqual(thing.properties.label, { type: "string | number", description: "The label, shown above." });
    assert.deepEqual(thing.properties.extra, { type: "any" }, "only in the stubs");
    assert.deepEqual(thing.properties.maxRows, { type: "number | string" }, "only in the language server");
    assert.deepEqual(Object.keys(thing.methods), ["focusFirst"]);
  });
});

describe("overrides", () => {
  const imported = () => consolidate(importLanguageServer(METADATA, toProperties), importJestStubs(STUBS));

  it("change, add and remove members, winning over the imported ones", () => {
    const { components, warnings } = applyOverrides(imported(), {
      components: {
        "lightning-thing": {
          properties: { label: { type: "string" }, extra: null, added: { description: "Added." } },
          methods: { focusFirst: { type: "() => void" }, blur: {} },
          events: { change: { detail: "{ value: string }" }, select: { type: "Event" }, plain: {} },
        },
      },
    });
    assert.deepEqual(warnings, []);
    const thing = components["lightning-thing"]!;
    assert.deepEqual(
      thing.properties.label,
      { type: "string", description: "The label, shown above." },
      "the type changes, the description stays",
    );
    assert.equal(thing.properties.extra, undefined, "removed");
    assert.deepEqual(thing.properties.added, { type: "any", description: "Added." });
    assert.deepEqual(thing.methods, { focusFirst: { type: "() => void" }, blur: { type: "(...args: any[]) => any" } });
    assert.deepEqual(thing.events, {
      change: { type: "CustomEvent<{ value: string }>" },
      select: { type: "Event" },
      plain: { type: "CustomEvent<any>" },
    });
  });

  it("keep removed members and components removed however the sources change", () => {
    const overrides = { components: { "lightning-thing": { properties: { label: null } }, "lightning-button-icon": null } };
    // a later release of the sources still has them, and adds more
    const later = imported();
    later["lightning-thing"]!.properties.newOne = { type: "any" };
    const { components } = applyOverrides(later, overrides);
    assert.equal(components["lightning-button-icon"], undefined);
    assert.equal(components["lightning-thing"]!.properties.label, undefined);
    assert.deepEqual(components["lightning-thing"]!.properties.newOne, { type: "any" }, "new members still come in");
  });

  it("add components, and replace a component's imported members", () => {
    const { components } = applyOverrides(imported(), {
      components: {
        "lightning-new": { description: "New.", properties: { size: { type: "number" } } },
        "lightning-thing": { replace: true, properties: { only: { type: "string" } } },
      },
    });
    assert.deepEqual(components["lightning-new"], {
      description: "New.",
      properties: { size: { type: "number" } },
      methods: {},
      events: {},
    });
    assert.deepEqual(components["lightning-thing"], {
      description: "A thing. [View in Component Library](https://example.com)",
      properties: { only: { type: "string" } },
      methods: {},
      events: {},
    });
  });

  it("warn about removals that no longer match anything imported", () => {
    const { warnings } = applyOverrides(imported(), {
      components: { "lightning-gone": null, "lightning-thing": { properties: { gone: null }, events: { gone: null } } },
    });
    assert.deepEqual(warnings, [
      "lightning-gone is removed, but neither source has it",
      "lightning-thing.properties.gone is removed, but neither source has it",
      "lightning-thing.events.gone is removed, but neither source has it",
    ]);
  });

  it("are validated", () => {
    assert.deepEqual(validateOverrides({ components: {} }), []);
    assert.deepEqual(
      validateOverrides({
        extra: 1,
        components: {
          "c-not-lightning": null,
          "lightning-a": { unknown: true, replace: "yes", properties: { "bad-name": {}, ok: { type: "" } } },
          "lightning-b": { events: { Change: {}, change: { type: "Event", detail: "{}" }, other: { size: 1 } } },
          "lightning-c": "nope",
        },
      }),
      [
        'unknown key "extra"',
        '"c-not-lightning" isn\'t a lightning-* tag',
        'lightning-a: unknown key "unknown"',
        "lightning-a.replace must be a boolean",
        "lightning-a.properties.bad-name: not an identifier",
        "lightning-a.properties.ok.type must be a non-empty string",
        "lightning-b.events.Change: event names are lowercase, as `on<name>` handles them",
        "lightning-b.events.change: give a type or a detail, not both",
        'lightning-b.events.other: unknown key "size"',
        "lightning-c must be an object, or null to remove it",
      ],
    );
  });
});

describe("the shipped definitions", () => {
  const overrides = parse(readFileSync(path.join(import.meta.dirname, "../lightning/overrides.jsonc"), "utf8"));

  it("have valid overrides", () => {
    assert.deepEqual(validateOverrides(overrides), []);
  });

  it("reflect the overrides, so components.generated.ts was regenerated after changing them", () => {
    for (const [tag, component] of Object.entries<any>(overrides.components)) {
      const generated = LIGHTNING_COMPONENTS[tag];
      if (component === null) {
        assert.equal(generated, undefined, tag);
        continue;
      }
      assert.ok(generated, tag);
      for (const kind of ["properties", "methods", "events"] as const) {
        for (const [name, member] of Object.entries<any>(component[kind] ?? {})) {
          const at = `${tag}.${kind}.${name}`;
          if (member === null) {
            assert.equal(generated[kind][name], undefined, at);
          } else {
            const type = member.detail !== undefined ? `CustomEvent<${member.detail}>` : member.type;
            if (type !== undefined) assert.equal(generated[kind][name]?.type, type, at);
            if (member.description !== undefined) assert.equal(generated[kind][name]?.description, member.description, at);
          }
        }
      }
    }
  });
});
