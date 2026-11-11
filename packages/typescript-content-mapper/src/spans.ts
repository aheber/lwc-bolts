import type { MapPair } from "@lwc-bolts/sf2ts";
import { SpanMapKind, type PositionEncoding, type SpanMapping } from "./protocol.ts";

/**
 * Converts sf2ts `MapPair`s into protocol span mappings.
 *
 * sf2ts records each mapped piece of text as two consecutive pairs: the start positions followed by the
 * end positions (UTF-16 offsets), with the editor features the piece takes part in, if not all of them, on
 * its start. TypeScript rejects the whole transform if any span is invalid, so spans
 * that are out of bounds, inverted, overlap in the virtual text, or partially overlap another span in the
 * original text are dropped instead of being passed through.
 */
export function toSpanMappings(mapData: readonly MapPair[], virtual: string, original: string): SpanMapping[] {
  const spans: SpanMapping[] = [];
  for (let i = 0; i + 1 < mapData.length; i += 2) {
    const start = mapData[i]!;
    const end = mapData[i + 1]!;
    const virtualStart = start.destPos;
    const virtualEnd = end.destPos;
    const originalStart = start.sourcePos;
    const originalEnd = end.sourcePos;
    if (!inBounds(virtualStart, virtualEnd, virtual.length) || !inBounds(originalStart, originalEnd, original.length)) {
      continue;
    }
    const kind = spanKind(virtual.slice(virtualStart, virtualEnd), original.slice(originalStart, originalEnd));
    const span: SpanMapping = [virtualStart, virtualEnd - virtualStart, originalStart, originalEnd - originalStart, kind];
    if (start.features !== undefined) {
      span.push(start.features);
    }
    spans.push(span);
  }
  return dropOriginalOverlaps(dropVirtualOverlaps(spans));
}

/**
 * Identical text is `Verbatim`. A span whose original is an API name that the virtual text is built from
 * (`lblAustralia` and `"@salesforce/label/c.Australia"` from `Australia`, `Apex.Widget` from `Widget`,
 * `string` from `String`) is an `Alias`, so TypeScript shows the Salesforce name in diagnostics that
 * cover the whole span. Anything else, such as a name mapped to a label or description
 * (`hasTestPerm` from "Can do cool stuff!") or a type expression (`Apex.Account[]` from `List<Account>`),
 * is an `Atom`.
 */
export function spanKind(virtual: string, original: string): SpanMapKind {
  if (virtual === original) {
    return SpanMapKind.Verbatim;
  }
  const isApiName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(original);
  return isApiName && virtual.toLowerCase().includes(original.toLowerCase()) ? SpanMapKind.Alias : SpanMapKind.Atom;
}

function inBounds(start: number, end: number, length: number): boolean {
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= length;
}

function dropVirtualOverlaps(spans: SpanMapping[]): SpanMapping[] {
  const sorted = spans.toSorted((a, b) => a[0] - b[0]);
  const result: SpanMapping[] = [];
  let previousEnd = 0;
  for (const span of sorted) {
    if (span[0] < previousEnd) {
      continue;
    }
    result.push(span);
    previousEnd = span[0] + span[1];
  }
  return result;
}

/** Original ranges may be shared by several spans, but must otherwise not overlap. */
function dropOriginalOverlaps(spans: SpanMapping[]): SpanMapping[] {
  const byOriginal = spans.toSorted((a, b) => a[2] - b[2] || a[3] - b[3]);
  const keep = new Set<SpanMapping>();
  let groupStart = -1;
  let groupEnd = 0;
  for (const span of byOriginal) {
    const start = span[2];
    const end = start + span[3];
    if (start === groupStart && end === groupEnd) {
      keep.add(span);
    } else if (start >= groupEnd) {
      keep.add(span);
      groupStart = start;
      groupEnd = end;
    }
  }
  return spans.filter((span) => keep.has(span));
}

/** Re-expresses UTF-16 span mappings in the requested position encoding. */
export function encodeSpanMappings(spans: SpanMapping[], virtual: string, original: string, encoding: PositionEncoding): SpanMapping[] {
  if (encoding === "utf-16") {
    return spans;
  }
  const v = utf8Offsets(virtual);
  const o = utf8Offsets(original);
  return spans.map(([vs, vl, os, ol, ...rest]) => [v(vs), v(vs + vl) - v(vs), o(os), o(os + ol) - o(os), ...rest]);
}

/** Returns a function converting UTF-16 offsets in `text` to UTF-8 byte offsets. */
export function utf8Offsets(text: string): (utf16Offset: number) => number {
  const prefix = new Uint32Array(text.length + 1);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // A surrogate pair is 4 UTF-8 bytes, split as 2 + 2 across its two UTF-16 units.
    const bytes = code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdfff ? 2 : 3;
    prefix[i + 1] = prefix[i]! + bytes;
  }
  return (offset) => prefix[offset]!;
}
