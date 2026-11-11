import { conversionContext, type ConversionContext } from "./context.ts";
import { converters, type Converter } from "./converters/registry.ts";
import { conversionFailed } from "./diagnostics.ts";
import type { Component, ConvertedComponent, ConvertOptions, MetadataType as MetadataTypeName } from "./types.ts";

export type {
  ApexClassComponent,
  Component,
  ConvertedComponent,
  ConvertOptions,
  Diagnostic,
  InaccessibleApexProperties,
  LightningComponentBundleComponent,
  MapPair,
  MetadataComponent,
} from "./types.ts";

export type MetadataType = MetadataTypeName;

export const MetadataType = Object.freeze(
  Object.fromEntries(Object.keys(converters).map((type) => [type, type])) as { [Type in MetadataType]: Type },
);

/**
 * Converts components to TypeScript: metadata to declarations, and templates to TypeScript that checks
 * them. A file that can't be converted gets a `ConversionFailed` diagnostic and empty output rather than
 * failing the others; invalid options (a namespace that can't be declared) reject. Each type's converter
 * are lazy loaded.
 */
export async function convert(components: Component[], options?: ConvertOptions): Promise<ConvertedComponent[]> {
  // an async function, so invalid options reject rather than throw
  const context = conversionContext(options);
  return Promise.all(components.map((component) => convertOne(component, context)));
}

async function convertOne(component: Component, context: ConversionContext): Promise<ConvertedComponent> {
  try {
    const loadConverter = Object.hasOwn(converters, component.type) ? converters[component.type] : undefined;
    if (loadConverter === undefined) {
      throw new Error(`unsupported metadata type ${component.type}; supported types are ${Object.keys(converters).join(", ")}`);
    }
    // each type's converter takes that type's component, which `component.type` says this is
    const converter = (await loadConverter()) as Converter;
    // use destructing to strip text, mapData, and diagnostics if present, leaving everything else as "input"
    const { text: _text, mapData: _mapData, diagnostics: _diagnostics, ...input } = component as Partial<ConvertedComponent> & Component;
    return { ...input, ...(await converter(component, context)) };
  } catch (error) {
    return conversionFailed(component, error);
  }
}

/**
 * A Lightning web component bundle's API version, from the content of its `.js-meta.xml`, or undefined when
 * it has none that can be read (such as one being written): a template's `apiVersion`. It loads the XML
 * parser on its first call.
 */
export async function bundleApiVersion(metadata: string): Promise<number | undefined> {
  return (await import("./lightning-component-bundle/metadata.ts")).bundleApiVersion(metadata);
}

/**
 * The name of a component module's default export, from its JavaScript or TypeScript source, or undefined
 * when it has no named one (or doesn't parse): a `.js-meta.xml`'s `defaultExportName`. It loads the
 * JavaScript parser on its first call.
 */
export async function defaultExportName(source: string): Promise<string | undefined> {
  return (await import("./lightning-component-bundle/metadata.ts")).findDefaultExportName(source);
}
