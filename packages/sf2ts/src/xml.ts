// Metadata XML, read tolerantly with htmlparser2, so a file being edited (with an unclosed or mismatched
// tag) converts as far as it goes. Its own module, which only converters import, so htmlparser2 loads with
// the first of them rather than when sf2ts is imported.
import { Parser } from "htmlparser2";
import type { SourceRange } from "./text-builder.ts";

/** An element of metadata XML: its text and children, and where it is in the source. */
export class XmlElement {
  readonly name: string;
  readonly children: XmlElement[] = [];
  /** The element's own text, with entities and CDATA decoded: `A & B` for `A &amp; B`. */
  text = "";
  /** Where its name is in its start tag. */
  readonly nameRange: SourceRange;
  /**
   * Where its content is, between its tags, as written (`A &amp; B`). It's empty for a self-closing
   * element (`<a/>`), and runs to the end of the file for one that's never closed.
   */
  contentRange: SourceRange;

  constructor(name: string, nameStart: number, contentStart: number) {
    this.name = name;
    this.nameRange = { start: nameStart, end: nameStart + name.length };
    this.contentRange = { start: contentStart, end: contentStart };
  }

  /** Its first child named `name`. */
  child(name: string): XmlElement | undefined {
    return this.children.find((child) => child.name === name);
  }

  /** Its children named `name`. */
  childrenNamed(name: string): XmlElement[] {
    return this.children.filter((child) => child.name === name);
  }

  /** The text of its first child named `name`, or undefined without one. */
  childText(name: string): string | undefined {
    return this.child(name)?.text;
  }
}

/**
 * Parses metadata XML into its root element, or undefined when it has none. It never throws: an unclosed
 * element is closed at the end of the file, and a closing tag that matches no open element is ignored.
 */
export function parseXml(content: string): XmlElement | undefined {
  const top: XmlElement[] = [];
  const open: XmlElement[] = [];
  // htmlparser2's indices are inclusive: a tag spans `startIndex` to `endIndex`
  const parser = new Parser(
    {
      onopentag(name) {
        const element = new XmlElement(name, parser.startIndex + 1, parser.endIndex + 1);
        (open.at(-1)?.children ?? top).push(element);
        open.push(element);
      },
      ontext(text) {
        const element = open.at(-1);
        if (element !== undefined) {
          element.text += text;
        }
      },
      onclosetag(_name, isImplied) {
        const element = open.pop();
        if (element === undefined) {
          return;
        }
        // a self-closing element is closed where it's opened, with no content
        const selfClosing = isImplied && parser.startIndex + 1 === element.nameRange.start;
        element.contentRange = { start: element.contentRange.start, end: selfClosing ? element.contentRange.start : parser.startIndex };
      },
    },
    { xmlMode: true },
  );
  parser.write(content);
  parser.end();
  return top[0];
}

/**
 * Parses a metadata file into its root element, which must be `<root>`: a file without one, or of
 * another type, throws, naming the root it has.
 */
export function parseMetadataXml(content: string, root: string): XmlElement {
  const element = parseXml(content);
  if (element?.name !== root) {
    throw new Error(`expected a <${root}> root element, ${element === undefined ? "but the file has none" : `found <${element.name}>`}`);
  }
  return element;
}
