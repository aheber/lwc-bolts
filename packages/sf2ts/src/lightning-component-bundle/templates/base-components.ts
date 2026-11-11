// The types a template's TypeScript declares for the `lightning-*` base components it uses, from their
// definitions in @lwc-bolts/lightning-base-components.
import type { LightningComponent, LightningMember } from "@lwc-bolts/lightning-base-components";

/**
 * A base component's types, named after `alias`: its properties (`<alias>`, with the host element's),
 * and when it has any, its methods (`<alias>Methods`, which refs use).
 */
export function baseComponentTypes(alias: string, component: LightningComponent): string {
  const members = (record: Readonly<Record<string, LightningMember>>, optional: boolean) =>
    Object.entries(record)
      .map(([name, { type, description }]) => {
        const doc = description ? `  /** ${description.replace(/\*\//g, "*\\/")} */\n` : "";
        return `${doc}  ${JSON.stringify(name)}${optional ? "?" : ""}: ${type};\n`;
      })
      .join("");
  let types = `type ${alias} = {\n${members(component.properties, true)}} & __lwcHostProperties;\n`;
  if (Object.keys(component.methods).length > 0) {
    types += `type ${alias}Methods = {\n${members(component.methods, false)}};\n`;
  }
  return types;
}
