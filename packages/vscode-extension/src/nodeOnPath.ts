import { execFile } from "node:child_process";

/**
 * Runs `node --version` with the environment TypeScript 7 starts the mapper with (the extension host's). A
 * module of its own, so tests can replace it.
 */
export function nodeOnPath(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("node", ["--version"], { env: process.env, timeout: 5000, windowsHide: true }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim());
    });
  });
}
