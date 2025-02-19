import path from "node:path";
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { readFile } from "node:fs/promises";

import { getLocationFromFile } from "./helpers/utils.ts";
import createServer from "./fixtures/lang-server.ts";
import {
  CMD_DEFINITION_AND_BOUND_SPAN,
  EVT_PROJECT_LOADING_FINISH,
} from "./helpers/lang-server-constants.ts";

const testProjectRoot = import.meta.dirname;
const testProjectPath = path.resolve(
  testProjectRoot,
  "fixtures/decomposed-labels"
);

describe("Definition Resolution", async () => {
  let server: ReturnType<typeof createServer>;
  const file = path.join(
    testProjectPath,
    "force-app/main/default/lwc/comp1/comp1.js"
  );
  const fileContent = await readFile(file, "utf8");

  // start a language server for this project
  beforeEach(async () => {
    // if there isn't a lang server yet, create one
    // this allows a mutating test to reset the lang server
    if (!server) {
      server = createServer();
      server.sendCommand("open", { file, fileContent, scriptKindName: "JS" });
      await server.ensureEvent(EVT_PROJECT_LOADING_FINISH);
    }
  });

  after(async () => {
    await server.close();
  });

  it("Resolve Custom Label Australia", async () => {
    server.sendCommand(CMD_DEFINITION_AND_BOUND_SPAN, {
      file,
      position: fileContent.indexOf("lblAustralia"), // somewhat vague, could break in future
    });
    const resp = await server.waitResponse(CMD_DEFINITION_AND_BOUND_SPAN);
    const targetFilePath = path.join(
      testProjectPath,
      "force-app/main/default/labels/Australia.label-meta.xml"
    );
    const targetFileContent = await readFile(targetFilePath, "utf8");
    const destLocation = getLocationFromFile(
      targetFilePath,
      targetFileContent,
      "Australia"
    );
    assert.partialDeepStrictEqual(resp.body.definitions[0], destLocation);

    server.sendCommand(CMD_DEFINITION_AND_BOUND_SPAN, {
      file,
      position: fileContent.indexOf("@salesforce/label/c.Australia"),
    });
    const resp2 = await server.waitResponse(CMD_DEFINITION_AND_BOUND_SPAN);
    // linking to the module import means linking to the entire JS file
    assert.partialDeepStrictEqual(resp2.body.definitions[0], destLocation);
  });

  it("Resolve Custom Label Account", async () => {
    server.sendCommand(CMD_DEFINITION_AND_BOUND_SPAN, {
      file,
      position: fileContent.indexOf("lblAccount"), // somewhat vague, could break in future
    });
    const resp = await server.waitResponse(CMD_DEFINITION_AND_BOUND_SPAN);
    const targetFilePath = path.join(
      testProjectPath,
      "force-app/main/default/labels/Account.label-meta.xml"
    );
    const targetFileContent = await readFile(targetFilePath, "utf8");
    const destLocation = getLocationFromFile(
      targetFilePath,
      targetFileContent,
      "Account"
    );
    assert.partialDeepStrictEqual(resp.body.definitions[0], destLocation);

    server.sendCommand(CMD_DEFINITION_AND_BOUND_SPAN, {
      file,
      position: fileContent.indexOf("@salesforce/label/c.Account"),
    });
    const resp2 = await server.waitResponse(CMD_DEFINITION_AND_BOUND_SPAN);
    // linking to the module import means linking to the entire JS file
    assert.partialDeepStrictEqual(resp2.body.definitions[0], destLocation);
  });
});
