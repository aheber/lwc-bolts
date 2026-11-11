import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { findSfdxRoot, SfdxProject } from "../src/index.ts";

/** The example SFDX project, in tests/fixtures at the repo root. */
const exampleProject = path.join(import.meta.dirname, "../../../tests/fixtures/example-project");
/** An SFDX project whose custom labels are decomposed (`decomposeCustomLabelsBeta2`). */
const decomposedLabels = path.join(import.meta.dirname, "../../../tests/fixtures/decomposed-labels");

const tempDirs: string[] = [];
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A copy of the example project, for tests that change its files, without its install or .sfdx. */
function copyProject(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "lwc-bolts-sfdx-project-")));
  tempDirs.push(dir);
  cpSync(exampleProject, dir, { recursive: true, filter: (source) => !["node_modules", ".sfdx"].includes(path.basename(source)) });
  return dir;
}
const write = (dir: string, file: string, content: string) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), content);
};

describe("SfdxProject", () => {
  it("is found by walking up to sfdx-project.json", () => {
    assert.equal(findSfdxRoot(path.join(exampleProject, "sales/lwc/salesOrderList")), exampleProject);
    assert.equal(findSfdxRoot(path.parse(exampleProject).root), undefined);
  });

  it("resolves primary files to metadata types the caller supports", async () => {
    const project = await SfdxProject.load(exampleProject);
    const all = () => true;
    assert.equal(project.resolveType(path.join(exampleProject, "force-app/main/default/classes/File1.cls"), all), "ApexClass");
    assert.equal(
      project.resolveType(path.join(exampleProject, "sales/objects/Sales_Order__c/fields/Amount__c.field-meta.xml"), all),
      "CustomField",
    );
    // companion files aren't primary files, and unsupported types are left out
    assert.equal(project.resolveType(path.join(exampleProject, "force-app/main/default/classes/File1.cls-meta.xml"), all), undefined);
    assert.equal(
      project.resolveType(path.join(exampleProject, "force-app/main/default/classes/File1.cls"), (type) => type !== "ApexClass"),
      undefined,
    );
    assert.equal(project.resolveType(path.join(path.dirname(exampleProject), "elsewhere.cls"), all), undefined, "outside the project");
  });

  it("resolves decomposed labels by sfdx-project.json's sourceBehaviorOptions", async () => {
    const project = await SfdxProject.load(decomposedLabels);
    const label = path.join(decomposedLabels, "force-app/main/default/labels/Australia.label-meta.xml");
    assert.equal(
      project.resolveType(label, () => true),
      "CustomLabel",
    );
  });

  it("changes identity with sfdx-project.json content", async () => {
    const dir = copyProject();
    const original = (await SfdxProject.load(dir)).identity;
    assert.match(original, /^[0-9a-f]{64}$/);
    const projectFile = path.join(dir, "sfdx-project.json");
    const content = readFileSync(projectFile, "utf8");
    writeFileSync(projectFile, JSON.stringify({ ...JSON.parse(content), namespace: "acme" }));
    const changed = (await SfdxProject.load(dir)).identity;
    writeFileSync(projectFile, content);
    assert.notEqual(changed, original);
    assert.equal((await SfdxProject.load(dir)).identity, original, "the same content, the same identity");
  });

  it("changes identity when .forceignore is edited, removed or added", async () => {
    const dir = copyProject();
    const identity = async () => (await SfdxProject.load(dir)).identity;
    const original = await identity();
    writeFileSync(path.join(dir, ".forceignore"), "**/TestPerm.customPermission-meta.xml\n");
    const edited = await identity();
    rmSync(path.join(dir, ".forceignore"));
    const missing = await identity();
    writeFileSync(path.join(dir, ".forceignore"), "");
    const empty = await identity();
    assert.equal(new Set([original, edited, missing, empty]).size, 4);
  });

  it("changes identity when the SObject definitions are refreshed", async () => {
    const dir = copyProject();
    const before = (await SfdxProject.load(dir)).identity;
    write(dir, ".sfdx/tools/soqlMetadata/typeNames.json", "[]");
    assert.notEqual((await SfdxProject.load(dir)).identity, before);
  });

  it("is shared by the TypeScript projects in it until its configuration changes", async () => {
    const dir = copyProject();
    const first = await SfdxProject.load(dir);
    // e.g. force-app/main/default/lwc/tsconfig.json and sales/lwc/tsconfig.json
    assert.equal(await SfdxProject.load(dir), first);
    writeFileSync(path.join(dir, ".forceignore"), "**/jsconfig.json\n**/Other.cls\n");
    const changed = await SfdxProject.load(dir);
    assert.notEqual(changed, first);
    assert.notEqual(changed.identity, first.identity);
    assert.equal(await SfdxProject.load(dir), changed);
    assert.deepEqual(changed.watchedFiles, [
      path.join(dir, "sfdx-project.json"),
      path.join(dir, ".forceignore"),
      path.join(dir, ".sfdx/tools/soqlMetadata/typeNames.json"),
    ]);
  });

  it("reads the project's namespace from sfdx-project.json, and sees it change", async () => {
    const dir = copyProject();
    assert.equal((await SfdxProject.load(dir)).namespace, undefined);
    const projectFile = path.join(dir, "sfdx-project.json");
    const withNamespace = (namespace: string) =>
      writeFileSync(projectFile, JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }], namespace }));
    withNamespace("acme");
    assert.equal((await SfdxProject.load(dir)).namespace, "acme");
    // an empty namespace, which sf project generate writes, is none
    withNamespace("");
    assert.equal((await SfdxProject.load(dir)).namespace, undefined);
  });

  it("finds a component's module in the same lwc folder, then in any package directory", async () => {
    const project = await SfdxProject.load(exampleProject);
    const salesLwc = path.join(exampleProject, "sales/lwc");
    assert.equal(
      project.findComponentModule("baseCard", salesLwc),
      path.join(exampleProject, "common/main/default/lwc/baseCard/baseCard.js"),
    );
    assert.equal(project.findComponentModule("salesOrderList", salesLwc), path.join(salesLwc, "salesOrderList/salesOrderList.js"));
    assert.equal(project.findComponentModule("missing", salesLwc), undefined);
  });

  it("finds the bundle a component's file belongs to through SDR, from the bundle's subfolders too", async () => {
    const dir = copyProject();
    const lwc = path.join(dir, "sales/lwc");
    const panel = path.join(lwc, "panel");
    for (const file of [
      "panel/panel.js",
      "panel/panel.js-meta.xml",
      "panel/templates/panel.html",
      "panel/views/mobile/compact.html",
      "noMeta/noMeta.html",
    ]) {
      write(lwc, file, "");
    }
    write(dir, "sales/staticresources/page.html", "");
    const project = await SfdxProject.load(dir);
    assert.equal(project.componentBundle(path.join(lwc, "salesOrderList/salesOrderList.html")), path.join(lwc, "salesOrderList"));
    assert.equal(project.componentBundle(path.join(panel, "templates/panel.html")), panel);
    assert.equal(project.componentBundle(path.join(panel, "views/mobile/compact.html")), panel);
    assert.equal(project.componentBundle(path.join(panel, "panel.js")), panel);
    // whatever SDR says is a bundle is one, with or without its metadata file
    assert.equal(project.componentBundle(path.join(lwc, "noMeta/noMeta.html")), path.join(lwc, "noMeta"));

    assert.equal(project.componentBundle(path.join(dir, "sales/staticresources/page.html")), undefined, "not in a bundle");
    assert.equal(project.componentBundle(path.join(panel, "unsaved.html")), undefined, "not on disk");
    assert.equal(project.componentBundle(path.join(path.dirname(dir), "lwc/x/x.html")), undefined, "outside the project");
  });

  it("leaves files the project ignores out of bundles", async () => {
    const dir = copyProject();
    const bundle = path.join(dir, "sales/lwc/salesOrderList");
    write(bundle, "__tests__/fixture.html", "");
    write(bundle, "drafts/draft.html", "");
    const forceIgnore = path.join(dir, ".forceignore");
    writeFileSync(forceIgnore, "**/jsconfig.json\n**/tsconfig.json\n**/drafts/**\n");
    const project = await SfdxProject.load(dir);
    assert.equal(project.componentBundle(path.join(bundle, "drafts/draft.html")), undefined);
    // SDR has no default for Jest's __tests__ folders; projects generated by `sf` ignore them
    assert.equal(project.componentBundle(path.join(bundle, "__tests__/fixture.html")), bundle);
    writeFileSync(forceIgnore, "**/__tests__/**\n");
    assert.equal((await SfdxProject.load(dir)).componentBundle(path.join(bundle, "__tests__/fixture.html")), undefined);
  });

  it("keeps a separate project for each respectForceIgnore setting, which resolves what .forceignore denies when off", async () => {
    const dir = copyProject();
    const bundle = path.join(dir, "sales/lwc/salesOrderList");
    write(bundle, "drafts/draft.html", "");
    writeFileSync(path.join(dir, ".forceignore"), "**/drafts/**\n");
    const respected = await SfdxProject.load(dir);
    const ignored = await SfdxProject.load(dir, { respectForceIgnore: false });
    assert.notEqual(ignored, respected);
    assert.equal(await SfdxProject.load(dir, { respectForceIgnore: true }), respected);
    assert.equal(await SfdxProject.load(dir, { respectForceIgnore: false }), ignored);
    assert.equal([respected.respectForceIgnore, ignored.respectForceIgnore].join(), "true,false");
    assert.equal(respected.componentBundle(path.join(bundle, "drafts/draft.html")), undefined);
    assert.equal(ignored.componentBundle(path.join(bundle, "drafts/draft.html")), bundle);
  });

  it("finds a component's module only in a bundle SDR resolves, so not one .forceignore denies", async () => {
    const dir = copyProject();
    const lwc = path.join(dir, "sales/lwc");
    write(lwc, "card/card.js", "export default class Card {}\n");
    write(lwc, "draftCard/draftCard.js", "export default class DraftCard {}\n");
    write(lwc, "notes/notes.md", "");
    writeFileSync(path.join(dir, ".forceignore"), "**/draftCard/**\n");
    const project = await SfdxProject.load(dir);
    assert.equal(project.findComponentModule("card", lwc), path.join(lwc, "card/card.js"));
    assert.equal(project.findComponentModule("draftCard", lwc), undefined, "denied by .forceignore");
    assert.equal(project.findComponentModule("notes", lwc), undefined, "no module");
    const ignoring = await SfdxProject.load(dir, { respectForceIgnore: false });
    assert.equal(ignoring.findComponentModule("draftCard", lwc), path.join(lwc, "draftCard/draftCard.js"));
  });

  it("lists a bundle's templates as SDR walks it, leaving out what .forceignore denies", async () => {
    const dir = copyProject();
    const lwc = path.join(dir, "sales/lwc");
    const bundle = path.join(lwc, "salesOrderList");
    write(bundle, "views/compact.html", "");
    write(bundle, "drafts/draft.html", "");
    write(lwc, "draftCard/draftCard.js", "");
    write(lwc, "draftCard/draftCard.html", "");
    writeFileSync(path.join(dir, ".forceignore"), "**/drafts/**\n**/draftCard/**\n");
    const relative = (files: string[] | undefined) => files?.map((file) => path.relative(bundle, file));
    const project = await SfdxProject.load(dir);
    assert.deepEqual(relative(project.componentTemplates(bundle)), ["salesOrderList.html", "views/compact.html"]);
    assert.equal(project.componentTemplates(path.join(lwc, "draftCard")), undefined, "a bundle .forceignore denies");
    assert.equal(project.componentTemplates(path.join(dir, "sales/classes")), undefined, "not a bundle");
    assert.equal(project.componentTemplates(path.join(path.dirname(dir), "lwc/x")), undefined, "outside the project");
    const ignoring = await SfdxProject.load(dir, { respectForceIgnore: false });
    assert.deepEqual(relative(ignoring.componentTemplates(bundle)), ["drafts/draft.html", "salesOrderList.html", "views/compact.html"]);
    assert.deepEqual(
      ignoring.componentTemplates(path.join(lwc, "draftCard"))?.map((file) => path.relative(lwc, file)),
      ["draftCard/draftCard.html"],
    );
  });

  it("recognizes SObject definitions, and reads their polymorphic relationships from the describes", async () => {
    const dir = copyProject();
    write(dir, ".sfdx/tools/sobjects/standardObjects/Task.cls", "global class Task {}\n");
    write(
      dir,
      ".sfdx/tools/soqlMetadata/standardObjects/Task.json",
      JSON.stringify({
        fields: [
          { referenceTo: ["Account", "Case"], relationshipName: "What" },
          { referenceTo: ["Contact", "Lead"], relationshipName: "Who" },
        ],
      }),
    );
    const project = await SfdxProject.load(dir);
    const task = path.join(dir, ".sfdx/tools/sobjects/standardObjects/Task.cls");
    assert.ok(project.isSObjectDefinition(task));
    assert.ok(!project.isSObjectDefinition(path.join(dir, ".sfdx/tools/264/StandardApexLibrary/System/Address.cls")));
    // with every target, whether or not it has a definition (Who's don't): TypeScript finds out which are declared
    assert.deepEqual(project.polymorphicRelationships(task), {
      polymorphicTargets: { What: ["Account", "Case"], Who: ["Contact", "Lead"] },
    });
    assert.equal(
      project.polymorphicRelationships(path.join(dir, ".sfdx/tools/sobjects/standardObjects/Account.cls")),
      undefined,
      "no describe",
    );
  });

  it("reads no relationships without a usable describe", async () => {
    const dir = copyProject();
    write(dir, ".sfdx/tools/sobjects/standardObjects/Task.cls", "global class Task {}\n");
    const describe = (content: string) => write(dir, ".sfdx/tools/soqlMetadata/standardObjects/Task.json", content);
    const task = path.join(dir, ".sfdx/tools/sobjects/standardObjects/Task.cls");
    const relationships = async () => (await SfdxProject.load(dir)).polymorphicRelationships(task);
    describe(JSON.stringify({ fields: [{ referenceTo: ["Account", "Case"], relationshipName: "What" }] }));
    assert.deepEqual(await relationships(), { polymorphicTargets: { What: ["Account", "Case"] } });

    describe("{ not json");
    assert.equal(await relationships(), undefined, "a describe that isn't JSON");
    describe(JSON.stringify({ name: "Task" }));
    assert.equal(await relationships(), undefined, "a describe without fields");
    describe(JSON.stringify({ fields: [null, { referenceTo: "Account", relationshipName: "What" }] }));
    assert.deepEqual(await relationships(), { polymorphicTargets: {} }, "fields of the wrong shape");
  });
});
