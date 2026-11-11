import type { Readable, Writable } from "node:stream";

export type RequestHandler = (method: string, params: unknown) => Promise<unknown>;

interface Request {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

/**
 * Serves JSON-RPC 2.0 requests framed with LSP-style `Content-Length` headers. The content mapper host
 * only sends requests, so notifications are ignored. Requests are handled concurrently and answered as
 * they complete. Resolves when the input ends.
 */
export function serve(input: Readable, output: Writable, handler: RequestHandler, errorCode: (error: unknown) => number): Promise<void> {
  let buffer = Buffer.alloc(0);

  const write = (message: object) => {
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    output.write(`Content-Length: ${payload.length}\r\n\r\n`);
    output.write(payload);
  };

  const dispatch = (payload: Buffer) => {
    let message: unknown;
    try {
      message = JSON.parse(payload.toString("utf8"));
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (!isRequest(message)) {
      if (!isNotification(message)) {
        write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
      }
      return;
    }
    const { id } = message;
    handler(message.method, message.params).then(
      (result) => write({ jsonrpc: "2.0", id, result: result ?? null }),
      (error: unknown) =>
        write({
          jsonrpc: "2.0",
          id,
          error: { code: errorCode(error), message: error instanceof Error ? error.message : String(error) },
        }),
    );
  };

  return new Promise((resolve, reject) => {
    input.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          return;
        }
        const header = buffer.subarray(0, headerEnd).toString("ascii");
        const match = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
        if (!match) {
          reject(new Error(`Missing Content-Length header: ${header}`));
          input.destroy();
          return;
        }
        const start = headerEnd + 4;
        const end = start + Number(match[1]);
        if (buffer.length < end) {
          return;
        }
        const payload = buffer.subarray(start, end);
        buffer = buffer.subarray(end);
        dispatch(payload);
      }
    });
    input.on("end", () => resolve());
    input.on("error", reject);
  });
}

function isRequest(value: unknown): value is Request {
  const request = value as Partial<Request> | null;
  return (
    typeof request === "object" &&
    request !== null &&
    request.jsonrpc === "2.0" &&
    (typeof request.id === "string" || typeof request.id === "number") &&
    typeof request.method === "string"
  );
}

function isNotification(value: unknown): boolean {
  const message = value as Partial<Request> | null;
  return typeof message === "object" && message !== null && message.id === undefined && typeof message.method === "string";
}
