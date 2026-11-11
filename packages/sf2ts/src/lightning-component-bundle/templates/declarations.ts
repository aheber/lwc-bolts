// What a template declares after its code: the types of the components it uses, and its `lwc:ref`s.
import type { LightningComponent } from "@lwc-bolts/lightning-base-components";
import { MapFeature } from "../../text-builder.ts";
import type { BaseElement } from "./ast.ts";
import { baseComponentTypes } from "./base-components.ts";
import type { Writer } from "./writer.ts";

/** The type aliases of the components a template uses, each declared once. */
export class ComponentTypes {
  /** Child components by module name, with where the first tag is. */
  readonly #components = new Map<string, { alias: string; position: number; length: number }>();
  /** Base components by tag. */
  readonly #lightning = new Map<string, string>();
  readonly #baseComponents: Readonly<Record<string, LightningComponent>>;

  constructor(baseComponents: Readonly<Record<string, LightningComponent>>) {
    this.#baseComponents = baseComponents;
  }

  /** The alias of a child component's class: `module` is its module, such as `c/baseCard` or an installed package's `dlrs/manageRollups`. */
  component(module: string, node: BaseElement): string {
    let component = this.#components.get(module);
    if (component === undefined) {
      // the tag's name, after its `<`, so a component that doesn't exist is reported on the tag
      component = { alias: `__lwcComponent${this.#components.size}`, position: node.location.start + 1, length: node.name.length };
      this.#components.set(module, component);
    }
    return component.alias;
  }

  /** The alias of a base component's properties. */
  base(tag: string): string {
    let alias = this.#lightning.get(tag);
    if (alias === undefined) {
      alias = `__lwcLightning${this.#lightning.size}`;
      this.#lightning.set(tag, alias);
    }
    return alias;
  }

  /**
   * Declares the aliases. A tag maps to both the module, so a component that doesn't exist is reported on
   * it and hovering it shows the component's label, and its default export, so go-to-definition opens the
   * class rather than the module's .js-meta.xml.
   */
  write(out: Writer): void {
    for (const [module, { alias, position, length }] of this.#components) {
      out.write(`type ${alias} = typeof import(`);
      out.writeAt(JSON.stringify(module), position, length, MapFeature.All & ~MapFeature.Definition);
      out.write(").");
      out.writeAt("default", position, length, MapFeature.Definition);
      out.write(";\n");
    }
    for (const [tag, alias] of this.#lightning) {
      out.write(baseComponentTypes(alias, this.#baseComponents[tag]!));
    }
  }
}

/** `lwc:ref` names, with the types of the elements they name and where the template names them. */
export class TemplateRefs {
  readonly #refs = new Map<string, { types: Set<string>; optional: boolean; position: number | undefined }>();

  add(name: string, type: string, optional: boolean, position: number | undefined): void {
    const ref = this.#refs.get(name) ?? { types: new Set<string>(), optional: false, position };
    ref.types.add(type);
    ref.optional ||= optional;
    this.#refs.set(name, ref);
  }

  /**
   * Augments the component's module so `this.refs` has them. Every template of a bundle declares the same
   * `refs` type, over the `__LwcRefs` interface that each adds its own refs to, so a bundle's templates
   * don't conflict. It's a mapped type over the interface, since `LightningElement`'s `refs` has an index
   * signature, which an object type satisfies and an interface doesn't.
   */
  write(out: Writer, componentModule: string): void {
    if (this.#refs.size === 0) {
      return;
    }
    out.write(`declare module ${JSON.stringify(componentModule)} {
  export default interface __LwcTemplate {
    refs: { [K in keyof __LwcRefs]: __LwcRefs[K] } | undefined;
  }
  export interface __LwcRefs {
`);
    for (const [name, { types, optional, position }] of this.#refs) {
      out.write("    ");
      out.writeAt(name, position, name.length);
      out.write(`${optional ? "?" : ""}: ${[...types].join(" | ")};\n`);
    }
    out.write("  }\n}\n");
  }
}
