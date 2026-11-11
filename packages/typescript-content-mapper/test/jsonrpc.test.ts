import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { serve, type RequestHandler } from "../src/jsonrpc.ts";

/** Frames a message as the host does, with its length in bytes. */
function frame(message: unknown, headers = ""): Buffer {
  const payload = Buffer.from(typeof message === "string" ? message : JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`${headers}Content-Length: ${payload.length}\r\n\r\n`, "ascii"), payload]);
}

/** Serves `handler` over in-memory streams, collecting the framed responses. */
function connect(handler: RequestHandler = async (method, params) => ({ method, params })) {
  const input = new PassThrough();
  const output = new PassThrough();
  const served = serve(input, output, handler, (error) => (error instanceof RangeError ? -32602 : -32603));
  served.catch(() => {}); // observed by the tests that expect it to fail
  let buffer = Buffer.alloc(0);
  const responses: any[] = [];
  const waiters: (() => void)[] = [];
  output.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, headerEnd).toString("ascii"))![1]);
      const end = headerEnd + 4 + length;
      if (buffer.length < end) return;
      responses.push(JSON.parse(buffer.subarray(headerEnd + 4, end).toString("utf8")));
      buffer = buffer.subarray(end);
      waiters.splice(0).forEach((resolve) => resolve());
    }
  });
  /** Resolves once `count` responses have arrived. */
  const received = async (count: number) => {
    while (responses.length < count) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    return responses;
  };
  return { input, served, responses, received };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("JSON-RPC framing", () => {
  it("answers a request, framing the response by its length in bytes", async () => {
    const { input, received } = connect(async () => ({ label: "Größe ✓" }));
    input.write(frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    assert.deepEqual(await received(1), [{ jsonrpc: "2.0", id: 1, result: { label: "Größe ✓" } }]);
  });

  it("reassembles a request split across chunks, even inside a multi-byte character", async () => {
    const { input, received } = connect();
    const bytes = frame({ jsonrpc: "2.0", id: "a", method: "transform", params: { content: "café ✓ 𝒳" } });
    for (const byte of bytes) {
      input.write(Buffer.from([byte]));
    }
    assert.deepEqual(await received(1), [{ jsonrpc: "2.0", id: "a", result: { method: "transform", params: { content: "café ✓ 𝒳" } } }]);
  });

  it("handles several requests in one chunk", async () => {
    const { input, received } = connect();
    input.write(Buffer.concat([1, 2, 3].map((id) => frame({ jsonrpc: "2.0", id, method: `m${id}` }))));
    const responses = await received(3);
    assert.deepEqual(responses.map((r) => [r.id, r.result.method]).sort(), [
      [1, "m1"],
      [2, "m2"],
      [3, "m3"],
    ]);
  });

  it("accepts other headers, and Content-Length in any case", async () => {
    const { input, received } = connect();
    const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "x" }));
    input.write(`Content-Type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-length: ${payload.length}\r\n\r\n`);
    input.write(payload);
    assert.equal((await received(1))[0].id, 7);
  });

  it("doesn't answer notifications", async () => {
    const calls: string[] = [];
    const { input, responses, received } = connect(async (method) => {
      calls.push(method);
      return null;
    });
    input.write(frame({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 1 } }));
    input.write(frame({ jsonrpc: "2.0", id: 2, method: "after" }));
    await received(1);
    await settle();
    assert.deepEqual(
      responses.map((r) => r.id),
      [2],
    );
    assert.deepEqual(calls, ["after"], "notifications aren't handled either");
  });

  it("reports invalid JSON and invalid requests, and keeps serving", async () => {
    const { input, received } = connect();
    input.write(frame("{ not json"));
    input.write(frame({ jsonrpc: "1.0", id: 1, method: "old" }));
    input.write(frame({ jsonrpc: "2.0", id: 2 }));
    input.write(frame([1, 2]));
    input.write(frame({ jsonrpc: "2.0", id: 3, method: "fine" }));
    const responses = await received(5);
    assert.deepEqual(responses.slice(0, 4), [
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } },
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } },
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } },
    ]);
    assert.equal(responses[4].result.method, "fine");
  });

  it("answers a failed request with the handler's error and its code", async () => {
    const { input, received } = connect(async (method) => {
      if (method === "bad") throw new RangeError("bad params");
      if (method === "broken") throw "not an Error";
      return undefined;
    });
    input.write(frame({ jsonrpc: "2.0", id: 1, method: "bad" }));
    input.write(frame({ jsonrpc: "2.0", id: 2, method: "broken" }));
    input.write(frame({ jsonrpc: "2.0", id: 3, method: "empty" }));
    const responses = await received(3);
    assert.deepEqual(
      responses.sort((a, b) => a.id - b.id),
      [
        { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad params" } },
        { jsonrpc: "2.0", id: 2, error: { code: -32603, message: "not an Error" } },
        // an undefined result is sent as null, which JSON can carry
        { jsonrpc: "2.0", id: 3, result: null },
      ],
    );
  });

  it("answers concurrent requests as they complete", async () => {
    const { input, received } = connect(async (method) => {
      await new Promise((resolve) => setTimeout(resolve, method === "slow" ? 50 : 0));
      return method;
    });
    input.write(frame({ jsonrpc: "2.0", id: 1, method: "slow" }));
    input.write(frame({ jsonrpc: "2.0", id: 2, method: "fast" }));
    assert.deepEqual(
      (await received(2)).map((r) => r.id),
      [2, 1],
    );
  });

  it("fails on a message without a Content-Length header", async () => {
    const { input, served } = connect();
    input.write("Content-Type: text/plain\r\n\r\n{}");
    await assert.rejects(served, /Missing Content-Length header/);
    assert.ok(input.destroyed);
  });

  it("resolves when the input ends, after a partial message", async () => {
    const { input, served } = connect();
    input.write("Content-Length: 100\r\n\r\n{");
    input.end();
    await served;
  });
});
