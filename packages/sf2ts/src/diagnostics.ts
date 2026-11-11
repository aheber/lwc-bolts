import type { Component, ConvertedComponent } from "./types.ts";

/**
 * A file that couldn't be converted: empty output, and a `ConversionFailed` diagnostic covering the file.
 */
export function conversionFailed(component: Component, error: unknown): ConvertedComponent {
  return {
    ...component,
    text: "",
    mapData: [],
    diagnostics: [
      {
        kind: "ConversionFailed",
        message: `Unable to convert ${component.type} to TypeScript: ${error instanceof Error ? error.message : String(error)}`,
        start: 0,
        length: component.content.length,
      },
    ],
  };
}
