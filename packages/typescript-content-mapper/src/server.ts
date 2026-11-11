#!/usr/bin/env node
// Content mapper process entry point: TypeScript spawns this and speaks JSON-RPC over stdio.
import { serve } from "./jsonrpc.ts";
import { ContentMapper, RpcError, RpcErrorCode } from "./mapper.ts";

const mapper = new ContentMapper();

serve(
  process.stdin,
  process.stdout,
  (method, params) => mapper.handle(method, params),
  (error) => {
    if (error instanceof RpcError) {
      return error.code;
    }
    // stderr is surfaced by TypeScript when TS_CONTENT_MAPPER_DEBUG is set (CLI) or at Trace level (LSP).
    console.error(error);
    return RpcErrorCode.InternalError;
  },
).then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
