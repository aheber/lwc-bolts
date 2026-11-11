// Finding pieces of a template in its source. The compiler locates whole attributes and whole runs of
// text, so what's inside them is found here, and nowhere else.
import type { SourceLocation, TemplateExpression } from "./ast.ts";

/** An expression's place in the template. */
export interface ExpressionOrigin {
  /** The `{` of the expression, which `$cmp.` maps to, so a problem with a whole expression starts there. */
  brace: number;
  /** The template offset of one of the offsets the expression's nodes have. */
  at(offset: number): number;
}

/** How far a run of text has been read: in the template, and in the compiler's tidied text. */
interface TextCursor {
  source: number;
  tidied: number;
}

/** How a template was parsed, which changes what the compiler says about it. */
export interface TemplateSourceOptions {
  /** Whether it was parsed with complex expressions, which changes how it renders. */
  complexExpressions: boolean;
}

export class TemplateSource {
  readonly text: string;
  readonly #options: TemplateSourceOptions;
  /** Text nodes in a run of text share its location, so each is found after the previous, by the run's start. */
  readonly #cursors = new Map<number, TextCursor>();

  constructor(text: string, options: TemplateSourceOptions) {
    this.text = text;
    this.#options = options;
  }

  /** The expression in an attribute or directive spanning `location`, if there is one. */
  attribute(location: SourceLocation): ExpressionOrigin | undefined {
    const brace = this.text.indexOf("{", location.start);
    return brace !== -1 && brace < location.end ? { brace, at: (offset) => brace + offset } : undefined;
  }

  /**
   * The expression of the next text node in a run of text, or undefined for a literal, which only moves
   * the cursor. The compiler tidies a run's lines before parsing it, so a node's `raw` is in that text, not
   * the template's.
   *
   * Without complex expressions, an expression is on one line, so `raw` is in the template as it is, and
   * its offsets are relative to `raw`.
   *
   * With them, its offsets are relative to the tidied run. Each `{` in the text starts an expression, so
   * the next one is this node's, and from it `raw` lines up with the template but for whitespace.
   */
  textExpression(raw: string, expression: TemplateExpression | undefined, location: SourceLocation): ExpressionOrigin | undefined {
    const cursor = this.#cursors.get(location.start) ?? { source: location.start, tidied: 0 };
    this.#cursors.set(location.start, cursor);
    const tidied = cursor.tidied;
    cursor.tidied += raw.length;
    if (expression === undefined) {
      return undefined;
    }
    if (!this.#options.complexExpressions) {
      const position = this.text.indexOf(raw, cursor.source);
      if (position === -1 || position >= location.end) {
        return undefined;
      }
      cursor.source = position + raw.length;
      return { brace: position, at: (offset) => position + offset };
    }
    const brace = this.text.indexOf("{", cursor.source);
    if (brace === -1 || brace >= location.end) {
      return undefined;
    }
    const offsets = this.#align(raw, brace);
    cursor.source = offsets[raw.length]!;
    return { brace, at: (offset) => offsets[offset - tidied]! };
  }

  /** For each offset of `raw`, and its end, the template offset of the same text, starting at `start`. */
  #align(raw: string, start: number): number[] {
    const offsets: number[] = [];
    let position = start;
    for (const character of raw) {
      while (this.text[position] !== character && isSpace(this.text[position])) {
        position++;
      }
      // a space the compiler made of a line break has nothing of its own in the template
      offsets.push(position);
      if (this.text[position] === character) {
        position++;
      }
    }
    offsets.push(position);
    return offsets;
  }

  /** The offset of some literal text in a run of text, if it's there as it is. */
  literal(text: string, location: SourceLocation): number | undefined {
    const position = this.text.indexOf(text, location.start);
    return position === -1 || position >= location.end ? undefined : position;
  }

  /** The offset of a name in an attribute such as `for:item="row"`, after its `=` (or its `:`). */
  name(name: string, location: SourceLocation, after: "=" | ":"): number | undefined {
    const marker = this.text.indexOf(after, location.start);
    const position = marker === -1 ? -1 : this.text.indexOf(name, marker);
    return position !== -1 && position + name.length <= location.end ? position : undefined;
  }
}

function isSpace(character: string | undefined): boolean {
  return character !== undefined && /\s/.test(character);
}
