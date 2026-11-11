import path from "node:path";
import { snapshot } from "node:test";
import { createFileSystemWithLib } from "typescript/fs";
import { API, DiagnosticCategory } from "typescript/sync";
import { convert, MetadataType, type Component, type ConvertedComponent, type ConvertOptions } from "../src/index.ts";

// Snapshots of generated text are stored as the text itself, so they read like the TypeScript they are
// (`t.assert.snapshot(converted.text)`). Update them with `npm run test:update` after an intended change.
snapshot.setDefaultSnapshotSerializers([(value) => (typeof value === "string" ? value : JSON.stringify(value, null, 2))]);

/**
 * Converts one component.
 */
export async function convertOne(component: Component, options?: ConvertOptions): Promise<ConvertedComponent> {
  // one result for each component
  return (await convert([component], options))[0]!;
}

/** An object's metadata file, labeled with its name unless `label` is given, with other elements in `body`. */
export function objectFile(name: string, body = "", label = name): Component {
  return {
    path: `force-app/objects/${name}/${name}.object-meta.xml`,
    type: MetadataType.CustomObject,
    content: `<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><label>${label}</label>${body}</CustomObject>`,
  };
}

/** A field's metadata file, with its elements other than its name in `body`. */
export function fieldFile(objectName: string, fieldName: string, body: string): Component {
  return {
    path: `force-app/objects/${objectName}/fields/${fieldName}.field-meta.xml`,
    type: MetadataType.CustomField,
    content: `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>${fieldName}</fullName>
    ${body}
</CustomField>
`,
  };
}

/**
 * Pairs each mapped span of generated text with the source text it maps to, so mapping assertions
 * read as `[generated, source]` instead of raw offsets.
 */
export function mappedText(converted: ConvertedComponent): [string, string][] {
  const pairs: [string, string][] = [];
  const { mapData, text, content } = converted;
  for (let i = 0; i + 1 < mapData.length; i += 2) {
    const start = mapData[i]!;
    const end = mapData[i + 1]!;
    pairs.push([text.slice(start.destPos, end.destPos), content.slice(start.sourcePos, end.sourcePos)]);
  }
  return pairs;
}

const LWC_TYPES = `declare module "lwc" {
  export type WireAdapterConstructor<Config, Value> = new (callback: (value: Value) => void) => {
    connect(): void;
    disconnect(): void;
    update(config: Config): void;
  };
}
`;

/** Where {@link checkProject} puts a project's files, in a file system that only exists in memory. */
const PROJECT_DIR = "/project";

/**
 * Type checks generated declarations as global scripts (how editors load them), together with an
 * optional module that consumes them, and returns the error diagnostics as readable strings.
 *
 * @param extraFiles more files by relative path, such as components the declarations import
 */
export function typeCheck(declarations: string[], consumer?: string, extraFiles: Record<string, string> = {}): string[] {
  const files: Record<string, string> = { "lwc.d.ts": LWC_TYPES, ...extraFiles };
  declarations.forEach((text, i) => (files[`decl${i}.ts`] = text));
  if (consumer !== undefined) {
    files["consumer.ts"] = `${consumer}\nexport {};\n`;
  }
  return checkProject(files, {
    strict: true,
    noEmit: true,
    allowJs: true,
    target: "es2022",
    module: "esnext",
    moduleResolution: "bundler",
    lib: ["es2022", "dom"],
    types: [],
  });
}

/**
 * Type checks a project of `files` (by relative path, all of them roots) with a tsconfig.json of
 * `compilerOptions`, and returns the error diagnostics as `file:line TS<code>: message` strings.
 *
 * The files only exist in memory: the TypeScript 7 API is given them as the snapshot's whole file
 * system, with the compiler's own default libraries, so nothing is read from or written to disk.
 */
export function checkProject(files: Record<string, string>, compilerOptions: Record<string, unknown>): string[] {
  const configFileName = `${PROJECT_DIR}/tsconfig.json`;
  const tsconfig = JSON.stringify({ compilerOptions, files: Object.keys(files) });
  const fileSystem = createFileSystemWithLib([
    ...Object.entries(files).map(([name, text]) => [`${PROJECT_DIR}/${name}`, text] as const),
    [configFileName, tsconfig],
  ]);
  const api = new API();
  try {
    const snapshot = api.createSnapshot({ fileSystem, openProjects: [configFileName] });
    try {
      const program = snapshot.getConfiguredProject(configFileName)?.program;
      if (!program) {
        throw new Error(`project for ${configFileName} was not loaded`);
      }
      return [
        ...program.getProgramDiagnostics(),
        ...program.getSyntacticDiagnostics(),
        ...program.getGlobalDiagnostics(),
        ...program.getSemanticDiagnostics(),
      ]
        .filter((d) => d.category === DiagnosticCategory.Error)
        .map((d) => {
          const message = flattenMessage(d);
          if (!d.fileName || d.startPosition === undefined) {
            return `TS${d.code}: ${message}`;
          }
          return `${path.posix.relative(PROJECT_DIR, d.fileName)}:${d.startPosition.line + 1} TS${d.code}: ${message}`;
        });
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

/**
 * Joins a diagnostic's message chain the way TypeScript prints it: one message per line, each nested
 * message indented two more spaces.
 */
function flattenMessage(
  diagnostic: { text: string; messageChain?: readonly { text: string; messageChain?: readonly any[] }[] },
  depth: number = 0,
): string {
  const lines = ["  ".repeat(depth) + diagnostic.text];
  for (const next of diagnostic.messageChain ?? []) {
    lines.push(flattenMessage(next, depth + 1));
  }
  return lines.join("\n");
}
