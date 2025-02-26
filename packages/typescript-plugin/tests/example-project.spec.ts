import path from "node:path";
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { readFile } from "node:fs/promises";

import {
  getLocationFromFile,
  getEndPositionFromText,
} from "./helpers/utils.ts";
import createServer from "./fixtures/lang-server.ts";
import {
  CMD_DEFINITION_AND_BOUND_SPAN,
  EVT_PROJECT_LOADING_FINISH,
  EVT_SUGGESTION_DIAG,
} from "./helpers/lang-server-constants.ts";

const testProjectRoot = import.meta.dirname;
const testProjectPath = path.resolve(
  testProjectRoot,
  "fixtures/example-project"
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

  it("Resolve Custom Permissions", async () => {
    server.sendCommand(CMD_DEFINITION_AND_BOUND_SPAN, {
      file,
      position: fileContent.indexOf("hasTestPerm"),
    });
    const resp = await server.waitResponse(CMD_DEFINITION_AND_BOUND_SPAN);
    const targetFilePath = path.join(
      testProjectPath,
      "force-app/main/default/customPermissions/TestPerm.customPermission-meta.xml"
    );
    const targetFileContent = await readFile(targetFilePath, "utf8");
    const destLocation = getLocationFromFile(
      targetFilePath,
      targetFileContent,
      "Disable DLRS"
    );
    assert.partialDeepStrictEqual(resp.body.definitions[0], destLocation);

    server.sendCommand(CMD_DEFINITION_AND_BOUND_SPAN, {
      file,
      position: fileContent.indexOf("@salesforce/customPermission/TestPerm"),
    });
    const resp2 = await server.waitResponse(CMD_DEFINITION_AND_BOUND_SPAN);
    assert.partialDeepStrictEqual(resp2.body.definitions[0], destLocation);
  });

  it("Resolve Related Component", async () => {
    server.sendCommand(CMD_DEFINITION_AND_BOUND_SPAN, {
      file,
      position: fileContent.indexOf("data"), // somewhat vague, could break in future
    });
    const resp = await server.waitResponse(CMD_DEFINITION_AND_BOUND_SPAN);
    const targetFilePath = path.join(
      testProjectPath,
      "force-app/main/default/lwc/comp2/comp2.js"
    );
    const targetFileContent = await readFile(targetFilePath, "utf8");
    const destLocation = getLocationFromFile(
      targetFilePath,
      targetFileContent,
      "data"
    );
    assert.partialDeepStrictEqual(resp.body.definitions[0], destLocation);

    server.sendCommand(CMD_DEFINITION_AND_BOUND_SPAN, {
      file,
      position: fileContent.indexOf("c/comp2"),
    });
    const resp2 = await server.waitResponse(CMD_DEFINITION_AND_BOUND_SPAN);
    // linking to the module import means linking to the entire JS file
    assert.partialDeepStrictEqual(resp2.body.definitions[0], {
      file: targetFilePath,
      start: {
        line: 1,
        offset: 1,
      },
      end: getEndPositionFromText(targetFileContent),
    });
  });

  it("Resolve Custom Object", async () => {
    server.sendCommand(CMD_DEFINITION_AND_BOUND_SPAN, {
      file,
      position: fileContent.indexOf("Test_Object__c"), // somewhat vague, could break in future
    });
    const resp = await server.waitResponse(CMD_DEFINITION_AND_BOUND_SPAN);
    const targetFilePath = path.join(
      testProjectPath,
      "force-app/main/default/objects/Test_Object__c/Test_Object__c.object-meta.xml"
    );
    const targetFileContent = await readFile(targetFilePath, "utf8");
    const destLocation = getLocationFromFile(
      targetFilePath,
      targetFileContent,
      "Test Object"
    );
    assert.partialDeepStrictEqual(resp.body.definitions[0], destLocation);

    server.sendCommand(CMD_DEFINITION_AND_BOUND_SPAN, {
      file,
      position: fileContent.indexOf("@salesforce/schema/Test_Object__c"),
    });
    const resp2 = await server.waitResponse(CMD_DEFINITION_AND_BOUND_SPAN);
    // linking to the module import means linking to the entire JS file
    assert.partialDeepStrictEqual(resp2.body.definitions[0], destLocation);
  });

  it("Resolve Custom Field", async () => {
    server.sendCommand(CMD_DEFINITION_AND_BOUND_SPAN, {
      file,
      position: fileContent.indexOf("Test_Text__c"), // somewhat vague, could break in future
    });
    const resp = await server.waitResponse(CMD_DEFINITION_AND_BOUND_SPAN);
    const targetFilePath = path.join(
      testProjectPath,
      "force-app/main/default/objects/Test_Object__c/fields/Test_Text__c.field-meta.xml"
    );
    const targetFileContent = await readFile(targetFilePath, "utf8");
    const destLocation = getLocationFromFile(
      targetFilePath,
      targetFileContent,
      "Test_Text__c"
    );
    assert.partialDeepStrictEqual(resp.body.definitions[0], destLocation);

    server.sendCommand(CMD_DEFINITION_AND_BOUND_SPAN, {
      file,
      position: fileContent.indexOf(
        "@salesforce/schema/Test_Object__c.Test_Text__c"
      ),
    });
    const resp2 = await server.waitResponse(CMD_DEFINITION_AND_BOUND_SPAN);
    // linking to the module import means linking to the entire JS file
    assert.partialDeepStrictEqual(resp2.body.definitions[0], destLocation);
  });

  it("Resolve Custom Label", async () => {
    server.sendCommand(CMD_DEFINITION_AND_BOUND_SPAN, {
      file,
      position: fileContent.indexOf("lblAustralia"), // somewhat vague, could break in future
    });
    const resp = await server.waitResponse(CMD_DEFINITION_AND_BOUND_SPAN);
    const targetFilePath = path.join(
      testProjectPath,
      "force-app/main/default/labels/CustomLabels.labels-meta.xml"
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

  it("Resolve Static Resource", async () => {
    server.sendCommand(CMD_DEFINITION_AND_BOUND_SPAN, {
      file,
      position: fileContent.indexOf("bolt"), // somewhat vague, could break in future
    });
    const resp = await server.waitResponse(CMD_DEFINITION_AND_BOUND_SPAN);
    const targetFilePath = path.join(
      testProjectPath,
      "force-app/main/default/staticresources/bolt.resource-meta.xml"
    );
    const targetFileContent = await readFile(targetFilePath, "utf8");
    const destLocation = getLocationFromFile(
      targetFilePath,
      targetFileContent,
      "Sample image of a Lightning Bolt"
    );
    assert.partialDeepStrictEqual(resp.body.definitions[0], destLocation);

    server.sendCommand(CMD_DEFINITION_AND_BOUND_SPAN, {
      file,
      position: fileContent.indexOf("@salesforce/resourceUrl/bolt"),
    });
    const resp2 = await server.waitResponse(CMD_DEFINITION_AND_BOUND_SPAN);
    // linking to the module import means linking to the entire JS file
    assert.partialDeepStrictEqual(resp2.body.definitions[0], destLocation);
  });

  it("Resolve Content Asset", async () => {
    server.sendCommand(CMD_DEFINITION_AND_BOUND_SPAN, {
      file,
      position: fileContent.indexOf("test1"), // somewhat vague, could break in future
    });
    const resp = await server.waitResponse(CMD_DEFINITION_AND_BOUND_SPAN);
    const targetFilePath = path.join(
      testProjectPath,
      "force-app/main/default/contentassets/test1.asset-meta.xml"
    );
    const targetFileContent = await readFile(targetFilePath, "utf8");
    const destLocation = getLocationFromFile(
      targetFilePath,
      targetFileContent,
      "test1"
    );
    assert.partialDeepStrictEqual(resp.body.definitions[0], destLocation);

    server.sendCommand(CMD_DEFINITION_AND_BOUND_SPAN, {
      file,
      position: fileContent.indexOf("@salesforce/contentAssetUrl/test1"),
    });
    const resp2 = await server.waitResponse(CMD_DEFINITION_AND_BOUND_SPAN);
    // linking to the module import means linking to the entire JS file
    assert.partialDeepStrictEqual(resp2.body.definitions[0], destLocation);
  });

  it("Resolve Apex", async () => {
    // the first round of "ready" doesn't include Apex data because the parser is async
    // once the parser is ready and processed any Apex files then we receive this update event from the server
    await server.ensureEvent(EVT_SUGGESTION_DIAG);
    server.sendCommand(CMD_DEFINITION_AND_BOUND_SPAN, {
      file,
      position: fileContent.indexOf("getFile2Data"),
    });
    const resp = await server.waitResponse(CMD_DEFINITION_AND_BOUND_SPAN);
    const targetFilePath = path.join(
      testProjectPath,
      "force-app/main/default/classes/File2.cls"
    );
    const targetFileContent = await readFile(targetFilePath, "utf8");
    const destLocation = getLocationFromFile(
      targetFilePath,
      targetFileContent,
      "getFile2Data"
    );
    assert.partialDeepStrictEqual(resp.body.definitions[0], destLocation);

    server.sendCommand(CMD_DEFINITION_AND_BOUND_SPAN, {
      file,
      position: fileContent.indexOf("@salesforce/apex/File2.getFile2Data"),
    });
    const resp2 = await server.waitResponse(CMD_DEFINITION_AND_BOUND_SPAN);
    assert.partialDeepStrictEqual(resp2.body.definitions[0], destLocation);
  });

  it("Resolve Apex Continuation", async () => {
    server.sendCommand(CMD_DEFINITION_AND_BOUND_SPAN, {
      file,
      position: fileContent.indexOf("startRequest"), // somewhat vague, could break in future
    });
    const resp = await server.waitResponse(CMD_DEFINITION_AND_BOUND_SPAN);
    const targetFilePath = path.join(
      testProjectPath,
      "force-app/main/default/classes/File3.cls"
    );
    const targetFileContent = await readFile(targetFilePath, "utf8");
    const destLocation = getLocationFromFile(
      targetFilePath,
      targetFileContent,
      "startRequest"
    );
    assert.partialDeepStrictEqual(resp.body.definitions[0], destLocation);

    server.sendCommand(CMD_DEFINITION_AND_BOUND_SPAN, {
      file,
      position: fileContent.indexOf(
        "@salesforce/apexContinuation/File3.startRequest"
      ),
    });
    const resp2 = await server.waitResponse(CMD_DEFINITION_AND_BOUND_SPAN);
    // linking to the module import means linking to the entire JS file
    assert.partialDeepStrictEqual(resp2.body.definitions[0], destLocation);
  });

  // auto-completion suggestion for partial text ( another file )

  // Test_Object_2__c exists just to ensure we check for `/fields` before trying to read it
});
