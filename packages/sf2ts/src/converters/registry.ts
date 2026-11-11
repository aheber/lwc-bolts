import type { ConversionContext } from "../context.ts";
import type { Component, ConversionOutput, MetadataType } from "../types.ts";

/** Converts a component of one type, or of any (`Component`). */
export type Converter<C extends Component = Component> = (
  component: C,
  context: ConversionContext,
) => ConversionOutput | Promise<ConversionOutput>;

/**
 * Each metadata type's converter, loaded on its first conversion, so importing sf2ts doesn't load what
 * converting other types needs (the Apex parser, the template converter and its compiler, an XML
 * parser). Node caches each module after its first import. It has a converter for each `MetadataType`,
 * which `MetadataType`'s values are made from.
 */
export const converters = {
  ApexClass: async () => (await import("./apex-class.ts")).ApexClass,
  ContentAsset: async () => (await import("./content-asset.ts")).ContentAsset,
  CustomField: async () => (await import("./custom-field.ts")).CustomField,
  CustomLabel: async () => (await import("./custom-label.ts")).CustomLabel,
  CustomLabels: async () => (await import("./custom-labels.ts")).CustomLabels,
  CustomObject: async () => (await import("./custom-object.ts")).CustomObject,
  CustomPermission: async () => (await import("./custom-permission.ts")).CustomPermission,
  LightningComponentBundle: async () => (await import("./lightning-component-bundle.ts")).LightningComponentBundle,
  LightningMessageChannel: async () => (await import("./lightning-message-channel.ts")).LightningMessageChannel,
  StaticResource: async () => (await import("./static-resource.ts")).StaticResource,
} satisfies { [Type in MetadataType]: () => Promise<Converter<Component & { type: Type }>> };
