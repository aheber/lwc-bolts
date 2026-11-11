// LWC templates: converting them to TypeScript that checks them. Tests that go through the content mapper
// (finding a child's events and slots in a project, span encoding) are in typescript-content-mapper.
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import type { LightningComponent } from "@lwc-bolts/lightning-base-components";
import {
  convertTemplate as convertWith,
  templateExportName,
  type ConvertedTemplate,
  type TemplateContext,
} from "../src/lightning-component-bundle/templates/template.ts";
import { TEMPLATE_HELPERS } from "../src/lightning-component-bundle/templates/helpers.ts";
import { bundleApiVersion, convert, MetadataType } from "../src/index.ts";
import { MapFeature } from "../src/text-builder.ts";
import { checkProject } from "./helpers.ts";

/**
 * Base components standing in for lightning-base-components' definitions, so these tests don't change when
 * those are regenerated. e2e.test.ts in typescript-content-mapper checks every real definition compiles.
 */
const BASE_COMPONENTS: Record<string, LightningComponent> = {
  "lightning-input": {
    properties: {
      label: { type: "string | number", description: "Text label for the input." },
      maxLength: { type: "number | string" },
    },
    methods: { reportValidity: { type: "() => boolean" } },
    events: { change: { type: "CustomEvent<{ value: any }>" } },
  },
  "lightning-button": { properties: { label: { type: "string" } }, methods: {}, events: {} },
};

/** Converts a template with the stand-in base components, unless `context` gives others. */
const convertTemplate = (content: string, componentModule: string, context: TemplateContext = {}) =>
  convertWith(content, componentModule, { baseComponents: BASE_COMPONENTS, ...context });

/** Pairs each mapped piece of output with the template text it maps to. */
function mappedText(result: ConvertedTemplate, original: string): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < result.mapData.length; i += 2) {
    const start = result.mapData[i]!;
    const end = result.mapData[i + 1]!;
    pairs.push([result.text.slice(start.destPos, end.destPos), original.slice(start.sourcePos, end.sourcePos)]);
  }
  return pairs;
}

/** The default export of a template with no `fileName`. */
const TEMPLATE_EXPORT = '// @ts-ignore\ndeclare const defaultTemplate: import("lwc").Template;\nexport default defaultTemplate;\n';

/** A template's own code: its output without the component's import, its default export and the helpers it declares. */
function templateCode(text: string): string {
  const header = "declare const $cmp: InstanceType<typeof __Component>;\n";
  let code = text.slice(text.indexOf(header) + header.length).replace(TEMPLATE_EXPORT, "");
  for (const declaration of Object.values(TEMPLATE_HELPERS)) {
    code = code.replace(declaration, "");
  }
  return code;
}

/** A project whose `c/<name>` modules are its `<name>.ts` files. */
const slotOptions = {
  strict: true,
  noEmit: true,
  target: "es2022",
  module: "esnext",
  moduleResolution: "bundler",
  lib: ["es2022", "dom"],
  paths: { "c/*": ["./*.ts"] },
};
/** Each child's templates, converted as its own (`c/<name>`), as files of a project with its class. */
const childFiles = async (children: Record<string, string[]>) => {
  const files: Record<string, string> = {};
  for (const [name, templates] of Object.entries(children)) {
    files[`${name}.ts`] = "export default class {}";
    for (const [i, template] of templates.entries()) {
      files[`${name}.template${i}.ts`] = (await convertTemplate(template, `./${name}.js`, { module: `c/${name}` })).text;
    }
  }
  return files;
};

describe("templates", () => {
  describe("default export", () => {
    const LWC = 'declare module "lwc" { export interface Template { (api: object): unknown; slots?: string[] } }\n';
    const options = { strict: true, noEmit: true, target: "es2022", module: "esnext", moduleResolution: "bundler", lib: ["es2022", "dom"] };

    it("is named after the template's file", () => {
      assert.equal(templateExportName("/lwc/orders/orders.html"), "ordersTemplate");
      assert.equal(templateExportName("views/Compact.HTML"), "CompactTemplate");
      // names that aren't identifiers, or are reserved words, on their own
      assert.equal(templateExportName("default.html"), "defaultTemplate");
      assert.equal(templateExportName("my-view.v2.html"), "my_view_v2Template");
      assert.equal(templateExportName("2col.html"), "_2colTemplate");
    });

    it("types an import of the template as a Template, mapping its name to the root tag", async () => {
      const content = "\n<template><p>{title}</p></template>";
      const result = await convertTemplate(content, "./c.js", { fileName: "/lwc/c/delete.html" });
      assert.ok(result.text.includes("export default deleteTemplate;\n"));
      assert.deepEqual(mappedText(result, content).at(-1), ["deleteTemplate", "template"]);
      const definition = result.mapData.findLast((pair) => pair.features !== undefined);
      assert.equal(definition?.features, MapFeature.Definition);
      assert.deepEqual(
        checkProject(
          {
            "lwc.d.ts": LWC,
            "c.ts": `import template from "./t";
export default class C {
  title = "";
  render() {
    return template;
  }
}
const slots: string[] | undefined = template.slots;
void slots;
const wrong: string = template;
void wrong;
`,
            "t.ts": result.text,
          },
          options,
        ),
        ["c.ts:10 TS2322: Type 'Template' is not assignable to type 'string'."],
      );
    });

    it("is `any` with lwc typings that have no Template", async () => {
      const { text } = await convertTemplate("<template></template>", "./c.js");
      assert.deepEqual(
        checkProject(
          { "lwc.d.ts": 'declare module "lwc" { export const x: number; }\n', "c.ts": "export default class C {}\n", "t.ts": text },
          options,
        ),
        [],
      );
    });

    it("is there when the template doesn't parse, so importing it stays valid", async () => {
      for (const content of ["", "<template>\n  <div {broken\n"]) {
        const result = await convertTemplate(content, "./c.js");
        assert.ok(result.diagnostics.length > 0, content);
        assert.ok(result.text.includes(TEMPLATE_EXPORT), content);
      }
    });
  });

  describe("lwc:ref", () => {
    const REFS = `<template>
    <input lwc:ref="search" />
    <c-base-card lwc:ref="card"></c-base-card>
    <lightning-input lwc:ref="field"></lightning-input>
    <template lwc:if={hasOrders}><button lwc:ref="approve"></button></template>
</template>
`;

    it("types this.refs in the component from the template's refs", async (t) => {
      const result = await convertTemplate(REFS, "./orders.js");
      assert.match(result.text, /^type __lwcComponent0 = typeof import\("c\/baseCard"\)\.default;$/m);
      const code = templateCode(result.text);
      const augmentation = code.slice(code.indexOf("declare module"));
      t.assert.snapshot(augmentation);
      const mapped = mappedText(result, REFS);
      // go-to-definition on this.refs.search opens the lwc:ref, and on c/baseCard the tag
      assert.ok(mapped.some(([virtual, original]) => virtual === "search" && original === "search"));
      assert.ok(mapped.some(([virtual, original]) => virtual === `"c/baseCard"` && original === "c-base-card"));
    });

    it("maps a child's tag to its module and, for go-to-definition only, its class", async () => {
      const result = await convertTemplate(REFS, "./orders.js");
      const tag = REFS.indexOf("c-base-card");
      const pieces = result.mapData
        .filter((pair, i) => i % 2 === 0 && pair.sourcePos === tag)
        .map((pair) => [result.text.slice(pair.destPos).match(/^"[^"]*"|^\w+/)?.[0], pair.features]);
      // the module for everything else, so a missing component is reported on the tag and hovering it
      // shows the component's label, and the default export, the class, for go-to-definition
      assert.deepEqual(pieces, [
        ['"c/baseCard"', MapFeature.All & ~MapFeature.Definition],
        ["default", MapFeature.Definition],
      ]);
    });

    it("makes every ref optional when the bundle has other templates", async () => {
      const result = await convertTemplate(REFS, "./orders.js", { alternateTemplates: true });
      assert.match(result.text, /    search\?: __lwcElement<"input">;\n    card\?: /);
    });

    it("types this.refs for TypeScript across a bundle's templates, over LightningElement's refs", async () => {
      const lwc = `declare module "lwc" {
  type RefNodes = { [name: string]: Element };
  export class LightningElement { refs: RefNodes | undefined; }
}`;
      const component = `import { LightningElement } from "lwc";
export default class Orders extends LightningElement {
  check() {
    const search: HTMLInputElement | undefined = this.refs?.search;
    const panel: HTMLDivElement | undefined = this.refs?.panel;
    // @ts-expect-error no template has this ref
    this.refs?.missing;
    return [search, panel];
  }
}`;
      const main = await convertTemplate('<template><input lwc:ref="search" /></template>', "./orders.js", { alternateTemplates: true });
      const alt = await convertTemplate('<template><div lwc:ref="panel"></div></template>', "../orders.js", { alternateTemplates: true });
      const options = {
        strict: true,
        noEmit: true,
        target: "es2022",
        module: "esnext",
        moduleResolution: "bundler",
        lib: ["es2022", "dom"],
        types: [],
      };
      assert.deepEqual(
        checkProject({ "lwc.d.ts": lwc, "orders.ts": component, "orders.html.ts": main.text, "views/alt.html.ts": alt.text }, options),
        [],
      );
    });

    it("leaves this.refs alone without refs", async () => {
      const result = await convertTemplate("<template><p>{title}</p></template>", "./orders.js");
      assert.doesNotMatch(result.text, /declare module/);
    });
  });

  describe("event handlers", () => {
    const EVENTS = `<template>
    <c-base-card ontoggle={handleToggle} onclick={handleClick} onother={handleOther}></c-base-card>
    <input onkeyup={handleKey} onselect={handleSelect} oncustom={handleCustom} />
    <lightning-input onchange={handleChange}></lightning-input>
</template>
`;
    const handlers = (text: string) =>
      Object.fromEntries([...text.matchAll(/\[\$cmp\.(\w+)\] satisfies \[\((.+)\) => unknown\];/g)].map((m) => [m[1], m[2]]));

    it("checks only that each handler is a function, whatever the event, on children, elements and base components", async () => {
      const result = await convertTemplate(EVENTS, "./orders.js");
      const any = "...args: any[]";
      assert.deepEqual(handlers(result.text), {
        handleToggle: any,
        handleClick: any,
        handleOther: any,
        handleKey: any,
        handleSelect: any,
        handleCustom: any,
        handleChange: any,
      });
      assert.doesNotMatch(result.text, /Events/);
    });

    it("accepts a method whatever event it takes, and reports a handler that isn't a function or doesn't exist", async () => {
      const component = `export default class C {
  label = "";
  handleClick(event: MouseEvent): void {}
  handleCustom(event: CustomEvent<{ id: string }>): void {}
  handleNothing(): void {}
}
`;
      const result = await convertTemplate(
        `<template>
    <button onclick={handleClick} onfocus={handleCustom} onpick={handleNothing}></button>
    <c-card onpick={handleClick} onanything={handleCustom}></c-card>
    <lightning-input onchange={handleNothing}></lightning-input>
    <button onclick={label}></button>
    <button onclick={handleMissing}></button>
</template>`,
        "./c.js",
      );
      const errors = checkProject(
        { "c.ts": component, "card.ts": "export default class Card {}", "template.ts": result.text },
        { ...slotOptions, types: [] },
      );
      assert.equal(errors.length, 2, errors.join("\n"));
      assert.match(errors[0]!, /'string' is not assignable to type '\(\.\.\.args: any\[\]\) => unknown'/);
      assert.match(errors[1]!, /Property 'handleMissing' does not exist on type 'C'/);
    });
  });

  describe("child components", () => {
    const body = templateCode;

    it("checks each property against the child's public members, on its attribute", async () => {
      const content = `<template>
    <c-base-card title="Orders" record-id={recordId} expanded tabindex="0" class="x" data-id="1"></c-base-card>
    <c-other-card></c-other-card>
</template>
`;
      const result = await convertTemplate(content, "./orders.js");
      const checks = [...result.text.matchAll(/^\(\{ .+ \}\) satisfies .+;$/gm)].map((m) => m[0]);
      assert.deepEqual(checks, [
        '({ title: "Orders" }) satisfies __lwcProperties<InstanceType<__lwcComponent0>>;',
        "({ recordId: $cmp.recordId }) satisfies __lwcProperties<InstanceType<__lwcComponent0>>;",
        "({ expanded: true }) satisfies __lwcProperties<InstanceType<__lwcComponent0>>;",
        // LWC normalizes tabindex, so only its name is checked
        "({ tabIndex: undefined }) satisfies __lwcProperties<InstanceType<__lwcComponent0>>;",
      ]);
      // class and data-* stay attributes of the host, so they aren't the child's properties
      assert.doesNotMatch(result.text, /class|dataId/);
      // every child is referenced, so a missing one is reported on its tag
      assert.match(result.text, /type __lwcComponent1 = typeof import\("c\/otherCard"\)\.default;/);
      const mapped = mappedText(result, content);
      assert.ok(mapped.some(([virtual, original]) => virtual === "recordId" && original === "record-id"));
      assert.ok(mapped.some(([virtual, original]) => virtual === `"c/otherCard"` && original === "c-other-card"));
    });

    it("checks base components' properties from their definitions", async () => {
      const content = `<template>
    <lightning-input label={title} max-length="10" lable="x"></lightning-input>
    <lightning-not-a-component foo={bar}></lightning-not-a-component>
</template>
`;
      const result = await convertTemplate(content, "./orders.js");
      const checks = [...result.text.matchAll(/^\(\{ .+ \}\) satisfies .+;$/gm)].map((m) => m[0]);
      assert.deepEqual(checks, [
        "({ label: $cmp.title }) satisfies __lwcLightning0;",
        // base components coerce what they're given, so a literal only checks the name
        "({ maxLength: undefined }) satisfies __lwcLightning0;",
        "({ lable: undefined }) satisfies __lwcLightning0;",
      ]);
      const alias = result.text.slice(result.text.indexOf("type __lwcLightning0 = {"), result.text.indexOf("} & __lwcHostProperties;"));
      assert.match(alias, /\n  "label"\?: string \| number;\n/);
      assert.match(alias, /\n  "maxLength"\?: number \| string;\n/);
      // their descriptions show on hover
      assert.match(alias, /\n  \/\*\* Text label for the input\. \*\/\n  "label"\?: string \| number;\n/);
      // an unknown base component's bindings are still checked to exist on this component
      assert.match(body(result.text), /^\$cmp\.bar;$/m);
    });

    it("declares the slots a template has for the templates that use its component", async () => {
      const content =
        '<template><slot name="footer"></slot><template lwc:if={a}><slot name="header"></slot><slot></slot></template></template>';
      const result = await convertTemplate(content, "./baseCard.js", { module: "c/baseCard" });
      assert.match(
        result.text,
        /^declare global \{\n  interface __LwcSlots \{\n    "c\/baseCard": true;\n    "c\/baseCard footer": true;\n    "c\/baseCard header": true;\n    "c\/baseCard \(default\)": true;\n  \}\n\}\n/m,
      );
      // nothing without its module, as for a template converted on its own
      assert.doesNotMatch((await convertTemplate(content, "./baseCard.js")).text, /__LwcSlots/);
    });

    it("checks slotted content against the slots the child's templates declare", async () => {
      const content = `<template>
    <c-base-card>
        <p slot="footer">ok</p>
        <template lwc:if={flag}><b slot="headr"></b></template>
        <!-- a comment -->
        <span>default</span>
        text
    </c-base-card>
    <c-no-slots><i></i></c-no-slots>
    <c-unknown><i slot="x"></i></c-unknown>
</template>
`;
      const result = await convertTemplate(content, "./c.js");
      const slots = [...result.text.matchAll(/^\[(".*")\] satisfies \[(.+)\];$/gm)].map((m) => [m[2], m[1]]);
      assert.deepEqual(slots, [
        ['__lwcSlots<"c/baseCard">', '"footer"'],
        ['__lwcSlots<"c/baseCard">', '"headr"'],
        ['__lwcSlots<"c/baseCard">', '"(default)"'], // <span> without a slot
        ['__lwcSlots<"c/baseCard">', '"(default)"'], // the text
        ['__lwcSlots<"c/noSlots">', '"(default)"'],
        ['__lwcSlots<"c/unknown">', '"x"'],
      ]);
      const mapped = mappedText(result, content);
      assert.ok(mapped.some(([virtual, original]) => virtual === '"headr"' && original === "headr"));
      assert.ok(mapped.some(([virtual, original]) => virtual === '"(default)"' && original === "span"));

      // baseCard's slots come from both of its templates; c-unknown has none in the project, so it isn't checked
      const children = await childFiles({
        unknown: [],
        baseCard: ['<template><slot name="footer"></slot></template>', '<template><slot name="header"></slot></template>'],
        noSlots: ["<template><p></p></template>"],
      });
      const errors = checkProject(
        { ...children, "c.ts": "export default class C { flag = true; }", "template.ts": result.text },
        slotOptions,
      );
      assert.deepEqual(
        errors.map((error) => error.replace(/^template\.ts:\d+ /, "").replace(/"header" \| "footer"/, '"footer" | "header"')),
        [
          `TS2820: Type '"headr"' is not assignable to type '"footer" | "header"'. Did you mean '"header"'?`,
          `TS2322: Type '"(default)"' is not assignable to type '"footer" | "header"'.`, // baseCard has no default slot
          `TS2322: Type '"(default)"' is not assignable to type '"footer" | "header"'.`,
          "TS2322: Type 'string' is not assignable to type 'never'.", // c-no-slots has no slots at all
        ],
      );
    });

    it("leaves slotted content unchecked when a child's template has errors, as when one is being edited", async () => {
      const content = '<template><c-card><p slot="footer"></p><span></span></c-card></template>';
      const parent = (await convertTemplate(content, "./c.js")).text;
      for (const broken of [
        "", // a new, empty file
        "<div><slot></slot></div>", // no root template
        '<template><slot name="footer"></slot><p></template>', // a slot after an error may be missing
        "<template><template lwc:else></template><slot></slot></template>",
      ]) {
        const children = await childFiles({ card: ['<template><slot name="header"></slot></template>', broken] });
        assert.match(children["card.template1.ts"]!, /"c\/card \*": true;/, JSON.stringify(broken));
        const errors = checkProject({ ...children, "c.ts": "export default class C {}", "template.ts": parent }, slotOptions);
        assert.deepEqual(
          errors.filter((error) => error.startsWith("template.ts")),
          [],
          JSON.stringify(broken),
        );
      }
    });
  });

  describe("mapping and scoping", () => {
    /** The template offsets that each occurrence of `virtual` in the output maps to. */
    const sourcesOf = (result: ConvertedTemplate, virtual: string) => {
      const starts: number[] = [];
      for (let i = 0; i + 1 < result.mapData.length; i += 2) {
        const start = result.mapData[i]!;
        if (result.text.slice(start.destPos, result.mapData[i + 1]!.destPos) === virtual) {
          starts.push(start.sourcePos);
        }
      }
      return starts;
    };
    /** Every offset of `text` in `content`. */
    const offsetsOf = (content: string, text: string) =>
      [...content.matchAll(new RegExp(text.replace(/[.$]/g, "\\$&"), "g"))].map((m) => m.index);
    const code = templateCode;

    it("maps each binding in a run of text to its own occurrence, past entities", async () => {
      const content = "<template><p>{a} &amp; {a} &lt;&#123; {b.c}</p></template>";
      const result = await convertTemplate(content, "./c.js");
      assert.deepEqual(
        sourcesOf(result, "a"),
        offsetsOf(content, "{a}").map((offset) => offset + 1),
      );
      assert.deepEqual(sourcesOf(result, "b.c"), [content.indexOf("b.c")]);
      assert.equal(code(result.text), "$cmp.a;\n$cmp.a;\n$cmp.b.c;\n");
    });

    it("maps attributes across lines", async () => {
      const content = "<template>\n  <input\n    value={first}\n\n    data-x={second.third}\n    onchange={handleChange}>\n</template>";
      const result = await convertTemplate(content, "./c.js");
      for (const name of ["first", "second.third", "handleChange"]) {
        assert.deepEqual(sourcesOf(result, name), [content.indexOf(name)], name);
      }
    });

    it("scopes nested loops, including one that shadows its parent's variable", async (t) => {
      const content = `<template>
    <template for:each={items} for:item="item" for:index="i">
        <div key={item.id}>
            <template for:each={item.children} for:item="item"><span key={item.id}>{item.name} {i}</span></template>
            <template iterator:it={item.children}><b key={it.value.id}>{it.first} {it.index}</b></template>
        </div>
    </template>
    {item} {it}
</template>`;
      const result = await convertTemplate(content, "./c.js");
      t.assert.snapshot(code(result.text));
      // each loop variable's definition is its own for:item
      const itemNames = offsetsOf(content, '"item"').map((offset) => offset + 1);
      assert.deepEqual(sourcesOf(result, "item").slice(0, 2), itemNames);
      assert.deepEqual(sourcesOf(result, "item.children"), offsetsOf(content, "item.children"));
      assert.deepEqual(sourcesOf(result, "i"), [content.indexOf('"i"') + 1, content.indexOf("{i}") + 1]);
    });

    it("reports for:index without for:item", async () => {
      const result = await convertTemplate(
        '<template><template for:each={items} for:index="i"><p key={i}>{i}</p></template></template>',
        "./c.js",
      );
      assert.match(result.diagnostics[0]!.message, /LWC1044/);
    });

    it("converts if:false, and lwc:if chains", async () => {
      const content = `<template>
    <template if:false={hidden}>{x}</template>
    <template lwc:if={p}>{y}</template><template lwc:elseif={q.r}>{z}</template><template lwc:else>{w}</template>
</template>`;
      const result = await convertTemplate(content, "./c.js");
      assert.equal(
        code(result.text),
        "if (!$cmp.hidden) {\n  $cmp.x;\n}\nif ($cmp.p) {\n  $cmp.y;\n}\nelse if ($cmp.q.r) {\n  $cmp.z;\n}\nelse {\n  $cmp.w;\n}\n",
      );
      assert.deepEqual(sourcesOf(result, "q.r"), [content.indexOf("q.r")]);
    });

    it("declares lwc:slot-data as any, scoped to its template", async () => {
      const content = '<template><c-list><template lwc:slot-data="row"><p>{row.name} {title}</p></template></c-list>{row}</template>';
      const result = await convertTemplate(content, "./c.js");
      // the fragment, without a slot, goes in the default one
      assert.match(
        code(result.text),
        /^\["\(default\)"\] satisfies \[__lwcSlots<"c\/list">\];\n\{\n  const row = undefined as any; void row;\n  row\.name;\n  \$cmp\.title;\n\}\n\$cmp\.row;\n/,
      );
      assert.deepEqual(sourcesOf(result, "row")[0], content.indexOf('"row"') + 1);
    });

    describe("lwc:ref", () => {
      it("unions a ref's elements across exclusive branches, which makes it optional", async () => {
        const result = await convertTemplate(
          '<template><template lwc:if={a}><input lwc:ref="x"/></template><template lwc:else><textarea lwc:ref="x"></textarea></template></template>',
          "./c.js",
        );
        assert.match(result.text, /^    x\?: __lwcElement<"input"> \| __lwcElement<"textarea">;$/m);
      });

      it("skips refs that aren't identifiers", async () => {
        const result = await convertTemplate('<template><p lwc:ref="bad name"></p><p lwc:ref="ok"></p></template>', "./c.js");
        assert.match(result.text, /export interface __LwcRefs \{\n    ok: __lwcElement<"p">;\n  \}/);
      });

      it("reports refs in loops, as the compiler does", async () => {
        const result = await convertTemplate(
          '<template><template for:each={items} for:item="it"><p key={it.id} lwc:ref="row"></p></template></template>',
          "./c.js",
        );
        assert.match(result.diagnostics.map((d) => d.message).join("\n"), /LWC1158: Invalid lwc:ref usage/);
      });
    });

    it("reports the compiler's errors, which leave nothing else to check", async () => {
      const content = "<template><p title={a.b[0]}>{c}</p></template>";
      const result = await convertTemplate(content, "./c.js");
      assert.deepEqual(result.diagnostics, [
        {
          message:
            'Invalid expression {a.b[0]} - LWC1207: Template expression doesn\'t allow computed property access unless the expression is surrounded by quotes: "{a.b[0]}"',
          start: content.indexOf("title"),
          length: "title={a.b[0]}".length,
        },
      ]);
      assert.equal(code(result.text), "");
    });

    it("keeps diagnostics inside the template", async () => {
      for (const content of ["<template><p>{a</p></template>", "<template><p>", "", "<div></div>"]) {
        const { diagnostics } = await convertTemplate(content, "./c.js");
        for (const { start, length } of diagnostics) {
          assert.ok(start >= 0 && start + length <= content.length, JSON.stringify({ content, start, length }));
        }
      }
    });

    describe("complex expressions", () => {
      it("writes them as they are, with $cmp. before the component's members", async () => {
        const content = `<template>
    <p class="{a ?? b.c}">{d + 1} and {e ? f : 'g'}</p>
    <c-card title="{h.i(j)}" onpick="{(event) => k(event, l)}"></c-card>
    <template lwc:if="{m && !n}">{o[p]}</template>
    <template if:false="{q || r}"></template>
    <template for:each="{items.filter((item) => item.ok)}" for:item="row"><b key="{row.id + s}">{row.name}</b></template>
</template>`;
        const result = await convertTemplate(content, "./c.js");
        assert.deepEqual(result.diagnostics, []);
        const body = code(result.text);
        for (const line of [
          "($cmp.a ?? $cmp.b.c);",
          "($cmp.d + 1);",
          "($cmp.e ? $cmp.f : 'g');",
          "({ title: ($cmp.h.i($cmp.j)) }) satisfies __lwcProperties<InstanceType<__lwcComponent0>>;",
          "[((event) => $cmp.k(event, $cmp.l))] satisfies [(...args: any[]) => unknown];",
          "if (($cmp.m && !$cmp.n)) {",
          "$cmp.o[$cmp.p];",
          "if (!($cmp.q || $cmp.r)) {",
          "const __lwcList0 = ($cmp.items.filter((item) => item.ok));",
          "for (const row of __lwcList0 ?? []) {",
          "(row.id + $cmp.s);",
        ]) {
          assert.ok(body.includes(line), `${line}\n${body}`);
        }
      });

      it("respects arrow functions' parameters, however they're declared and shadowed", async () => {
        const result = await convertTemplate(
          `<template><p class="{list.map(({ a, b: [c], ...d }, ...g) => [a, c, d, g, h, (h) => h])}"></p></template>`,
          "./c.js",
        );
        assert.deepEqual(result.diagnostics, []);
        assert.equal(code(result.text), "($cmp.list.map(({ a, b: [c], ...d }, ...g) => [a, c, d, g, $cmp.h, (h) => h]));\n");
      });

      it("reports what only LWC's codegen rejects, on the expression", async () => {
        const content = '<template>\n  <p class="{list.map((a = 1) => a)}" title={ok}>{next}</p>\n</template>';
        const result = await convertTemplate(content, "./c.js");
        assert.deepEqual(result.diagnostics, [
          {
            message: "LWC1189: Template expression doesn't allow AssignmentPattern in arrow function params.",
            start: content.indexOf("list.map"),
            length: "list.map((a = 1) => a)".length,
          },
        ]);
        // the rest of the template is still checked, and the output is still valid
        assert.equal(code(result.text), "(undefined as any);\n$cmp.ok;\n$cmp.next;\n");
      });

      it("spells out shorthand properties, and leaves other property names alone", async () => {
        const result = await convertTemplate(
          `<template><template for:each={rows} for:item="row"><c-a key={row.id} value="{{ a, row, b: c, [d]: e }}"></c-a></template></template>`,
          "./c.js",
        );
        assert.deepEqual(result.diagnostics, []);
        assert.match(code(result.text), /\(\{ a: \$cmp\.a, row, b: \$cmp\.c, \[d\]: \$cmp\.e \}\)/);
      });

      it("binds undefined on its own, as LWC does, but not within an expression", async () => {
        const result = await convertTemplate(`<template><p>{undefined}</p><p>{a ?? undefined}</p></template>`, "./c.js");
        assert.equal(code(result.text), "$cmp.undefined;\n($cmp.a ?? undefined);\n");
      });

      it("maps every piece, and each $cmp. to its expression's brace", async () => {
        const content = '<template><p class="{a ?? b.c}"></p></template>';
        const mapped = mappedText(await convertTemplate(content, "./c.js"), content);
        assert.deepEqual(mapped, [
          ["(", "{"],
          ["$cmp.", "{"],
          ["a ?? ", "a ?? "],
          ["$cmp.", "{"],
          ["b.c", "b.c"],
          [")", "{"],
          ["defaultTemplate", "template"],
        ]);
      });

      for (const [name, newline] of [
        ["LF", "\n"],
        ["CRLF", "\r\n"],
      ] as const) {
        it(`maps expressions in text that spans lines, which the compiler tidies, with ${name}`, async () => {
          const content = [
            "<template>",
            "  <p>",
            "    one {first}",
            "    {second +",
            "       third} {fourth}   ",
            "  </p>",
            "</template>",
          ].join(newline);
          const result = await convertTemplate(content, "./c.js");
          assert.deepEqual(result.diagnostics, []);
          for (const [virtual, original] of mappedText(result, content).slice(0, -1)) {
            assert.equal(
              original.replace(/\s+/g, " "),
              virtual === "$cmp." || virtual === "(" || virtual === ")" ? "{" : virtual.replace(/\s+/g, " "),
            );
          }
          const names = mappedText(result, content).map(([, original]) => original);
          assert.ok(
            ["first", "fourth", "third"].every((text) => names.includes(text)),
            names.join("|"),
          );
        });
      }

      it("treats a quoted binding as a binding", async () => {
        const result = await convertTemplate('<template><c-a b="{c}"></c-a></template>', "./c.js");
        assert.deepEqual(result.diagnostics, []);
        assert.match(result.text, /\(\{ b: \$cmp\.c \}\)/);
      });

      it("reports what the compiler rejects, such as an unquoted complex expression", async () => {
        const result = await convertTemplate("<template><p>{this.a}</p></template>", "./c.js");
        assert.match(result.diagnostics[0]!.message, /`this`/);
      });
    });

    describe("API versions", () => {
      const messages = (result: ConvertedTemplate) => result.diagnostics.map((diagnostic) => diagnostic.message).join("\n");

      it("gates complex expressions by the component's version", async () => {
        const complex = '<template><p class="{a ?? b}">{c + 1}</p></template>';
        assert.deepEqual((await convertTemplate(complex, "./c.js", { apiVersion: 66 })).diagnostics, []);
        assert.deepEqual((await convertTemplate(complex, "./c.js", { apiVersion: 68 })).diagnostics, []);
        assert.deepEqual((await convertTemplate(complex, "./c.js")).diagnostics, []);
        assert.match(messages(await convertTemplate(complex, "./c.js", { apiVersion: 65 })), /LWC1034/);
        const text = "<template><p>{c + 1}</p></template>";
        assert.match(messages(await convertTemplate(text, "./c.js", { apiVersion: 65 })), /LWC1060/);
      });

      it("reports a quoted binding as ambiguous below complex expressions' version", async () => {
        const quoted = '<template><c-a b="{c}"></c-a></template>';
        assert.match(messages(await convertTemplate(quoted, "./c.js", { apiVersion: 62 })), /LWC1034/);
        assert.deepEqual((await convertTemplate(quoted, "./c.js", { apiVersion: 66 })).diagnostics, []);
      });

      it("leaves empty braces in text as text below it", async () => {
        const content = "<template><p>{a} {b.c} {}</p></template>";
        assert.match(messages(await convertTemplate(content, "./c.js", { apiVersion: 66 })), /LWC1083/);
        const result = await convertTemplate(content, "./c.js", { apiVersion: 62 });
        assert.deepEqual(result.diagnostics, []);
        assert.equal(code(result.text), "$cmp.a;\n$cmp.b.c;\n");
        assert.deepEqual(sourcesOf(result, "a"), [content.indexOf("{a}") + 1]);
        assert.deepEqual(sourcesOf(result, "b.c"), [content.indexOf("b.c")]);
      });

      it("maps text across lines and past entities below it", async () => {
        const content = "<template>\n  <p>\n    {a} &amp; {a}\n    {b.c}  \n  </p>\n</template>";
        const result = await convertTemplate(content, "./c.js", { apiVersion: 62 });
        assert.deepEqual(result.diagnostics, []);
        assert.deepEqual(
          sourcesOf(result, "a"),
          offsetsOf(content, "{a}").map((offset) => offset + 1),
        );
        assert.deepEqual(sourcesOf(result, "b.c"), [content.indexOf("b.c")]);
      });

      it("declares a template's slots as its own version parses it", async () => {
        const child = '<template><slot name="footer"></slot><p>{}</p></template>';
        const check = async (apiVersion: number) => (await convertTemplate(child, "./card.js", { apiVersion, module: "c/card" })).text;
        // empty braces are text at 62, so its slots are known
        assert.match(await check(62), /"c\/card footer": true;/);
        // and an error at 66, which leaves them unknown
        assert.match(await check(66), /"c\/card \*": true;/);
      });

      it("declares a bundle's slots under the module other components import it as", async () => {
        const slots = async (bundle: string, projectNamespace?: string) => {
          const [converted] = await convert(
            [
              {
                path: `/lwc/${bundle}/${bundle}.html`,
                type: MetadataType.LightningComponentBundle,
                content: "<template><slot></slot></template>",
              },
            ],
            projectNamespace === undefined ? {} : { projectNamespace },
          );
          return [...converted!.text.matchAll(/^    "(.*)": true;$/gm)].map((m) => m[1]);
        };
        assert.deepEqual(await slots("orders"), ["c/orders", "c/orders (default)"]);
        // the project's own namespace is left out, as LWC imports it as c/; another's is kept
        assert.deepEqual(await slots("acme__orders", "acme"), ["c/orders", "c/orders (default)"]);
        assert.deepEqual(await slots("dlrs__orders", "acme"), ["dlrs/orders", "dlrs/orders (default)"]);
      });

      it("parses a bundle's template at the component's apiVersion, which bundleApiVersion reads from its metadata", async () => {
        const metadata = (version: string) =>
          `<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>${version}</apiVersion></LightningComponentBundle>`;
        const check = async (xml?: string) => {
          const apiVersion = xml === undefined ? undefined : await bundleApiVersion(xml);
          const [converted] = await convert([
            {
              path: "/lwc/orders/orders.html",
              type: MetadataType.LightningComponentBundle,
              content: "<template><p>{a + 1}</p></template>",
              ...(apiVersion !== undefined && { apiVersion }),
            },
          ]);
          return converted!.diagnostics ?? [];
        };
        assert.equal(await bundleApiVersion(metadata("62.0")), 62);
        assert.equal((await check(metadata("62.0"))).length, 1);
        assert.deepEqual(await check(metadata("66.0")), []);
        // the compiler's latest, for one that can't be read
        for (const unreadable of [undefined, "", "<LightningComponentBundle><apiVersion>", metadata("soon")]) {
          if (unreadable !== undefined) {
            assert.equal(await bundleApiVersion(unreadable), undefined, unreadable);
          }
          assert.deepEqual(await check(unreadable), [], String(unreadable));
        }
      });
    });

    describe("dynamic components and lwc:on", () => {
      it("accepts lwc:is and lwc:on, with lwc:component's properties and listeners", async () => {
        const content = `<template>
    <lwc:component lwc:is={ctor} record-id={id} onpick={handlePick}></lwc:component>
    <div lwc:on={listeners}></div>
</template>`;
        const result = await convertTemplate(content, "./c.js");
        assert.deepEqual(result.diagnostics, []);
        const body = code(result.text);
        assert.match(body, /^\$cmp\.id;$/m);
        assert.match(body, /^\[\$cmp\.ctor\] satisfies \[\(new \(\.\.\.args: any\[\]\) => unknown\) \| null \| undefined\];$/m);
        assert.match(body, /^\[\$cmp\.listeners\] satisfies \[Record<string, \(event: any\) => unknown> \| null \| undefined\];$/m);
        assert.match(body, /^\[\$cmp\.handlePick\] satisfies \[\(\.\.\.args: any\[\]\) => unknown\];$/m);
      });

      it("takes a ref on lwc:component as an element nothing describes", async () => {
        const result = await convertTemplate(
          '<template><lwc:component lwc:is={ctor} lwc:ref="dynamic"></lwc:component></template>',
          "./c.js",
        );
        assert.match(result.text, /^    dynamic: HTMLElement & Record<string, any>;$/m);
      });
    });

    describe("tags", () => {
      it("names a component's module as the compiler does", async () => {
        const content = `<template>
    <c-my_thing></c-my_thing>
    <c-a--b></c-a--b>
    <c-foo-1bar></c-foo-1bar>
    <my_ns-card></my_ns-card>
</template>`;
        const result = await convertTemplate(content, "./c.js");
        const modules = [...result.text.matchAll(/typeof import\("(.+?)"\)/g)].map((match) => match[1]);
        assert.deepEqual(modules, ["c/my_thing", "c/aB", "c/foo1bar", "my_ns/card"]);
      });

      it("checks a child whose name has an underscore like any other", async () => {
        const result = await convertTemplate("<template><c-my_thing title={a}></c-my_thing></template>", "./c.js");
        assert.match(result.text, /\(\{ title: \$cmp\.a \}\) satisfies __lwcProperties<InstanceType<__lwcComponent0>>;/);
      });

      it("types a ref on an element by its namespace", async () => {
        const result = await convertTemplate(
          `<template>
    <a lwc:ref="html"></a>
    <svg lwc:ref="svg"><a lwc:ref="svgLink"></a><title lwc:ref="svgTitle"></title></svg>
    <math lwc:ref="math"><mi lwc:ref="mi"></mi></math>
</template>`,
          "./c.js",
        );
        assert.deepEqual(result.diagnostics, []);
        for (const line of [
          'html: __lwcElement<"a">;',
          'svg: __lwcSvgElement<"svg">;',
          'svgLink: __lwcSvgElement<"a">;',
          'svgTitle: __lwcSvgElement<"title">;',
          'math: __lwcMathElement<"math">;',
          'mi: __lwcMathElement<"mi">;',
        ]) {
          assert.ok(result.text.includes(`    ${line}\n`), line);
        }
        const check = `import type {} from "./orders.js";
declare const refs: import("./orders.js").__LwcRefs;
const html: HTMLAnchorElement = refs.html;
const link: SVGAElement = refs.svgLink;
const title: SVGTitleElement = refs.svgTitle;
const math: MathMLElement = refs.mi;
export { html, link, title, math };
`;
        assert.deepEqual(
          checkProject(
            {
              "orders.ts": "export default class Orders {}\n",
              "t.ts": result.text.replaceAll('"./c.js"', '"./orders.js"'),
              "check.ts": check,
            },
            {
              strict: true,
              noEmit: true,
              target: "es2022",
              module: "esnext",
              moduleResolution: "bundler",
              lib: ["es2022", "dom"],
              types: [],
            },
          ),
          [],
        );
      });
    });

    it("checks a scoped slot's fragment against the slot it names", async () => {
      const content = '<template><c-list><template lwc:slot-data="row" slot="item"><p>{row.a}</p></template></c-list></template>';
      const result = await convertTemplate(content, "./c.js");
      assert.match(result.text, /^\["item"\] satisfies \[__lwcSlots<"c\/list">\];$/m);
      const children = await childFiles({
        list: ['<template lwc:render-mode="light"><slot name="other" lwc:slot-bind={x}></slot></template>'],
      });
      assert.match(children["list.template0.ts"]!, /"c\/list other": true;/);
      const errors = checkProject({ ...children, "c.ts": "export default class C {}", "template.ts": result.text }, slotOptions);
      assert.deepEqual(
        errors.filter((error) => error.startsWith("template.ts")).map((error) => error.replace(/^template\.ts:\d+ /, "")),
        [`TS2322: Type '"item"' is not assignable to type '"other"'.`],
      );
    });

    describe("compiled by TypeScript", () => {
      const component = `type Item = { id: string; name: string; children: Item[] };
export default class C {
  items: Item[] = [];
  hidden = false;
  title?: string;
  ctor = C;
  listeners = { click: (event: Event) => event };
  label(item: Item): string { return item.name; }
  handleChange(event: Event): void {}
}
`;
      /** Compiles a template of the component in c.ts, returning TypeScript's errors. */
      const check = async (content: string) => {
        const result = await convertTemplate(content, "./c.js");
        assert.deepEqual(result.diagnostics, []);
        return checkProject(
          { "c.ts": component, "template.ts": result.text },
          { strict: true, noEmit: true, target: "es2022", module: "esnext", moduleResolution: "bundler", lib: ["es2022", "dom"] },
        );
      };

      it("accepts a template that matches its component", async () => {
        const errors = await check(`<template>
    <template if:false={hidden}><p title={title}>{title}</p></template>
    <template for:each={items} for:item="item" for:index="i">
        <div key={item.id} onclick={handleChange}>
            <template for:each={item.children} for:item="item"><span key={item.id}>{item.name} {i}</span></template>
            <template iterator:it={item.children}><b key={it.value.id}>{it.first} {it.index} {it.value.name}</b></template>
        </div>
    </template>
</template>`);
        assert.deepEqual(errors, []);
      });

      it("accepts refs and handlers on base components with and without methods and events", async () => {
        const errors = await check(`<template>
    <lightning-button lwc:ref="button" label={title} onclick={handleChange}></lightning-button>
    <lightning-input lwc:ref="field" onchange={handleChange}></lightning-input>
</template>`);
        assert.deepEqual(errors, []);
      });

      it("references an installed package's component by its tag, reporting one the project doesn't have, and leaves its shape open", async () => {
        const options = {
          strict: true,
          noEmit: true,
          target: "es2022",
          module: "esnext",
          moduleResolution: "bundler",
          lib: ["es2022", "dom"],
          paths: { "dlrs/*": ["./dlrs/*.ts"] },
        };
        // a cached stub: the package's source is hidden, so only what its target configs name is known
        const stub = "export default class ManageRollups { recordId?: string; }";
        const source = `<template>
    <dlrs-manage-rollups lwc:ref="rollups" record-id={title} unknown-property={hidden} onanything={handleChange}>
        <span slot="nowhere"></span>
    </dlrs-manage-rollups>
    <dlrs-manage-rollups record-id={missing}></dlrs-manage-rollups>
    <dlrs-manage-rolups></dlrs-manage-rolups>
    <lightningsnapin-minimized></lightningsnapin-minimized>
    <acme-own-card></acme-own-card>
</template>`;
        const result = await convertTemplate(source, "./c.js", { projectNamespace: "acme" });
        assert.deepEqual(result.diagnostics, []);
        assert.match(result.text, /type __lwcComponent0 = typeof import\("dlrs\/manageRollups"\)\.default;/);
        assert.match(result.text, /HTMLElement & InstanceType<__lwcComponent0> & Record<string, any>/);
        assert.doesNotMatch(result.text, /lightningsnapin\/|acme\//);
        const errors = checkProject({ "c.ts": component, "template.ts": result.text, "dlrs/manageRollups.ts": stub }, options);
        assert.deepEqual(errors, [
          // the values are the template's own component's members, which are checked
          "template.ts:6 TS2339: Property 'missing' does not exist on type 'C'.",
          // a misspelt or uncached component is reported on its tag
          "template.ts:8 TS2307: Cannot find module 'dlrs/manageRolups' or its corresponding type declarations.",
        ]);
        // which TypeScript shows on the tag: the module's name maps to it
        assert.ok(
          mappedText(result, source).some(([virtual, original]) => virtual === '"dlrs/manageRolups"' && original === "dlrs-manage-rolups"),
        );
      });

      it("declares only the helpers a template uses, after its code, once each", async () => {
        const strict = {
          strict: true,
          noEmit: true,
          target: "es2022",
          module: "esnext",
          moduleResolution: "bundler",
          lib: ["es2022", "dom"],
          noUnusedLocals: true,
          noUnusedParameters: true,
          paths: { "c/*": ["./*.ts"] },
        };
        const declared = (text: string) => Object.keys(TEMPLATE_HELPERS).filter((name) => text.includes(TEMPLATE_HELPERS[name]!));

        const plain = await convertTemplate("<template><p>{title}</p></template>", "./c.js");
        assert.deepEqual(declared(plain.text), []);
        assert.equal(
          plain.text,
          `import type __Component from "./c.js";\ndeclare const $cmp: InstanceType<typeof __Component>;\n$cmp.title;\n${TEMPLATE_EXPORT}`,
        );
        // the test component's own unused parameters aren't the template's
        const templateErrors = (files: Record<string, string>) => checkProject(files, strict).filter((error) => !error.startsWith("c.ts"));
        assert.deepEqual(templateErrors({ "c.ts": component, "template.ts": plain.text }), []);

        // every helper, from a template that needs each of them
        const all = await convertTemplate(
          `<template>
    <template for:each={items} for:item="item"><p key={item.id} onclick={handleChange}>{item.name}</p></template>
    <template iterator:it={items}><b key={it.value.id}></b></template>
    <input lwc:ref="search" />
    <svg lwc:ref="drawing"></svg>
    <math lwc:ref="formula"></math>
    <c-card title={title} onpick={handleChange}><span slot="footer"></span></c-card>
    <lightning-button label={title}></lightning-button>
</template>`,
          "./c.js",
        );
        assert.deepEqual(declared(all.text), Object.keys(TEMPLATE_HELPERS));
        for (const declaration of Object.values(TEMPLATE_HELPERS)) {
          assert.equal(all.text.split(declaration).length, 2, declaration);
        }
        // after the code, which only the helpers follow
        assert.ok(all.text.indexOf(TEMPLATE_HELPERS.__lwcElement!) > all.text.lastIndexOf("$cmp."));
        const card = "export default class Card { id = ''; title?: string; }";
        assert.deepEqual(templateErrors({ "c.ts": component, "template.ts": all.text, "card.ts": card }), []);
        // and the child's types are checked: its properties
        assert.notDeepEqual(
          templateErrors({ "c.ts": component, "template.ts": all.text, "card.ts": "export default class Card { id = 0; }" }),
          [],
        );
      });

      it("accepts complex expressions that match the component", async () => {
        const errors = await check(`<template>
    <p class="{title ?? 'none'}">{items.length + 1} {hidden ? 'a' : title}</p>
    <template lwc:if="{title && !hidden}"><p>{title.length}</p></template>
    <template for:each="{items ?? []}" for:item="item"><span key="{item.id + 'x'}">{label(item)}</span></template>
    <template for:each="{[1, 2]}" for:item="n"><span key={n}>{n}</span></template>
    <button onclick="{(event) => handleChange(event)}"></button>
    <p class="{items.map((item) => item.name).join(' ')}"></p>
</template>`);
        assert.deepEqual(errors, []);
      });

      it("checks what complex expressions use", async () => {
        const errors = await check(`<template>
    <p>{missing ?? title}</p>
    <p>{label(title)}</p>
    <p>{items.map((item) => item.nope)}</p>
    <template for:each="{hidden && hidden}" for:item="x"><b key={x}></b></template>
    <button onclick="{(event) => handleMissing(event)}"></button>
    <button onclick="{title ?? hidden}"></button>
</template>`);
        const expected = [
          /'missing' does not exist/,
          /'string \| undefined' is not assignable/,
          /'nope' does not exist on type 'Item'/,
          /iterator|iterable/,
          /'handleMissing' does not exist/,
          /is not assignable|does not satisfy/,
        ];
        assert.equal(errors.length, expected.length, errors.join("\n"));
        expected.forEach((pattern, i) => assert.match(errors[i]!, pattern));
      });

      it("narrows inside a complex condition", async () => {
        assert.deepEqual(await check('<template><template lwc:if="{title && !hidden}">{title.length}</template></template>'), []);
        const errors = await check('<template><template lwc:if="{hidden || !hidden}">{title.length}</template></template>');
        assert.match(errors.join("\n"), /possibly 'undefined'/);
      });

      it("checks lwc:is and lwc:on", async () => {
        assert.deepEqual(
          await check("<template><lwc:component lwc:is={ctor}></lwc:component><div lwc:on={listeners}></div></template>"),
          [],
        );
        const errors = await check("<template><lwc:component lwc:is={title}></lwc:component><div lwc:on={title}></div></template>");
        assert.equal(errors.length, 2, errors.join("\n"));
      });

      it("rejects bindings the component doesn't have", async () => {
        const errors = await check(`<template>
    <p>{missing}</p>
    <template for:each={items} for:item="item"><span key={item.id}>{item.nope}</span></template>
</template>`);
        assert.equal(errors.length, 2, errors.join("\n"));
        assert.match(errors[0]!, /Property 'missing' does not exist/);
        assert.match(errors[1]!, /Property 'nope' does not exist on type 'Item'/);
      });
    });
  });
});
