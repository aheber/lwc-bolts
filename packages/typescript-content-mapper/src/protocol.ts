// Types for the TypeScript content mapper protocol.
// See https://github.com/microsoft/typescript-go/pull/4712 for the full description.
import type { OptionDiagnostic } from "./options.ts";

export type PositionEncoding = "utf-8" | "utf-16";

export interface InitializeParams {
  /** Protocol version spoken by the host, when it sends one. */
  protocolVersion?: number;
  /** The position encodings supported by TypeScript. The mapper must choose one of these encodings. */
  positionEncodings: PositionEncoding[];
  /** BCP 47 locale requested for diagnostics. */
  locale?: string;
}

export interface InitializeResult {
  protocolVersion?: number;
  /** The position encoding the mapper will use for all span mapping positions and diagnostic positions. */
  positionEncoding: PositionEncoding;
  /** The source identifier displayed for mapper-produced diagnostics. */
  diagnosticSource: string;
}

export interface OpenProjectParams {
  /** Absolute tsconfig path, or an empty string for a project without a config file. */
  configFileName: string;
  /** Opaque process-local handle assigned by TypeScript. */
  projectHandle: string;
  /** Object from the contentMappers entry, when specified. */
  options?: Record<string, unknown>;
  /** The project's effective compiler options. */
  compilerOptions: Record<string, unknown>;
}

export interface OpenProjectResult {
  /** Stable fingerprint of all dynamically discovered configuration that can affect transforms. */
  configIdentity?: string;
  /** Absolute file names whose changes may alter configIdentity or transform output. */
  watchedFiles?: string[];
  /** Diagnostics for invalid values in this mapper's contentMappers options object. */
  optionDiagnostics?: OptionDiagnostic[];
}

export type { OptionDiagnostic };

export interface TransformParams {
  fileName: string;
  /** Original content of the file to be transformed. */
  content: string;
  /** Project handle supplied in openProject. */
  projectHandle: string;
}

export type VirtualExtension = ".js" | ".jsx" | ".mjs" | ".cjs" | ".ts" | ".tsx" | ".mts" | ".cts" | ".json";

export interface MappedOutput {
  /** Valid JS, JSX, TS, TSX, or JSON text that TypeScript can parse. */
  text: string;
  /** The virtual file extension that determines how TypeScript parses this output. */
  extension: VirtualExtension;
  /** Mappings between the original and transformed content. */
  mappings: SpanMapping[];
  /** Framework-specific directives that suppress TypeScript diagnostics in virtual ranges. */
  diagnosticDirectives?: DiagnosticDirectives;
}

export interface TransformResult extends MappedOutput {
  /** Errors in the original content. */
  diagnostics?: MapperDiagnostic[];
}

export interface CloseProjectParams {
  projectHandle: string;
}

/** Positions and lengths are in the selected `positionEncoding`. */
export type SpanMapping = [
  virtualStart: number,
  virtualLength: number,
  originalStart: number,
  originalLength: number,
  kind: SpanMapKind,
  features?: number,
];

export const SpanMapKind = {
  /** Same length and content in virtual and original text. */
  Verbatim: 0,
  /** Corresponding spans that may differ in length and content. */
  Atom: 1,
  /** Like Atom, but diagnostics display the original text. */
  Alias: 2,
} as const;

export type SpanMapKind = (typeof SpanMapKind)[keyof typeof SpanMapKind];

export interface DiagnosticDirectives {
  directives: MappedDiagnosticDirective[];
  /** Diagnostics reported for `Expect` directives that suppress nothing, referenced by index from the directives. */
  unusedExpectDirectiveDiagnostics: UnusedExpectDirectiveDiagnostic[];
}

/**
 * Suppresses TypeScript's bind and check diagnostics in a range of the virtual text, by `policy`. Positions
 * and lengths are in the selected `positionEncoding`.
 */
export type MappedDiagnosticDirective = [
  originalStart: number,
  originalLength: number,
  virtualStart: number,
  virtualEnd: number,
  policy: DiagnosticDirectivePolicy,
  unusedExpectDirectiveIndex?: number,
];

export const DiagnosticDirectivePolicy = {
  /** Like `// @ts-ignore`: suppresses the range's diagnostics. */
  Ignore: 0,
  /** Like `// @ts-expect-error`: suppresses them, and reports the directive when there are none. */
  Expect: 1,
} as const;

export type DiagnosticDirectivePolicy = (typeof DiagnosticDirectivePolicy)[keyof typeof DiagnosticDirectivePolicy];

export interface UnusedExpectDirectiveDiagnostic {
  code: number;
  messageText: string;
}

/** Start and length are in the selected `positionEncoding`. */
export interface MapperDiagnostic {
  messageText: string;
  start: number;
  length: number;
  code: number;
}
