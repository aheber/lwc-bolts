// Reading the Lightning Component Reference and comparing it with our definitions
// (scripts/lightning/reference.ts), without fetching anything.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compareReference,
  detailFields,
  formatComparison,
  indexTags,
  parsePage,
  parseSpecification,
  specificationPath,
  typeKinds,
} from "../scripts/lightning/reference.ts";

const PAGE = `# Combobox

**\`lightning-combobox\`**

A widget that provides an input field that is readonly,
accompanied by a dropdown list of selectable options.

**For Use In**

Lightning Experience

## Custom Events

**\`change\`**

The event fired when an item is selected in the combobox.

The \`change\` event returns this parameter.

| Parameter     | Type   | Description                       |
| ------------- | ------ | --------------------------------- |
| selectedValue | string | The value of the selected option. |

The event properties are as follows.

| Property   | Value | Description                       |
| ---------- | ----- | --------------------------------- |
| bubbles    | true  | This event bubbles up through the DOM. |
| cancelable | false | This event has no default behavior. |
| composed   | true  | This event propagates outside of the component. |

**\`open\`**

The event fired when the dropdown is opened.

The \`open\` event doesn’t return any parameters.

| Property   | Value | Description |
| ---------- | ----- | ----------- |
| bubbles    | false | Doesn't bubble. |
| cancelable | false | Not cancelable. |
| composed   | false | Not composed. |
:::

:::tab
::component-specification{component="combobox" model="lwc" namespace="lightning"}
:::
`;

const SPECIFICATION = {
  response: {
    name: "combobox",
    attributes: [
      { name: "label", nameInKebabCase: "label", description: "Text label for the combobox.", required: true, type: "string" },
      { name: "options", nameInKebabCase: "options", description: "A list of options.", type: "object[]" },
      { name: "placeholder", nameInKebabCase: "placeholder", description: "Text displayed when\nno option is selected.", type: "String" },
    ],
    methods: [
      { name: "focus", description: "Sets focus on the combobox." },
      {
        name: "setCustomValidity",
        description: "Sets a custom error message.",
        arguments: [{ name: "message", required: true, type: "string" }],
      },
    ],
  },
};

describe("reading the Lightning Component Reference", () => {
  it("lists the index's components, and each one's specification address", () => {
    assert.deepEqual(
      indexTags(
        "- [Button](/docs/platform/lightning-component-reference/guide/lightning-button.md)\n- [Get Started](/guide/get-started.md)\n- [Button](/guide/lightning-button.md)",
      ),
      ["lightning-button"],
    );
    assert.equal(
      specificationPath("lightning-button-icon-stateful"),
      "/cx-router/components?model=lwc&namespace=lightning&component=buttonIconStateful",
    );
  });

  it("reads a page's description and custom events", () => {
    assert.deepEqual(parsePage(PAGE), {
      description: "A widget that provides an input field that is readonly, accompanied by a dropdown list of selectable options.",
      events: {
        change: {
          description: "The event fired when an item is selected in the combobox.",
          parameters: [{ name: "selectedValue", type: "string", description: "The value of the selected option." }],
          bubbles: true,
          cancelable: false,
          composed: true,
        },
        open: {
          description: "The event fired when the dropdown is opened.",
          parameters: [],
          bubbles: false,
          cancelable: false,
          composed: false,
        },
      },
    });
    assert.deepEqual(parsePage("# Spinner\n\n**`lightning-spinner`**\n\nDisplays a spinner.\n"), {
      description: "Displays a spinner.",
      events: {},
    });
  });

  it("keeps escaped pipes in a table cell", () => {
    const page = parsePage(`**\`lightning-x\`**

X.

## Custom Events

**\`change\`**

Fired.

| Parameter | Type | Description |
| --- | --- | --- |
| value | string \\| number | The value, a string \\| number. |
| other | boolean | |
`);
    assert.deepEqual(page.events.change?.parameters, [
      { name: "value", type: "string | number", description: "The value, a string | number." },
      { name: "other", type: "boolean" },
    ]);
  });

  it("reads a specification's attributes, methods and slots", () => {
    assert.deepEqual(parseSpecification(SPECIFICATION), {
      attributes: {
        label: { type: "string", description: "Text label for the combobox.", required: true },
        options: { type: "object[]", description: "A list of options." },
        placeholder: { type: "String", description: "Text displayed when no option is selected." },
      },
      methods: {
        focus: { description: "Sets focus on the combobox.", arguments: [] },
        setCustomValidity: {
          description: "Sets a custom error message.",
          arguments: [{ name: "message", type: "string", required: true }],
        },
      },
      slots: {},
    });
    assert.equal(parseSpecification({ response: { name: "x" } }), undefined, "nothing published");
    assert.equal(parseSpecification({}), undefined);
  });

  it("classifies types by the kinds of value they allow", () => {
    const kinds = (type: string) => [...typeKinds(type)].sort();
    assert.deepEqual(kinds("String"), ["string"]);
    assert.deepEqual(kinds("string | number"), ["number", "string"]);
    assert.deepEqual(kinds("decimal|string"), ["number", "string"]);
    assert.deepEqual(kinds("Object[]"), ["array"]);
    assert.deepEqual(kinds("readonly unknown[]"), ["array"]);
    assert.deepEqual(kinds("Record<string, any>"), ["object"]);
    assert.deepEqual(kinds("string | null"), ["string"]);
    // a named type the reference doesn't define could be anything
    assert.deepEqual(kinds("DayType"), ["any"]);
    assert.deepEqual(kinds("*"), ["any"]);
  });

  it("reads an event type's detail fields", () => {
    assert.deepEqual(detailFields("CustomEvent<{ value: any; checked?: boolean }>"), ["value", "checked"]);
    assert.deepEqual(detailFields("CustomEvent<{ selectedRows: any[]; config?: { action?: string; value?: any } }>"), [
      "selectedRows",
      "config",
    ]);
    assert.equal(detailFields("CustomEvent<any>"), undefined);
    assert.equal(detailFields("Event"), undefined);
  });
});

describe("comparing the reference with our definitions", () => {
  const documented = { "lightning-combobox": { page: parsePage(PAGE), specification: parseSpecification(SPECIFICATION) } };
  const component = (overrides: object) => ({ properties: {}, methods: {}, events: {}, ...overrides });

  it("finds what one has that the other doesn't, and where they disagree", () => {
    const ours = {
      "lightning-combobox": component({
        properties: {
          label: { type: "boolean" }, // disagrees
          options: { type: "readonly unknown[]" },
          internal: { type: "any" }, // undocumented
          title: { type: "string | number" }, // the host's, documented globally
          ariaLabel: { type: "string | number" },
        },
        methods: { setCustomValidity: { type: "() => void" }, extra: { type: "(...args: any[]) => any" } },
        events: { change: { type: "CustomEvent<{ value: string }>" }, extra: { type: "CustomEvent<any>" } },
      }),
      "lightning-ours-only": component({}),
    };
    assert.deepEqual(compareReference(documented, ours), {
      "lightning-combobox": {
        missingAttributes: ["placeholder"],
        undocumentedProperties: ["internal"],
        typeDifferences: { label: { reference: "string", ours: "boolean" } },
        // focus comes from HTMLElement
        undocumentedMethods: ["extra"],
        argumentDifferences: { setCustomValidity: { reference: "(message: string)", ours: "() => void" } },
        missingEvents: ["open"],
        undocumentedEvents: ["extra"],
        detailDifferences: { change: { documentedParameters: ["selectedValue"], ours: "CustomEvent<{ value: string }>" } },
      },
      "lightning-ours-only": { status: "only in our definitions" },
    });
  });

  it("reports components only the reference has, and ones that match", () => {
    const ours = {
      "lightning-combobox": component({
        properties: {
          label: { type: "string | number" },
          options: { type: "readonly unknown[]" },
          placeholder: { type: "string | number" },
        },
        methods: { setCustomValidity: { type: "(message: string) => void" } },
        events: { change: { type: "CustomEvent<{ selectedValue: string }>" }, open: { type: "CustomEvent<any>" } },
      }),
    };
    const comparison = compareReference(
      { ...documented, "lightning-new": { page: { events: { done: { parameters: [] } } }, specification: undefined } },
      ours,
    );
    assert.deepEqual(comparison, {
      "lightning-combobox": { status: "matches" },
      "lightning-new": { status: "only in the reference", attributes: [], methods: [], events: ["done"], slots: [] },
    });
    assert.match(formatComparison(comparison), /^lightning-new \(only in the reference\)\n  events: done\n\n1 matches, .*\n$/);
  });
});
