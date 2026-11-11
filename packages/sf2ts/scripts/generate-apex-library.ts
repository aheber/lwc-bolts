// Generates src/apex/library.generated.ts: the types of each namespace in src/apex/library.config.ts, read
// from the Salesforce extensions' StandardApexLibrary (a folder of Apex stubs for each namespace).
//
//   node scripts/generate-apex-library.ts [<StandardApexLibrary folder>]
//
// Without a folder, it reads the newest release in the example project's .sfdx/tools, which the
// Salesforce extensions write when they start.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Parser } from "web-tree-sitter-sfapex";
import { getApexParser } from "web-tree-sitter-sfapex";
import { APEX_LIBRARY_CONFIG } from "../src/apex/library.config.ts";
import type { LibraryType } from "../src/apex/library.ts";

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(packageDir, "src", "apex", "library.generated.ts");

function defaultLibraryFolder(): string {
  const tools = path.join(packageDir, "..", "..", "tests", "fixtures", "example-project", ".sfdx", "tools");
  const releases = fs.existsSync(tools) ? fs.readdirSync(tools).filter((name) => /^\d+$/.test(name)) : [];
  const newest = releases.sort((a, b) => Number(b) - Number(a))[0];
  if (newest === undefined) {
    throw new Error(`no StandardApexLibrary in ${tools}; open the example project with the Salesforce extensions, or pass a folder`);
  }
  return path.join(tools, newest, "StandardApexLibrary");
}

interface StubType {
  name: string;
  type: LibraryType;
  /** A class's base as the stub writes it, qualified or not. */
  base?: string;
}

/** A type as a one-line object literal: `{ kind: "enum", values: ["A", "B"] }`. */
function format(type: LibraryType): string {
  const value = (v: unknown) => (Array.isArray(v) ? `[${v.map((item) => JSON.stringify(item)).join(", ")}]` : JSON.stringify(v));
  return `{ ${Object.entries(type)
    .map(([key, v]) => `${key}: ${value(v)}`)
    .join(", ")} }`;
}

/** Reads a stub's top-level declaration. */
function readStub(parser: Parser, source: string): StubType | undefined {
  const tree = parser.parse(source);
  if (tree === null) {
    throw new Error("Error parsing stub:" + source);
  }
  try {
    const declaration = tree.rootNode.namedChildren.find((node) => /^(class|interface|enum)_declaration$/.test(node.type));
    const name = declaration?.childForFieldName("name")?.text;
    if (declaration === undefined || name === undefined) {
      return undefined;
    }
    const body = declaration.childForFieldName("body")?.namedChildren ?? [];
    if (declaration.type === "enum_declaration") {
      const values = body.filter((node) => node.type === "enum_constant").map((node) => node.childForFieldName("name")?.text ?? node.text);
      return { name, type: { kind: "enum", values } };
    }
    if (declaration.type === "interface_declaration") {
      return { name, type: { kind: "interface" } };
    }
    // instance fields and properties; static ones aren't part of an instance's JSON
    const open = body.some(
      (node) =>
        node.type === "field_declaration" &&
        !node.namedChildren.some((child) => child.type === "modifiers" && /\bstatic\b/i.test(child.text)),
    );
    const base = declaration.childForFieldName("superclass")?.namedChildren[0]?.text;
    return { name, type: { kind: "class", ...(open && { open }) }, ...(base !== undefined && { base }) };
  } finally {
    tree.delete();
  }
}

async function main(): Promise<void> {
  const folder = path.resolve(process.argv[2] ?? defaultLibraryFolder());
  const parser = await getApexParser();
  const namespaces = new Map<string, Map<string, StubType>>();
  for (const { name: namespace } of APEX_LIBRARY_CONFIG.namespaces) {
    const dir = path.join(folder, namespace);
    if (!fs.existsSync(dir)) {
      throw new Error(`no ${namespace} folder in ${folder}`);
    }
    const types = new Map<string, StubType>();
    for (const file of fs
      .readdirSync(dir)
      .filter((file) => file.endsWith(".cls"))
      .sort()) {
      const stub = readStub(parser, fs.readFileSync(path.join(dir, file), "utf8"));
      if (stub === undefined) {
        console.warn(`skipped ${namespace}/${file}: no class, interface or enum`);
        continue;
      }
      types.set(stub.name.toLowerCase(), stub);
    }
    namespaces.set(namespace, types);
  }

  /** A base class with its namespace: as written when qualified, else from its own namespace, then the others in order. */
  const qualify = (base: string, from: string): string | undefined => {
    const parts = base.split(".");
    const candidates = parts.length > 1 ? [[parts[0]!, parts.slice(1).join(".")]] : [from, ...namespaces.keys()].map((ns) => [ns, base]);
    for (const [namespace, name] of candidates) {
      const configured = APEX_LIBRARY_CONFIG.namespaces.find(({ name }) => name.toLowerCase() === namespace!.toLowerCase())?.name;
      if (configured === undefined) {
        continue;
      }
      const found =
        namespaces.get(configured)?.get(name!.toLowerCase())?.name ??
        Object.keys(APEX_LIBRARY_CONFIG.additionalTypes[configured] ?? {}).find((type) => type.toLowerCase() === name!.toLowerCase());
      if (found !== undefined) {
        return `${configured}.${found}`;
      }
    }
    return undefined;
  };

  const release = path.basename(path.dirname(folder));
  const lines = [
    `// Generated by scripts/generate-apex-library.ts from the StandardApexLibrary of Salesforce release ${release}.`,
    "// Don't edit it; generate it again. It has the namespaces src/apex/library.config.ts lists, whose other",
    "// settings (the order names are looked up in, types to add) apply to it as sf2ts runs.",
    'import type { LibraryTypes } from "./library.ts";',
    "",
    "export const STANDARD_APEX_LIBRARY: LibraryTypes = {",
  ];
  let count = 0;
  for (const [namespace, types] of namespaces) {
    lines.push(`  ${namespace}: {`);
    for (const stub of [...types.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      let { type } = stub;
      if (type.kind === "class" && stub.base !== undefined) {
        const base = qualify(stub.base, namespace);
        if (base === undefined) {
          console.warn(`${namespace}.${stub.name}: base class ${stub.base} isn't a library type; left out`);
        } else {
          type = { kind: "class", extends: base, ...(type.open && { open: true }) };
        }
      }
      lines.push(`    ${JSON.stringify(stub.name)}: ${format(type)},`);
      count++;
    }
    lines.push("  },");
  }
  lines.push("};", "");
  fs.writeFileSync(output, lines.join("\n"));
  console.log(
    `wrote ${count} types of ${[...namespaces.keys()].join(", ")} from release ${release} to ${path.relative(process.cwd(), output)}`,
  );
}

await main();
