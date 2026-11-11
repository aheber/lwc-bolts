import type { Parser } from "web-tree-sitter-sfapex";
import { getApexParser } from "web-tree-sitter-sfapex";
import { convertApexFile } from "../apex/file.ts";
import type { ConversionContext } from "../context.ts";
import { importNameParts, metadataName } from "../names.ts";
import type { ApexClassComponent, ConversionOutput } from "../types.ts";

let apexParser: Promise<Parser> | undefined;

/**
 * Converts an Apex class. The Apex parser loads on the first class (reading its WebAssembly from disk),
 * once: concurrent conversions share the load, and later ones reuse the parser.
 */
export async function ApexClass(comp: ApexClassComponent, context: ConversionContext): Promise<ConversionOutput> {
  apexParser ??= getApexParser();
  const prsr = await apexParser;

  const isSobject = comp.isSobject === true;
  return (
    convertApexFile(prsr, comp.content, {
      isSobject,
      apexNamespace: context.apexNamespace,
      projectNamespace: context.projectNamespace,
      // a class of another namespace (an installed package's) is named for it, as `dlrs__RollupController.cls`;
      // an SObject definition's name is its object's
      packageNamespace: isSobject ? undefined : importNameParts(metadataName(comp.path), context.projectNamespace).namespace,
      polymorphicTargets: new Map(
        Object.entries(isSobject ? (comp.polymorphicTargets ?? {}) : {}).map(([name, targets]) => [name.toLowerCase(), targets]),
      ),
      inaccessibleProperties: context.inaccessibleApexProperties,
    }) ?? { text: "", mapData: [] }
  );
}
