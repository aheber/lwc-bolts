// Parsing component source (JavaScript or TypeScript), for the one fact sf2ts reads from it: its default
// export's name.
import { tsPlugin } from "@sveltejs/acorn-typescript";
import { Parser, type Program } from "acorn";

/**
 * acorn with TypeScript syntax, which also parses decorators (`@api`, `@wire`). JavaScript components
 * are parsed with it too, since plain acorn rejects decorators.
 */
const ComponentParser = Parser.extend(tsPlugin());

/**
 * Parses a component's module, or returns undefined when it doesn't parse (such as a file being edited),
 * so callers find nothing in it rather than guessing.
 */
export function parseComponentSource(source: string): Program | undefined {
  try {
    return ComponentParser.parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch {
    return undefined;
  }
}
