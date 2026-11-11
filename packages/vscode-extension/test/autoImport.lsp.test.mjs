// End-to-end: the auto-import rewrites against TypeScript 7.1's language server, in a copy of the content
// mapper's example project, with the content mapper run from source. Needs the extension compiled
// (`npm run build`, which `npm test` runs first).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { rewriteCodeActions, rewriteCompletions, rewriteResolvedCompletion } = await import("../dist/autoImport.js");

const mapperDir = path.dirname(require.resolve("@lwc-bolts/typescript-content-mapper/package.json"));
const fixture = path.join(import.meta.dirname, "../../../tests/fixtures/example-project");

/**
 * Installs the content mapper into `projectDir`'s node_modules so TypeScript runs it from source: a
 * stand-in package with the mapper's name, version and manifest, whose `exec` runs its `src/server.ts`
 * with this Node.js and the `@lwc-bolts/source` export condition. Nothing has to be built first.
 */
function installContentMapperFromSource(projectDir) {
  const manifest = require(path.join(mapperDir, "package.json"));
  const standIn = path.join(projectDir, "node_modules", manifest.name);
  mkdirSync(standIn, { recursive: true });
  const contentMapper = {
    ...manifest.typescript.contentMapper,
    exec: [process.execPath, "--conditions=@lwc-bolts/source", path.join(mapperDir, "src/server.ts")],
  };
  writeFileSync(
    path.join(standIn, "package.json"),
    JSON.stringify({ name: manifest.name, version: manifest.version, type: "module", typescript: { contentMapper } }, null, 2) + "\n",
  );
}

/**
 * The native TypeScript 7 executable, found the way `bin/tsc` finds it. Spawning it directly means the
 * process the tests stop is the server itself: `bin/tsc` only replaces itself with the server where
 * `process.execve` exists, and elsewhere (Windows) runs it as a child that killing `bin/tsc` would orphan.
 * `lib/getExePath.js` isn't exported, so it's imported by path.
 */
const { default: getExePath } = await import(
  pathToFileURL(path.join(path.dirname(require.resolve("typescript/package.json")), "lib/getExePath.js")).href
);

/** Resolves when `child` has exited, or after `ms` milliseconds; true if it exited. */
function exited(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** A minimal LSP client for `tsc --lsp --stdio`. */
function startServer(cwd) {
  const child = spawn(getExePath(), ["--lsp", "--stdio"], { cwd, stdio: ["pipe", "pipe", "ignore"] });
  // If the test process exits without stopping the server (an uncaught error, `process.exit`), kill it.
  // The server also exits when its stdin closes, which covers the test process being killed outright.
  const killOnExit = () => child.kill("SIGKILL");
  process.once("exit", killOnExit);
  child.once("exit", () => process.off("exit", killOnExit));
  // writes after the server exits (such as the `exit` notification) fail with EPIPE; stop() handles exiting
  child.stdin.on("error", () => {});
  let buffer = Buffer.alloc(0);
  let nextId = 0;
  const pending = new Map();
  const write = (message) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  };
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())[1]);
      if (buffer.length < headerEnd + 4 + length) return;
      const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
      buffer = buffer.subarray(headerEnd + 4 + length);
      if (message.id !== undefined && message.method === undefined) {
        pending.get(message.id)?.(message);
      } else if (message.id !== undefined) {
        // server-to-client requests, such as workspace/configuration
        write({ id: message.id, result: message.method === "workspace/configuration" ? message.params.items.map(() => null) : null });
      }
    }
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)));
      write({ id, method, params });
    });
  return {
    request,
    notify: (method, params) => write({ method, params }),
    /** Shuts the server down, and kills it if it doesn't exit on its own. Resolves once it has exited. */
    async stop() {
      try {
        // `shutdown` takes no params; don't let a server that never answers keep the test process alive
        await Promise.race([request("shutdown"), new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
        write({ method: "exit" });
      } catch {
        // the server already went away
      }
      if (!(await exited(child, 2000))) {
        child.kill("SIGKILL");
        await exited(child, 2000);
      }
    },
  };
}

describe("auto-imports against TypeScript 7.1's language server", () => {
  let dir;
  let server;
  let version = 0;
  const probe = () => path.join(dir, "force-app/main/default/lwc/probe/probe.js");
  const open = (text) => {
    const uri = pathToFileURL(probe()).href;
    server.notify(version === 0 ? "textDocument/didOpen" : "textDocument/didChange", {
      ...(version === 0
        ? { textDocument: { uri, languageId: "javascript", version: ++version, text } }
        : { textDocument: { uri, version: ++version }, contentChanges: [{ text }] }),
    });
    return uri;
  };

  before(async () => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "lwc-bolts-autoimport-lsp-")));
    cpSync(fixture, dir, { recursive: true, filter: (source) => !["node_modules", ".sfdx"].includes(path.basename(source)) });
    installContentMapperFromSource(dir);
    for (const name of ["typescript", "lwc"]) {
      symlinkSync(
        path.dirname(require.resolve(`${name}/package.json`, { paths: [mapperDir, fixture] })),
        path.join(dir, "node_modules", name),
        "dir",
      );
    }
    mkdirSync(path.dirname(probe()), { recursive: true });
    writeFileSync(probe(), "");
    server = startServer(dir);
    await server.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(dir).href,
      capabilities: {
        textDocument: {
          completion: { completionItem: { snippetSupport: false } },
          codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ["quickfix"] } } },
          diagnostic: {},
        },
      },
      initializationOptions: { runExternalCode: true },
    });
    server.notify("initialized", {});
  });

  after(async () => {
    await server?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("completes another component's named export with a c/ import", async () => {
    const text = "// @ts-check\nexport const x = dat";
    const uri = open(text);
    const completions = await server.request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 1, character: text.split("\n")[1].length },
    });
    const items = (Array.isArray(completions) ? completions : completions.items).filter((item) => item.label === "data");
    assert.deepEqual(
      items.map((item) => item.data?.autoImport?.moduleSpecifier),
      ["../comp2/comp2"],
      "without the middleware, TypeScript imports the component relatively",
    );
    const rewritten = rewriteCompletions(completions);
    const [item] = (Array.isArray(rewritten) ? rewritten : rewritten.items).filter((i) => i.label === "data");
    // the server builds the import from the rewritten specifier
    const resolved = rewriteResolvedCompletion(await server.request("completionItem/resolve", item));
    assert.equal(resolved.detail, 'Add import from "c/comp2"');
    assert.deepEqual(
      resolved.additionalTextEdits.map((edit) => edit.newText.trim()),
      ['import { data } from "c/comp2";'],
    );
  });

  it("quick-fixes another component's named export with a c/ import", async () => {
    const uri = open("// @ts-check\nexport const x = data;\n");
    const { items: diagnostics } = await server.request("textDocument/diagnostic", { textDocument: { uri } });
    const missing = diagnostics.filter((d) => d.code === 2304);
    assert.equal(missing.length, 1);
    const actions = await server.request("textDocument/codeAction", {
      textDocument: { uri },
      range: missing[0].range,
      context: { diagnostics: missing, only: ["quickfix"] },
    });
    const fixes = rewriteCodeActions(actions, uri).filter((action) => action.title.startsWith("Add import"));
    assert.deepEqual(
      fixes.map((fix) => [fix.title, fix.edit.changes[uri].map((edit) => edit.newText.trim())]),
      [['Add import from "c/comp2"', ['import { data } from "c/comp2";']]],
    );
  });

  it("doesn't complete another bundle's template", async () => {
    const text = "// @ts-check\nexport const x = testTemplate1Templ";
    const uri = open(text);
    const completions = await server.request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 1, character: text.split("\n")[1].length },
    });
    const templates = (result) => (Array.isArray(result) ? result : result.items).filter((item) => item.label === "testTemplate1Template");
    assert.deepEqual(
      templates(completions).map((item) => item.data?.autoImport?.moduleSpecifier),
      ["../comp3/templates/testTemplate1.html"],
      "without the middleware, TypeScript offers it",
    );
    assert.deepEqual(templates(rewriteCompletions(completions)), []);
  });

  it("doesn't quick-fix with another bundle's template", async () => {
    const uri = open("// @ts-check\nexport const x = testTemplate1Template;\n");
    const { items: diagnostics } = await server.request("textDocument/diagnostic", { textDocument: { uri } });
    const missing = diagnostics.filter((d) => d.code === 2304);
    assert.equal(missing.length, 1);
    const actions = await server.request("textDocument/codeAction", {
      textDocument: { uri },
      range: missing[0].range,
      context: { diagnostics: missing, only: ["quickfix"] },
    });
    const imports = (result) => result.filter((action) => action.title.startsWith("Add import"));
    assert.deepEqual(
      imports(actions).map((fix) => fix.title),
      ['Add import from "../comp3/templates/testTemplate1.html"'],
      "without the middleware, TypeScript offers it",
    );
    assert.deepEqual(imports(rewriteCodeActions(actions, uri)), []);
  });

  it("goes from a template's import to its root tag", async () => {
    const uri = open('import template from "../comp3/templates/testTemplate1.html";\nexport default template;\n');
    const [definition] = await server.request("textDocument/definition", {
      textDocument: { uri },
      position: { line: 1, character: "export default ".length },
    });
    assert.ok((definition.uri ?? definition.targetUri).endsWith("/comp3/templates/testTemplate1.html"));
    assert.deepEqual((definition.range ?? definition.targetSelectionRange).start, { line: 0, character: 1 });
  });

  it("type checks the rewritten import", async () => {
    const uri = open('// @ts-check\nimport { data } from "c/comp2";\nexport const key = data.key1;\n');
    const { items } = await server.request("textDocument/diagnostic", { textDocument: { uri } });
    assert.deepEqual(
      items.map((d) => `${d.code} ${d.message}`),
      [],
    );
  });
});
