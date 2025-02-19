// derived from https://github.com/Quramy/ts-graphql-plugin/blob/main/e2e/fixtures/lang-server.js

import { fork } from "node:child_process";
import path from "path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

type MsgEvent = {
  type: "event";
  event: string;
};
type MsgResponse = {
  type: "response";
  comment: string;
};

class TSServer {
  _responseEventEmitter;
  _responseCommandEmitter;
  _exitPromise;
  responses: (MsgEvent | MsgResponse)[];
  _isClosed;
  _server;
  _seq;
  constructor() {
    this._responseEventEmitter = new EventEmitter();
    this._responseCommandEmitter = new EventEmitter();
    const tsserverPath = import.meta.resolve("typescript/lib/tsserver");
    const server = fork(fileURLToPath(tsserverPath), {
      cwd: path.resolve(
        path.join(import.meta.dirname, "../fixtures/example-project")
      ),
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    this._exitPromise = new Promise((resolve, reject) => {
      server.on("exit", (code) => resolve(code));
      server.on("error", (reason) => reject(reason));
    });
    server.stdout?.setEncoding("utf-8");
    server.stdout?.on("data", (data) => {
      // console.log('Message Received:', data);
      const [, , res] = data.split("\n");
      const obj = JSON.parse(res);
      // console.log(obj);
      if (obj.type === "event") {
        this._responseEventEmitter.emit(obj.event, obj);
      } else if (obj.type === "response") {
        this._responseCommandEmitter.emit(obj.command, obj);
      }
      this.responses.push(obj);
    });
    this._isClosed = false;
    this._server = server;
    this._seq = 0;
    this.responses = [];
  }

  sendCommand(command: string, args: any) {
    this.send({ command, arguments: args });
  }

  send(payload: any) {
    // console.log(command);
    const seq = ++this._seq;
    const req =
      JSON.stringify(Object.assign({ seq: seq, type: "request" }, payload)) +
      "\n";
    this._server.stdin?.write(req);
  }

  close() {
    if (!this._isClosed) {
      this._isClosed = true;
      this._server.stdin?.end();
    }
    return this._exitPromise;
  }

  wait(time = 0) {
    return new Promise<void>((res) => setTimeout(() => res(), time));
  }

  waitEvent(eventName: string) {
    return new Promise<any>((res) =>
      this._responseEventEmitter.once(eventName, (evt) => res(evt))
    );
  }

  async ensureEvent(eventName: string) {
    const evt = this.responses
      .filter((obj) => obj.type === "event")
      .find((obj) => obj.event === eventName);
    if (evt !== undefined) {
      return evt;
    }
    // specified event hasn't happened yet, wait for it
    return this.waitEvent(eventName);
  }

  waitResponse(commandName: string) {
    return new Promise<any>((res) =>
      this._responseCommandEmitter.once(commandName, (resp) => res(resp))
    );
  }
}

export default function createServer() {
  return new TSServer();
}
