import { convert, type Component, type ConvertOptions } from "@lwc-bolts/sf2ts";
import { encodeSpanMappings, toSpanMappings, utf8Offsets } from "./spans.ts";
import { DiagnosticDirectivePolicy, type MapperDiagnostic, type PositionEncoding, type TransformResult } from "./protocol.ts";

/** Converts components to TypeScript: sf2ts's `convert`, or a stand-in that records what it's asked to convert. */
export type Convert = typeof convert;

/** Diagnostic codes reported by this mapper (displayed with the `lwc-bolts` source), by sf2ts's kinds. */
export const DiagnosticCode = {
  /** A file sf2ts couldn't convert, reported on the whole file. */
  ConversionFailed: 1001,
  /** An error the LWC template compiler reports in a template. */
  TemplateError: 1002,
} as const;

/** A file this mapper has nothing to say about: valid, empty TypeScript. */
export function emptyResult(): TransformResult {
  return { text: "", extension: ".ts", mappings: [] };
}

/**
 * Converts one file with sf2ts. Metadata becomes a global script (`.ts` with no imports or exports), so
 * its `declare module "@salesforce/..."` blocks become ambient modules that LWC code can import. A
 * template becomes a module that imports its component and uses it the way the template does, so
 * TypeScript checks the template. What sf2ts reports (a file it couldn't convert, the template
 * compiler's errors) becomes the result's diagnostics.
 */
export async function transformComponent(
  component: Component,
  encoding: PositionEncoding,
  options: ConvertOptions = {},
  convertComponents: Convert = convert,
): Promise<TransformResult> {
  const [converted] = await convertComponents([component], options);
  const { content } = component;
  const { text, mapData, diagnostics = [] } = converted!;
  const offset = encoding === "utf-8" ? utf8Offsets(content) : (position: number) => position;
  const errors: MapperDiagnostic[] = diagnostics.map(({ kind, message, start, length }) => ({
    messageText: message,
    start: offset(start),
    length: offset(start + length) - offset(start),
    code: DiagnosticCode[kind],
  }));
  const mappings = encodeSpanMappings(toSpanMappings(mapData, text, content), text, content, encoding);
  return { text, extension: ".ts", mappings, ...(errors.length > 0 && { diagnostics: errors }) };
}

/**
 * Suppresses TypeScript's diagnostics in the whole of a transform's output, with an `Ignore` directive
 * covering the original content. The mapper's own diagnostics (`result.diagnostics`) still show.
 */
export function ignoreDiagnostics(result: TransformResult, original: string, encoding: PositionEncoding): TransformResult {
  if (result.text === "") {
    return result;
  }
  const length = (text: string) => (encoding === "utf-8" ? utf8Offsets(text)(text.length) : text.length);
  return {
    ...result,
    diagnosticDirectives: {
      directives: [[0, length(original), 0, length(result.text), DiagnosticDirectivePolicy.Ignore]],
      unusedExpectDirectiveDiagnostics: [],
    },
  };
}
