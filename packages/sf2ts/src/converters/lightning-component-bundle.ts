import type { ConversionContext } from "../context.ts";
import type { ConversionOutput, LightningComponentBundleComponent } from "../types.ts";

type BundleFileConverter = (
  component: LightningComponentBundleComponent,
  context: ConversionContext,
) => ConversionOutput | Promise<ConversionOutput>;

/**
 * The files of a Lightning web component's bundle that sf2ts converts, each by a converter of its own,
 * loaded on its first file.
 */
const BUNDLE_FILES: readonly { description: string; pattern: RegExp; load: () => Promise<BundleFileConverter> }[] = [
  {
    // create the `c/<name>` module which re-exports the component exports
    description: "<name>.js-meta.xml",
    pattern: /\.js-meta\.xml$/i,
    load: async () => (await import("../lightning-component-bundle/metadata.ts")).convertBundleMetadata,
  },
  {
    // create modules from the template files so imports and references can go both directions
    description: ".html templates",
    pattern: /\.html$/i,
    load: async () => (await import("../lightning-component-bundle/templates/template.ts")).convertBundleTemplate,
  },
];

/**
 * Converts a file of a Lightning web component's bundle with the converter for its kind (see
 * `BUNDLE_FILES`). Any other file of the bundle, such as its JavaScript or CSS, gets a diagnostic.
 */
export async function LightningComponentBundle(
  component: LightningComponentBundleComponent,
  context: ConversionContext,
): Promise<ConversionOutput> {
  const file = BUNDLE_FILES.find(({ pattern }) => pattern.test(component.path));
  if (file === undefined) {
    const fileName = component.path.split(/[\\/]/).pop();
    throw new Error(
      `${fileName} isn't a bundle file sf2ts converts; it converts a bundle's ${BUNDLE_FILES.map(({ description }) => description).join(" and ")}`,
    );
  }
  const convert = await file.load();
  return convert(component, context);
}
