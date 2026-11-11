import type { ConversionOutput, MapPair } from "./types.ts";

/**
 * TypeScript `SpanMapFeature` flags, for a mapped piece that only takes part in some editor features.
 * Diagnostics aren't a feature: they're mapped whatever a piece's features are.
 */
export const MapFeature = {
  Definition: 8,
  All: 1048575,
} as const;

/** A piece of a component's source, from `start` up to `end`, as UTF-16 offsets. */
export interface SourceRange {
  start: number;
  end: number;
}

/**
 * Builds generated text, recording which pieces of it came from which source text: each mapped piece is
 * a pair of `MapPair`s, its start and its end. Unmapped text isn't recorded.
 */
export class TextBuilder {
  #text = "";
  readonly #mapData: MapPair[] = [];

  /** The text written so far. */
  get text(): string {
    return this.#text;
  }

  /** The mapped pieces of the text written so far. */
  get mapData(): MapPair[] {
    return this.#mapData;
  }

  /** The text written and its mapped pieces, as a converter returns them. */
  output(): ConversionOutput {
    return { text: this.#text, mapData: this.#mapData };
  }

  /**
   * Writes text, mapped to the source from `sourceStart` to `sourceEnd` when both are given, for the
   * editor `features` given (see `MapFeature`), or for all of them.
   */
  write(text: string, sourceStart?: number, sourceEnd?: number, features?: number): void {
    if (sourceStart !== undefined && sourceEnd !== undefined) {
      this.#mapData.push({ sourcePos: sourceStart, destPos: this.#text.length, ...(features !== undefined && { features }) });
      this.#text += text;
      this.#mapData.push({ sourcePos: sourceEnd, destPos: this.#text.length });
    } else {
      this.#text += text;
    }
  }

  /** Writes text mapped to `range` in the source, or unmapped text when the source has no such range. */
  writeMapped(text: string, range: SourceRange | null | undefined): void {
    this.write(text, range?.start, range?.end);
  }
}
