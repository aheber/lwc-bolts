import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { exampleProject } from "./fixtures.ts";

// the server's source, with the workspace packages it uses (sf2ts, ...) loaded from source too
const server = [process.execPath, "--conditions=@lwc-bolts/source", path.join(import.meta.dirname, "../src/server.ts")] as const;
const fixture = exampleProject;

/** Minimal Content-Length framed JSON-RPC client over a child process's stdio. */
function connect(child: ChildProcessWithoutNullStreams) {
  let buffer = Buffer.alloc(0);
  let nextId = 0;
  const pending = new Map<number | null, (message: any) => void>();
  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, headerEnd).toString())![1]);
      const end = headerEnd + 4 + length;
      if (buffer.length < end) return;
      const message = JSON.parse(buffer.subarray(headerEnd + 4, end).toString("utf8"));
      buffer = buffer.subarray(end);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  // a server that exits fails the requests waiting on it, rather than leaving the test waiting forever
  let exit: Error | undefined;
  child.once("exit", (code, signal) => {
    exit = new Error(`the server exited (${signal ?? `code ${code}`})`);
    for (const resolve of pending.values()) {
      resolve({ error: { message: exit.message } });
    }
    pending.clear();
  });
  const send = (message: object, id: number | null) => {
    if (exit !== undefined) {
      return Promise.resolve({ error: { message: exit.message } });
    }
    const payload = Buffer.from(JSON.stringify(message));
    child.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
    child.stdin.write(payload);
    return new Promise<any>((resolve) => pending.set(id, resolve));
  };
  return {
    request: (method: string, params?: unknown) => {
      const id = ++nextId;
      return send({ jsonrpc: "2.0", id, method, params }, id);
    },
  };
}

describe("server process", () => {
  let child: ChildProcessWithoutNullStreams;
  let client: ReturnType<typeof connect>;

  before(() => {
    const [command, ...args] = server;
    child = spawn(command, args, { stdio: "pipe" });
    client = connect(child);
  });

  after(() => child.kill());

  it("serves the protocol over stdio", async () => {
    const init = await client.request("initialize", { positionEncodings: ["utf-8", "utf-16"] });
    assert.deepEqual(init.result, { positionEncoding: "utf-16", diagnosticSource: "lwc-bolts" });

    const configFileName = path.join(fixture, "tsconfig.json");
    const open = await client.request("openProject", { configFileName, projectHandle: "h", compilerOptions: {} });
    assert.deepEqual(open.result.watchedFiles, [
      path.join(fixture, "sfdx-project.json"),
      path.join(fixture, ".forceignore"),
      path.join(fixture, ".sfdx/tools/soqlMetadata/typeNames.json"),
    ]);

    const fileName = path.join(fixture, "force-app/main/default/customPermissions/TestPerm.customPermission-meta.xml");
    const content = "<CustomPermission><label>Perm ✓</label></CustomPermission>";
    // Concurrent requests are all answered.
    const [first, second] = await Promise.all([
      client.request("transform", { fileName, content, projectHandle: "h" }),
      client.request("transform", { fileName, content, projectHandle: "h" }),
    ]);
    assert.match(first.result.text, /declare module "@salesforce\/customPermission\/TestPerm"/);
    assert.deepEqual(first.result, second.result);

    assert.deepEqual((await client.request("closeProject", { projectHandle: "h" })).result, null);
    const closed = await client.request("transform", { fileName, content, projectHandle: "h" });
    assert.equal(closed.error.code, -32602);
  });

  it("exits when stdin closes", async () => {
    // a server that already exited (one that failed to start) has its code already
    const exited = new Promise<number | null>((resolve) =>
      child.exitCode !== null ? resolve(child.exitCode) : child.once("exit", resolve),
    );
    child.stdin.end();
    assert.equal(await exited, 0);
  });
});
