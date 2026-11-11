// Documentation comments on generated declarations, from metadata's descriptions and Apex's ApexDoc.

/**
 * Renders a JSDoc block at `indent`, or an empty string when there are no lines. `undefined` lines
 * are dropped, empty strings become blank comment lines, and `*\/` in the text can't end the comment.
 */
export function jsDoc(indent: string, lines: (string | undefined)[]): string {
  const body = lines.filter((line) => line !== undefined).flatMap((line) => line.replace(/\*\//g, "*\\/").split(/\r\n|\r|\n/));
  if (body.length === 0) {
    return "";
  }
  return [`${indent}/**`, ...body.map((line) => (line === "" ? `${indent} *` : `${indent} * ${line}`)), `${indent} */`, ""].join("\n");
}

/**
 * Prefixes a JSDoc tag to a value, or returns undefined when the value is missing.
 */
export function docTag(tag: string, value: string | undefined): string | undefined {
  return value === undefined ? undefined : `@${tag} ${value}`;
}

/**
 * Documentation lines from paragraphs, each a line or several, with a blank line between them. Missing
 * paragraphs, and missing lines in them, are left out.
 */
export function docParagraphs(...paragraphs: (string | undefined | readonly (string | undefined)[])[]): string[] {
  const present = paragraphs
    .map((paragraph) =>
      (typeof paragraph === "string" || paragraph === undefined ? [paragraph] : paragraph).filter((line) => line !== undefined),
    )
    .filter((lines) => lines.length > 0);
  return present.flatMap((lines, i) => (i === 0 ? lines : ["", ...lines]));
}
