import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getApexParser } from "web-tree-sitter-sfapex";
import { MetadataType, type ApexClassComponent } from "../src/index.ts";
import { convertOne, mappedText, typeCheck } from "./helpers.ts";

function apex(content: string, path: string = "file1/TestClass1.cls"): ApexClassComponent {
  return { path, type: MetadataType.ApexClass, content };
}

describe("Convert:ApexClass", async () => {
  it("Parse AuraEnabled Method", async (t) => {
    const convertedComp = await convertOne(
      apex(`public class TestClass1 {
  @AuraEnabled
  public static void method1(){}
}`),
    );
    t.assert.snapshot(convertedComp.text);
    assert.deepEqual(mappedText(convertedComp), [
      ["TestClass1", "TestClass1"],
      [`"@salesforce/apex/TestClass1.method1"`, "method1"],
      ["method1", "method1"],
    ]);
    assert.deepEqual(typeCheck([convertedComp.text]), []);
  });

  it("Parse Cacheable AuraEnabled Method", async (t) => {
    const convertedComp = await convertOne(
      apex(`public class TestClass1 {
  @AuraEnabled(Cacheable=true)
  public static void method1(){}
}`),
    );
    t.assert.snapshot(convertedComp.text);
    assert.deepEqual(mappedText(convertedComp), [
      ["TestClass1", "TestClass1"],
      [`"@salesforce/apex/TestClass1.method1"`, "method1"],
      ["method1", "method1"],
    ]);
    assert.deepEqual(typeCheck([convertedComp.text]), []);
  });

  it("Class Properties", async (t) => {
    const convertedComp = await convertOne(
      apex(`public class TestClass1 {
  @AuraEnabled
  public String prop1;

  @AuraEnabled
  global Decimal prop2;

  private Integer prop3;

  Datetime prop4;

  @AuraEnabled
  global static String prop5;

  public Id prop6;

  @AuraEnabled
  public static List<String> method1(String blarg, String yip){

  }

  @AuraEnabled(Cacheable=true)
  public static List<String> method2(String blarg, String yip){

  }

  public static List<String> method3(){

  }

}`),
    );
    t.assert.snapshot(convertedComp.text);
    assert.deepEqual(mappedText(convertedComp), [
      ["TestClass1", "TestClass1"],
      ["prop1", "prop1"],
      ["string", "String"],
      ["prop2", "prop2"],
      ["number", "Decimal"],
      ["prop3", "prop3"],
      ["number", "Integer"],
      ["prop4", "prop4"],
      ["string", "Datetime"],
      ["prop5", "prop5"],
      ["string", "String"],
      ["prop6", "prop6"],
      ["string", "Id"],
      [`"@salesforce/apex/TestClass1.method1"`, "method1"],
      ["method1", "method1"],
      [`"@salesforce/apex/TestClass1.method2"`, "method2"],
      ["method2", "method2"],
    ]);
    assert.deepEqual(typeCheck([convertedComp.text]), []);
  });

  describe("inaccessibleApexProperties", () => {
    const source = `public class Fields {
  @AuraEnabled public String shown;
  @AuraEnabled global static String isStatic;
  @AuraEnabled private Integer isPrivate;
  public Id notAuraEnabled;
  Datetime noModifiers;
  /** documented, but not exposed */
  public String documented;
  @AuraEnabled public Inner inner;
  public class Inner {
    @AuraEnabled public String innerShown;
    public String innerHidden;
  }
  @AuraEnabled public static String go() { return ''; }
}`;
    const fieldNames = (text: string) => [...text.matchAll(/^\s+(\w+)\?: /gm)].map((m) => m[1]);

    it('declares fields LWC can\'t read as deprecated by default, as with "include as deprecated"', async () => {
      const byDefault = await convertOne(apex(source, "classes/Fields.cls"));
      const explicit = await convertOne(apex(source, "classes/Fields.cls"), { inaccessibleApexProperties: "include as deprecated" });
      assert.equal(explicit.text, byDefault.text);
      assert.deepEqual(fieldNames(byDefault.text), [
        "shown",
        "isStatic",
        "isPrivate",
        "notAuraEnabled",
        "noModifiers",
        "documented",
        "inner",
        "innerShown",
        "innerHidden",
      ]);
      assert.equal(byDefault.text.match(/@deprecated not exposed/g)?.length, 6);
    });

    it('declares them like other fields with "include", keeping their docs', async () => {
      const byDefault = await convertOne(apex(source, "classes/Fields.cls"));
      const converted = await convertOne(apex(source, "classes/Fields.cls"), { inaccessibleApexProperties: "include" });
      assert.deepEqual(fieldNames(converted.text), fieldNames(byDefault.text));
      assert.doesNotMatch(converted.text, /@deprecated/);
      assert.match(converted.text, /\* documented, but not exposed\n\s+\*\/\n\s+documented\?: /);
      assert.deepEqual(
        typeCheck(
          [converted.text],
          `declare const f: Apex.Fields;
const s: string | undefined = f.notAuraEnabled;
export { s };`,
        ),
        [],
      );
    });

    it('leaves them out with "exclude", in nested classes too, and keeps the rest of the file', async () => {
      const converted = await convertOne(apex(source, "classes/Fields.cls"), { inaccessibleApexProperties: "exclude" });
      assert.deepEqual(fieldNames(converted.text), ["shown", "inner", "innerShown"]);
      assert.doesNotMatch(converted.text, /@deprecated|documented, but not exposed/);
      assert.match(converted.text, /declare module "@salesforce\/apex\/Fields\.go"/);
      // the declarations still map to the fields they declare
      assert.deepEqual(
        mappedText(converted).filter(([text]) => /shown|inner/i.test(text)),
        [
          ["shown", "shown"],
          ["inner", "inner"],
          ["Apex.Fields.Inner", "Inner"],
          ["Inner", "Inner"],
          ["innerShown", "innerShown"],
        ],
      );
      assert.deepEqual(
        typeCheck(
          [converted.text],
          `declare const f: Apex.Fields;
const s: string | undefined = f.shown;
// @ts-expect-error left out, so reading it is an error rather than a deprecation
f.notAuraEnabled;
export { s };`,
        ),
        [],
      );
    });

    it("declares a class with no fields LWC can read as an empty interface", async () => {
      const converted = await convertOne(apex("public class Hidden {\n  public String a;\n  private Integer b;\n}", "classes/Hidden.cls"), {
        inaccessibleApexProperties: "exclude",
      });
      assert.equal(converted.text, "declare namespace Apex {\n  interface Hidden {}\n}\n");
      assert.deepEqual(typeCheck([converted.text]), []);
    });

    it("always declares an SObject definition's fields", async () => {
      const definition = {
        ...apex(
          "global class Account {\n  global String Name;\n  global static Integer Weird;\n}",
          ".sfdx/tools/sobjects/standardObjects/Account.cls",
        ),
        isSobject: true,
      };
      const kept = await convertOne(definition, { inaccessibleApexProperties: "exclude" });
      assert.equal(kept.text, (await convertOne(definition)).text);
      assert.deepEqual(fieldNames(kept.text.split("declare module")[0]!), ["Name", "Weird"]);
    });
  });

  it("Inner Class", async (t) => {
    const convertedComp = await convertOne(
      apex(`public class TestClass1 {
  @AuraEnabled
  public String prop1;

  global class TestClass2 {

    @AuraEnabled
    global Decimal prop2;

    private Integer prop3;


  }

  @AuraEnabled
  global static String prop4;

  @AuraEnabled(Cacheable=true)
  public static List<TestClass1.TestClass2> method1(TestClass1 blarg, TestClass1.TestClass2 yip){

  }
}`),
    );
    t.assert.snapshot(convertedComp.text);
    assert.deepEqual(mappedText(convertedComp), [
      ["TestClass1", "TestClass1"],
      ["prop1", "prop1"],
      ["string", "String"],
      ["prop4", "prop4"],
      ["string", "String"],
      ["TestClass1", "TestClass1"],
      ["TestClass2", "TestClass2"],
      ["prop2", "prop2"],
      ["number", "Decimal"],
      ["prop3", "prop3"],
      ["number", "Integer"],
      [`"@salesforce/apex/TestClass1.method1"`, "method1"],
      ["method1", "method1"],
    ]);
    // nested namespaces must not repeat `declare` (TS1038)
    assert.deepEqual(typeCheck([convertedComp.text]), []);
  });

  it("Continuation", async (t) => {
    const convertedComp = await convertOne(
      apex(`public with sharing class SampleContinuationClass {
    // Callout endpoint as a named credential URL
    // or, as shown here, as the long-running service URL
    private static final String LONG_RUNNING_SERVICE_URL =
        '<insert your callout URL here>';

    // Action method
    @AuraEnabled(continuation=true cacheable=true)
    public static Object startRequest() {
      // Create continuation. Argument is timeout in seconds.
      Continuation con = new Continuation(40);
      // Set callback method
      con.continuationMethod='processResponse';
      // Set state
      con.state='Hello, World!';
      // Create callout request
      HttpRequest req = new HttpRequest();
      req.setMethod('GET');
      req.setEndpoint(LONG_RUNNING_SERVICE_URL);
      // Add callout request to continuation
      con.addHttpRequest(req);
      // Return the continuation
      return con;
    }

    // Callback method
    @AuraEnabled(cacheable=true)
    public static Object processResponse(List<String> labels, Object state) {
      // Get the response by using the unique label
      HttpResponse response = Continuation.getResponse(labels[0]);
      // Set the result variable
      String result = response.getBody();
      return result;
    }
}`),
    );
    t.assert.snapshot(convertedComp.text);
    assert.deepEqual(mappedText(convertedComp), [
      ["SampleContinuationClass", "SampleContinuationClass"],
      ["LONG_RUNNING_SERVICE_URL", "LONG_RUNNING_SERVICE_URL"],
      ["string", "String"],
      [`"@salesforce/apexContinuation/SampleContinuationClass.startRequest"`, "startRequest"],
      ["startRequest", "startRequest"],
      [`"@salesforce/apex/SampleContinuationClass.processResponse"`, "processResponse"],
      ["processResponse", "processResponse"],
    ]);
    assert.deepEqual(typeCheck([convertedComp.text]), []);
  });

  describe("Continuation return types", () => {
    /**
     * @param start the continuation method's body
     * @param callbacks the class's other methods
     */
    const continuation = (start: string, callbacks = "") =>
      convertOne(
        apex(
          `public class Callouts {
    @AuraEnabled(continuation=true cacheable=true)
    public static Object startRequest() {
      Continuation con = new Continuation(40);
      ${start}
      return con;
    }
    ${callbacks}
}`,
          "classes/Callouts.cls",
        ),
      );
    const CALLBACK = `@AuraEnabled(cacheable=true)
    public static List<String> processResponse(List<String> labels, Object state) { return null; }`;
    const startRequest = (declaration: string) =>
      declaration.slice(declaration.indexOf("apexContinuation/Callouts.startRequest"), declaration.indexOf("export default startRequest"));

    it("resolves to what the continuationMethod callback returns", async () => {
      const converted = await continuation("con.continuationMethod='processResponse';", CALLBACK);
      assert.match(startRequest(converted.text), /\(\): Promise<string\[\]>;/);
      assert.match(startRequest(converted.text), /\{ error\?: unknown; data\?: string\[\]; \}/);
      assert.deepEqual(typeCheck([converted.text]), []);
    });

    it("matches the callback's name case-insensitively", async () => {
      const converted = await continuation("con.continuationMethod = 'PROCESSRESPONSE';", CALLBACK);
      assert.match(startRequest(converted.text), /Promise<string\[\]>/);
    });

    it("keeps the declared return type when the callback can't be found", async () => {
      const cases: [string, string][] = [
        ["con.continuationMethod = callbackName;", CALLBACK], // chosen at runtime
        ["con.continuationMethod = 'missing';", CALLBACK], // not in this class
        ["con.continuationMethod = 'processResponse'; con.continuationMethod = 'other';", CALLBACK], // ambiguous
        ["", CALLBACK], // not set
      ];
      for (const [start, callbacks] of cases) {
        const converted = await continuation(start, callbacks);
        assert.match(startRequest(converted.text), /\(\): Promise<unknown>;/, start);
      }
    });
  });

  it("Declares one module for overloaded AuraEnabled methods, which Salesforce rejects", async () => {
    const convertedComp = await convertOne(
      apex(
        `public class Svc {
  @AuraEnabled public static String find(String name) { return null; }
  @AuraEnabled public static String FIND(Integer id) { return null; }
  public static String helper(Integer id) { return null; }
  @AuraEnabled public static String helper(String name) { return null; }
}`,
        "classes/Svc.cls",
      ),
    );
    const modules = [...convertedComp.text.matchAll(/declare module "([^"]+)"/g)].map((m) => m[1]);
    // the first find, and the only @AuraEnabled helper, whichever order they're in
    assert.deepEqual(modules, ["@salesforce/apex/Svc.find", "@salesforce/apex/Svc.helper"]);
    assert.match(convertedComp.text, /\(param: \{ name: string \}\): Promise<string>;\n  \};\n  export default find;/);
    assert.deepEqual(typeCheck([convertedComp.text]), []);
  });

  it("Skips instance AuraEnabled methods, which LWC can't import", async () => {
    const convertedComp = await convertOne(
      apex(
        `public class Getter {
  @AuraEnabled public String getName() { return 'x'; }
  @AuraEnabled public static String getStatic() { return 'x'; }
}`,
        "classes/Getter.cls",
      ),
    );
    assert.doesNotMatch(convertedComp.text, /Getter\.getName/);
    assert.match(convertedComp.text, /declare module "@salesforce\/apex\/Getter\.getStatic"/);
  });

  it("Skips methods whose @AuraEnabled is on something in their body, not on them", async () => {
    const convertedComp = await convertOne(
      apex(
        `public class Body {
  public static String hidden() { @AuraEnabled String s = ''; return s; }
  @AuraEnabled(cacheable=true) public static String shown() { @SuppressWarnings('x') String s = ''; return s; }
}`,
        "classes/Body.cls",
      ),
    );
    assert.doesNotMatch(convertedComp.text, /Body\.hidden/);
    assert.match(convertedComp.text, /declare module "@salesforce\/apex\/Body\.shown"[\s\S]*adapter:/);
  });

  it("Maps Apex types to the JSON values LWC receives", async () => {
    const convertedComp = await convertOne(
      apex(
        `public class Types {
  @AuraEnabled public Long l;
  @AuraEnabled public Double d;
  @AuraEnabled public Date dt;
  @AuraEnabled public Datetime ts;
  @AuraEnabled public Time t;
  @AuraEnabled public Blob b;
  @AuraEnabled public String[] arr;
  @AuraEnabled public Set<String> s;
  @AuraEnabled public static Types get() { return null; }
  @AuraEnabled public static List<String> names() { return null; }
}`,
        "classes/Types.cls",
      ),
    );
    assert.match(
      convertedComp.text,
      /interface Types \{\n    l\?: number;\n    d\?: number;\n    dt\?: string;\n    ts\?: string;\n    t\?: string;\n    b\?: string;\n    arr\?: string\[\];\n    s\?: string\[\];\n  \}/,
    );
    assert.match(convertedComp.text, /\(\): Promise<string\[\]>;/);
    assert.deepEqual(
      typeCheck(
        [convertedComp.text],
        `import get from "@salesforce/apex/Types.get";
import names from "@salesforce/apex/Types.names";
get().then((t) => {
  const n: number | undefined = t.l ?? t.d;
  const iso: string | undefined = t.dt ?? t.ts ?? t.t;
  const base64: string | undefined = t.b;
  const first: string | undefined = t.arr?.[0] ?? t.s?.[0];
});
names().then((list) => {
  const name: string | undefined = list[0];
});`,
      ),
      [],
    );
  });

  it("Keys maps by string, whatever their key type, as JSON does", async () => {
    const converted = await convertOne(
      apex(
        `public class Keyed {
  @AuraEnabled public Map<Account, String> byAccount;
  @AuraEnabled public Map<Integer, Keyed> byNumber;
}`,
        "classes/Keyed.cls",
      ),
    );
    assert.match(converted.text, /byAccount\?: Record<string, string>;\n    byNumber\?: Record<string, Apex\.Keyed>;/);
    assert.deepEqual(typeCheck([converted.text]), []);
  });

  it("Types other generic types as unknown, since their values are whichever class implements them", async () => {
    const converted = await convertOne(
      apex(
        `public class Generic {
  @AuraEnabled public Iterable<String> items;
  @AuraEnabled public Database.Batchable<SObject> job;
}`,
        "classes/Generic.cls",
      ),
    );
    assert.match(converted.text, /items\?: unknown;\n    job\?: unknown;/);
    assert.deepEqual(typeCheck([converted.text]), []);
  });

  it("Types incomplete type references in a class being edited as unknown", async () => {
    const converted = await convertOne(
      apex(
        `public class Editing {
  @AuraEnabled public Map<String> half;
  @AuraEnabled public List<> none;
}`,
        "classes/Editing.cls",
      ),
    );
    assert.match(converted.text, /half\?: Record<string, unknown>;\n    none\?: unknown\[\];/);
    assert.deepEqual(typeCheck([converted.text]), []);
  });

  it("Types Apex Object as any value, including null, that must be narrowed before use", async () => {
    const converted = await convertOne(
      apex(
        `public class Anything {
  @AuraEnabled public Object value;
  @AuraEnabled public static Object echo(Object input) { return input; }
}`,
        "classes/Anything.cls",
      ),
    );
    assert.deepEqual(
      typeCheck(
        [converted.text],
        `import echo from "@salesforce/apex/Anything.echo";
echo({ input: null });
echo({ input: undefined });
echo({ input: 1 });
echo({ input: { nested: [true] } });
echo({ input: "x" }).then((result) => {
  // @ts-expect-error narrow it first
  result.length;
  if (typeof result === "string") {
    const length: number = result.length;
  }
});
const holder: Apex.Anything = { value: null };
export { holder };`,
      ),
      [],
    );
  });

  it("Declares every field of a multi-declarator field declaration", async () => {
    const convertedComp = await convertOne(
      apex(
        `public class Multi {
  @AuraEnabled public String a, b;
  @AuraEnabled public static Multi get() { return null; }
}`,
        "classes/Multi.cls",
      ),
    );
    assert.match(convertedComp.text, /    a\?: string;\n    b\?: string;\n/);
    assert.deepEqual(mappedText(convertedComp).slice(1, 5), [
      ["a", "a"],
      ["string", "String"],
      ["b", "b"],
      ["string", "String"],
    ]);
    assert.deepEqual(typeCheck([convertedComp.text], `import get from "@salesforce/apex/Multi.get"; get().then((m) => m.b);`), []);
  });

  it("Resolves this class's names case-insensitively", async () => {
    const convertedComp = await convertOne(
      apex(
        `public class Casey {
  public class Inner { @AuraEnabled public String v; }
  @AuraEnabled public static casey get(inner i, CASEY.INNER j) { return null; }
}`,
        "classes/Casey.cls",
      ),
    );
    assert.match(convertedComp.text, /\(param: \{ i: Apex\.Casey\.Inner; j: Apex\.Casey\.Inner \}\): Promise<Apex\.Casey>;/);
    assert.deepEqual(typeCheck([convertedComp.text]), []);
  });

  it("Declares field-less classes so other classes can reference them", async () => {
    const file1 = await convertOne(
      apex(
        `public class File1 {
  @AuraEnabled(cacheable=true)
  public static File2 getFile1Data(String prop1, Decimal prop2){}
}`,
        "classes/File1.cls",
      ),
    );
    const file2 = await convertOne(
      apex(
        `public class File2 {
  @AuraEnabled
  public static File1 getFile2Data(Integer prop1, Boolean prop2){}
}`,
        "classes/File2.cls",
      ),
    );
    assert.match(file1.text, /Promise<Apex\.File2>/);
    assert.deepEqual(typeCheck([file1.text, file2.text]), []);
  });

  it("Keeps Apex class names from merging with global types", async () => {
    const convertedComp = await convertOne(
      apex(
        `public class Response {
  @AuraEnabled public Integer code;
  @AuraEnabled public static Response fetch() { return null; }
}`,
        "classes/Response.cls",
      ),
    );
    assert.deepEqual(
      typeCheck(
        [convertedComp.text],
        `import fetchIt from "@salesforce/apex/Response.fetch";
fetchIt().then((r) => {
  const code: number | undefined = r.code;
  // @ts-expect-error the Apex Response is not the DOM Response
  r.json();
});
const dom: Response = new Response();`,
      ),
      [],
    );
  });

  const nestedClass = `public class Outer {
  @AuraEnabled public Inner child;
  public class Inner { @AuraEnabled public String name; }
  @AuraEnabled public static Outer.Inner get(Outer o) { return null; }
}`;

  it("Declares Apex types in a custom (dotted) namespace", async (t) => {
    const convertedComp = await convertOne(apex(nestedClass, "classes/Outer.cls"), { apexNamespace: "Acme.Apex" });
    t.assert.snapshot(convertedComp.text);
    assert.deepEqual(typeCheck([convertedComp.text]), []);
  });

  it("Declares Apex types globally when the namespace is null", async (t) => {
    const convertedComp = await convertOne(apex(nestedClass, "classes/Outer.cls"), { apexNamespace: null });
    t.assert.snapshot(convertedComp.text);
    assert.deepEqual(mappedText(convertedComp), [
      ["Outer", "Outer"],
      ["child", "child"],
      ["Outer.Inner", "Inner"],
      ["Outer", "Outer"],
      ["Inner", "Inner"],
      ["name", "name"],
      ["string", "String"],
      [`"@salesforce/apex/Outer.get"`, "get"],
      ["get", "get"],
    ]);
    assert.deepEqual(typeCheck([convertedComp.text]), []);
  });

  it("Merges with global types of the same name when the namespace is null", async () => {
    const convertedComp = await convertOne(
      apex(
        `public class Response {
  @AuraEnabled public Integer code;
  @AuraEnabled public static Response fetch() { return null; }
}`,
        "classes/Response.cls",
      ),
      { apexNamespace: null },
    );
    // the Apex class merges with the DOM's Response, which is the conflict the namespace prevents
    assert.deepEqual(
      typeCheck(
        [convertedComp.text],
        `import fetchIt from "@salesforce/apex/Response.fetch";
fetchIt().then((r) => {
  const code: number | undefined = r.code;
  r.json();
});`,
      ),
      [],
    );
  });

  it("Carries ApexDoc comments to classes, fields, methods and parameters", async (t) => {
    const convertedComp = await convertOne(
      apex(
        `/**
 * Account helpers.
 * @author Someone
 */
public with sharing class Accounts {
    /** The record name */
    @AuraEnabled public String name;
    /** Internal counter */
    private Integer count;
    /**
     * @description Loads an account by its Id.
     * @param recordId the record
     *   to load
     * @param DEPTH how many levels deep
     * @return the account
     * @example
     *   load({ recordId: '001' });
     */
    @AuraEnabled(cacheable=true)
    public static Accounts load(Id recordId, Integer depth) { return null; }
    @AuraEnabled
    /** Documented after the annotation */
    public static void other() {}
    /* not ApexDoc */
    @AuraEnabled public static void plain() {}
    /** Inner doc */
    public class Inner {}
}`,
        "classes/Accounts.cls",
      ),
    );
    t.assert.snapshot(convertedComp.text);
    // documentation is unmapped, so the mapped names are unchanged
    assert.deepEqual(mappedText(convertedComp), [
      ["Accounts", "Accounts"],
      ["name", "name"],
      ["string", "String"],
      ["count", "count"],
      ["number", "Integer"],
      ["Accounts", "Accounts"],
      ["Inner", "Inner"],
      [`"@salesforce/apex/Accounts.load"`, "load"],
      ["load", "load"],
      [`"@salesforce/apex/Accounts.other"`, "other"],
      ["other", "other"],
      [`"@salesforce/apex/Accounts.plain"`, "plain"],
      ["plain", "plain"],
    ]);
    assert.deepEqual(typeCheck([convertedComp.text]), []);
  });

  it("Documents an @AuraEnabled method's module with its Apex signature, before its ApexDoc", async () => {
    const convertedComp = await convertOne(
      apex(
        `public class Orders {
    /** Loads orders. */
    @AuraEnabled(cacheable=true)
    global static   Map< String ,List<Account> >   load( final Id  recordId,
        String[] names, Map<String,Object> opts ) { return null; }
}`,
        "classes/Orders.cls",
      ),
    );
    // annotations, modifiers and `final` are left out, and the types are spaced as usual
    assert.match(
      convertedComp.text,
      /declare module "@salesforce\/apex\/Orders\.load" \{\n {2}\/\*\*\n {3}\* ---\n {3}\* \*\*Apex\*\*\n {3}\*\n {3}\* ```apex\n {3}\* Map<String, List<Account>> load\(Id recordId, String\[\] names, Map<String, Object> opts\)\n {3}\* ```\n {3}\*\n {3}\* Loads orders\.\n {3}\*\/\n/,
    );
  });

  it("Leaves types it can't resolve (e.g. SObjects) for the project to declare", async () => {
    const convertedComp = await convertOne(
      apex(
        `public class Accounts {
  @AuraEnabled public static List<Account> list() { return null; }
}`,
        "classes/Accounts.cls",
      ),
    );
    assert.match(convertedComp.text, /Promise<Apex\.Account\[\]>/);
    assert.deepEqual(typeCheck([convertedComp.text]), [
      "decl0.ts:14 TS2724: 'Apex' has no exported member named 'Account'. Did you mean 'Accounts'?",
    ]);
    // declaring the SObject in the Apex namespace resolves it
    assert.deepEqual(typeCheck([convertedComp.text, "declare namespace Apex { interface Account { Name?: string } }"]), []);
  });

  it("SObject and Json types", async () => {
    const convertedComp = await convertOne(
      apex(
        `public class Holder {
  @AuraEnabled public SObject record;
  @AuraEnabled public List<SObject> records;
}`,
        "classes/Holder.cls",
      ),
    );
    assert.match(convertedComp.text, /record\?: Record<string, unknown>;\n    records\?: Record<string, unknown>\[\];/);
    assert.deepEqual(typeCheck([convertedComp.text]), []);
  });

  describe("SObject definitions", () => {
    // The shape the Salesforce extensions generate in .sfdx/tools/sobjects
    const SOBJECT = `// This file is generated as an Apex representation of the
//     corresponding sObject and its fields.

global class Account {
    global String AccountNumber;
    global List<Contact> Contacts;
    global User CreatedBy;
    global Datetime CreatedDate;
    /* The account's annual revenue,
    in the org's currency.
    */
    global Decimal AnnualRevenue;
    global SObject Owner;
    global Json Records;

    global Account () 
    {
    }
}
`;
    const sobject = (content: string) => ({ ...apex(content, ".sfdx/tools/sobjects/standardObjects/Account.cls"), isSobject: true });
    /** The record type, without the schema modules that follow it. */
    const recordType = (declaration: string) => declaration.slice(0, declaration.indexOf("declare module"));

    it("exposes fields without @AuraEnabled and documents them from block comments", async (t) => {
      const convertedComp = await convertOne(sobject(SOBJECT));
      t.assert.snapshot(recordType(convertedComp.text));
      assert.deepEqual(
        typeCheck([convertedComp.text, "declare namespace Apex { interface Contact { Name?: string } interface User { Name?: string } }"]),
        [],
      );
    });

    it("flags the same fields as not exposed in an ordinary class", async () => {
      const convertedComp = await convertOne(apex(SOBJECT, "classes/Account.cls"));
      assert.match(convertedComp.text, /\/\*\* @deprecated not exposed; property must be @AuraEnabled \*\/\n    AccountNumber/);
      // ordinary block comments aren't ApexDoc
      assert.doesNotMatch(convertedComp.text, /annual revenue/);
    });

    it("skips fields without a type", async (t) => {
      // the generator writes some fields (e.g. UriEvent.RecordId) without their type
      const convertedComp = await convertOne(
        sobject(`global class UriEvent {
    global String Message;
    global  RecordId;
    global Id UserId;
}`),
      );
      t.assert.snapshot(recordType(convertedComp.text));
    });

    it("declares no Apex method modules", async () => {
      const convertedComp = await convertOne(
        sobject(`global class Account {
    global String Name;
    @AuraEnabled global static String describe() { return null; }
}`),
      );
      assert.doesNotMatch(convertedComp.text, /declare module "@salesforce\/apex/);
    });

    it("declares schema modules for the object and the fields LWC can import", async () => {
      const convertedComp = await convertOne(
        sobject(`global class Account {
    global String Name;
    /* The parent account
    */
    global Id ParentId;
    global Account Parent;
    global SObject Owner;
    global Id OwnerId;
    global Address BillingAddress;
    global List<Contact> Contacts;
    global Account Thing__r;
    global Id Thing__c;
}`),
      );
      const modules = [...convertedComp.text.matchAll(/declare module "([^"]+)"/g)].map((m) => m[1]);
      assert.deepEqual(modules, [
        "*@salesforce/schema/Account",
        "*@salesforce/schema/Account.Name",
        "*@salesforce/schema/Account.ParentId",
        "*@salesforce/schema/Account.OwnerId",
        "*@salesforce/schema/Account.BillingAddress",
        "*@salesforce/schema/Account.Thing__c",
      ]);
      assert.match(
        convertedComp.text,
        /declare module "\*@salesforce\/schema\/Account\.ParentId" \{\n  \/\*\*\n   \* The parent account\n   \*\/\n  const ParentId: \{\n    fieldApiName: "ParentId";\n    objectApiName: "Account";\n  \};\n  export default ParentId;\n\}/,
      );
      // go-to-definition on an import lands on the field in the definition
      assert.deepEqual(
        mappedText(convertedComp).filter(([generated]) => generated.includes("schema/Account.Name")),
        [[`"*@salesforce/schema/Account.Name"`, "Name"]],
      );
      assert.deepEqual(
        typeCheck([
          convertedComp.text,
          "declare namespace Apex { interface Contact {} interface Address {} }",
          `import ACCOUNT from "@salesforce/schema/Account";
import NAME from "@salesforce/schema/Account.Name";
import BILLING from "@salesforce/schema/Account.BillingAddress";
export const object: "Account" = ACCOUNT.objectApiName;
export const field: "Name" = NAME.fieldApiName;
export const compound: "BillingAddress" = BILLING.fieldApiName;
`,
        ]),
        [],
      );
    });

    it("gives way to the project's own schema modules", async () => {
      // the project's metadata for a standard field (e.g. its picklist values) declares the same module
      const definition = await convertOne(sobject(`global class Account {\n    global String Industry;\n}`));
      const field = await convertOne({
        path: "objects/Account/fields/Industry.field-meta.xml",
        type: MetadataType.CustomField,
        content: `<CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>Industry</fullName><description>From the project</description><type>Picklist</type></CustomField>`,
      });
      const object = await convertOne({
        path: "objects/Account/Account.object-meta.xml",
        type: MetadataType.CustomObject,
        content: `<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><label>Account</label></CustomObject>`,
      });
      assert.deepEqual(
        typeCheck([
          definition.text,
          field.text,
          object.text,
          `import INDUSTRY from "@salesforce/schema/Account.Industry";
import ACCOUNT from "@salesforce/schema/Account";
export const industry: "Industry" = INDUSTRY.fieldApiName;
export const account: "Account" = ACCOUNT.objectApiName;
`,
        ]),
        [],
      );
    });

    describe("polymorphic relationships", () => {
      const TASK = `global class Task {
    global SObject What;
    global Id WhatId;
    global SObject Who;
    global Id WhoId;
    global SObject Owner;
    global Id OwnerId;
    global String Subject;
}`;
      const targets = { What: ["Account", "Case"], who: ["Contact", "Lead"] };
      /** The objects' declarations, each in the SObjects' registry, as their definitions' output declares them. */
      const objects = (...names: string[]) => {
        const fields: Record<string, string> = {
          Name: "Id?: string; Name?: string; Type?: string",
          Account: "Id?: string; Name?: string; Industry?: string",
          Case: "Id?: string; CaseNumber?: string",
          Contact: "Id?: string; Name?: string; Email?: string",
          Lead: "Id?: string; Name?: string; Email?: string",
        };
        return `declare namespace Apex {
${names.map((name) => `  interface ${name} { ${fields[name]} }\n  interface __lwcSObjects { ${JSON.stringify(name.toLowerCase())}: ${name} }\n`).join("")}}`;
      };
      const field = (declaration: string, name: string) => new RegExp(`\\n    ${name}\\?: ([^;]+);`).exec(declaration)?.[1];

      it("types them as one of their targets, with the Name object's fields", async () => {
        const converted = await convertOne({ ...sobject(TASK), polymorphicTargets: targets });
        // relationship names match case-insensitively; relationships without targets stay SObject
        assert.equal(
          field(converted.text, "What"),
          'Apex.__lwcSObjects extends { "account": infer T0 } ? Apex.__lwcSObjects extends { "case": infer T1 } ? ' +
            'Apex.__lwcSObjects extends { "name": infer N } ? N & (T0 | T1) : T0 | T1 : Record<string, unknown> : Record<string, unknown>',
        );
        assert.match(field(converted.text, "Who")!, /\{ "contact": infer T0 \}.*\{ "lead": infer T1 \}/);
        assert.equal(field(converted.text, "Owner"), "Record<string, unknown>");
        // the type maps back to the field's declared SObject type
        assert.ok(
          mappedText(converted).some(([generated, original]) => generated === field(converted.text, "What") && original === "SObject"),
        );
        assert.deepEqual(
          typeCheck([
            converted.text,
            objects("Name", "Account", "Case", "Contact", "Lead"),
            `declare const task: Apex.Task;
// the Name object's fields, which a query returns for any target, even Case
export const name: string | undefined = task.What?.Name;
export const type: string | undefined = task.What?.Type;
// fields every target has
export const email: string | undefined = task.Who?.Email;
// @ts-expect-error Industry is only on Account
export const industry = task.What?.Industry;
`,
          ]),
          [],
        );
      });

      it("types them as a union of their targets without the Name object", async () => {
        const converted = await convertOne({ ...sobject(TASK), polymorphicTargets: targets });
        assert.deepEqual(
          typeCheck([
            converted.text,
            objects("Account", "Case", "Contact", "Lead"),
            `declare const task: Apex.Task;
export const what: Apex.Account | Apex.Case | undefined = task.What;
// @ts-expect-error Case has no Name, and there's no Name object to have it
export const name = task.What?.Name;
`,
          ]),
          [],
        );
      });

      it("leaves them SObject until every target is declared", async () => {
        const converted = await convertOne({ ...sobject(TASK), polymorphicTargets: targets });
        // Case isn't declared, so What is any record; Who's targets both are
        assert.deepEqual(
          typeCheck([
            converted.text,
            objects("Name", "Account", "Contact", "Lead"),
            `declare const task: Apex.Task;
export const what: Record<string, unknown> | undefined = task.What;
export const anything: unknown = task.What?.Anything;
// @ts-expect-error Who is a Contact or a Lead
export const whoAnything = task.Who?.Anything;
`,
          ]),
          [],
        );
      });

      it("only applies to fields declared as SObject in SObject definitions", async () => {
        const typed = await convertOne({ ...sobject(TASK), polymorphicTargets: { Subject: ["Account", "Case"] } });
        assert.equal(field(typed.text, "Subject"), "string");
        const ordinary = await convertOne({
          ...apex("public class Holder {\n  @AuraEnabled public SObject What;\n}", "classes/Holder.cls"),
          polymorphicTargets: targets,
        });
        assert.equal(field(ordinary.text, "What"), "Record<string, unknown>");
      });

      it("uses the apexNamespace option", async () => {
        const converted = await convertOne({ ...sobject(TASK), polymorphicTargets: targets }, { apexNamespace: null });
        assert.match(converted.text, /\n  What\?: __lwcSObjects extends \{ "account": infer T0 \} \? /);
      });
    });

    it("prefixes field names that are reserved words", async () => {
      const convertedComp = await convertOne(sobject(`global class Thing__c {\n    global String default;\n}`));
      assert.match(convertedComp.text, /const _default: \{\n    fieldApiName: "default";/);
      assert.deepEqual(typeCheck([convertedComp.text]), []);
    });

    it("lets project classes reference SObjects", async () => {
      const definition = await convertOne(sobject(SOBJECT));
      const controller = await convertOne(
        apex(
          `public class Accounts {
  @AuraEnabled public static List<Account> list() { return null; }
}`,
          "classes/Accounts.cls",
        ),
      );
      assert.deepEqual(
        typeCheck([definition.text, controller.text, "declare namespace Apex { interface Contact {} interface User {} }"]),
        [],
      );
    });
  });

  it("deletes each parse tree, whose WebAssembly memory isn't garbage collected", async () => {
    const parser = await getApexParser();
    const Tree = Object.getPrototypeOf(parser.parse("public class Probe {}"));
    const remove = Tree.delete;
    let deleted = 0;
    Tree.delete = function (this: unknown) {
      deleted++;
      remove.call(this);
    };
    try {
      // a class, a file without a type, and one that fails
      await convertOne(apex("public class A { @AuraEnabled public static String go() { return null; } }"));
      await convertOne(apex("// no type"));
      const failed = await convertOne(apex("public class {"));
      assert.equal(failed.diagnostics?.[0]?.kind, "ConversionFailed");
    } finally {
      Tree.delete = remove;
    }
    assert.equal(deleted, 3);
  });

  describe("enums, interfaces, base classes and the standard library", () => {
    const convertAll = async (files: Record<string, string>, options?: { apexNamespace?: string | null }) =>
      Promise.all(
        Object.entries(files).map(([path, content]) =>
          convertOne(path.includes(".sfdx/tools/sobjects") ? { ...apex(content, path), isSobject: true } : apex(content, path), options),
        ),
      );
    const check = async (files: Record<string, string>, consumer: string, options?: { apexNamespace?: string | null }) => {
      const converted = await convertAll(files, options);
      assert.deepEqual(
        converted.map((c) => c.diagnostics),
        converted.map(() => undefined),
      );
      return typeCheck(
        converted.map((c) => c.text),
        consumer,
      );
    };

    it("declares enums as their values' names, and interfaces as any object", async () => {
      const files = {
        "classes/Color.cls": "/** A color. */\npublic enum Color { RED, GREEN }",
        "classes/Shape.cls": "public interface Shape { Decimal area(); }",
        "classes/Ctrl.cls": `public class Ctrl {
    public enum Size { SMALL, LARGE }
    public interface Sized { Size size(); }
    @AuraEnabled public Size size;
    @AuraEnabled public Sized sized;
    @AuraEnabled public static Shape shape() { return null; }
    @AuraEnabled public static Color paint(Size s) { return null; }
}`,
      };
      const [color, shape] = await convertAll(files);
      assert.equal(color?.text, 'declare namespace Apex {\n  /**\n   * A color.\n   */\n  type Color = "RED" | "GREEN";\n}\n');
      assert.deepEqual(mappedText(color!).slice(0, 3), [
        ["Color", "Color"],
        ['"RED"', "RED"],
        ['"GREEN"', "GREEN"],
      ]);
      assert.equal(shape?.text, "declare namespace Apex {\n  interface Shape extends Record<string, unknown> {}\n}\n");
      assert.deepEqual(
        await check(
          files,
          `import paint from "@salesforce/apex/Ctrl.paint";
import shape from "@salesforce/apex/Ctrl.shape";
const color: "RED" | "GREEN" = await paint({ s: "SMALL" });
const area: unknown = (await shape()).area;
const size: "SMALL" | "LARGE" | undefined = ({} as Apex.Ctrl).size;
// @ts-expect-error not one of the enum's values
await paint({ s: "MEDIUM" });
export { color, area, size };`,
        ),
        [],
      );
    });

    it("declares a class as extending its base class, so it has the base's fields", async () => {
      assert.deepEqual(
        await check(
          {
            "classes/Base.cls": "public virtual class Base { @AuraEnabled public Id recordId; }",
            "classes/Dto.cls": "public class Dto extends Base { @AuraEnabled public String name; public class Line extends Dto {} }",
          },
          `const line = {} as Apex.Dto.Line;
const id: string | undefined = line.recordId;
const name: string | undefined = line.name;
export { id, name };`,
        ),
        [],
      );
    });

    describe("references to the standard library", () => {
      const exceptions = {
        "classes/MyException.cls": "public class MyException extends Exception { @AuraEnabled public String detail; }",
        "classes/Errors.cls": `public class Errors {
    @AuraEnabled public Exception error;
    @AuraEnabled public System.Exception systemError;
    @AuraEnabled public DmlException dml;
}`,
      };
      // whether a type has the project Exception's `code`
      const hasCode = (expected: { myException: boolean; error: boolean }) => `type HasCode<T> = "code" extends keyof T ? true : false;
const myException: HasCode<Apex.MyException> = ${expected.myException};
const error: HasCode<NonNullable<Apex.Errors["error"]>> = ${expected.error};
const systemError: HasCode<NonNullable<Apex.Errors["systemError"]>> = false;
const dml: HasCode<NonNullable<Apex.Errors["dml"]>> = false;
const detail: string | undefined = ({} as Apex.MyException).detail;
export { myException, error, systemError, dml, detail };`;

      it("resolve unqualified names to the library's types", async () => {
        assert.deepEqual(await check(exceptions, hasCode({ myException: false, error: false })), []);
      });

      it("resolve to the project's type of the same name instead, which shadows the library's", async () => {
        const files = { ...exceptions, "classes/Exception.cls": "public class Exception { @AuraEnabled public Integer code; }" };
        assert.deepEqual(await check(files, hasCode({ myException: true, error: true })), []);
        // and the expectations do tell the two apart
        assert.notDeepEqual(await check(files, hasCode({ myException: false, error: false })), []);
      });

      it("resolve a project class that shadows a library type in its own fields and in subclasses", async () => {
        const files = {
          "classes/Exception.cls":
            "public virtual class Exception { @AuraEnabled public Integer code; @AuraEnabled public Exception cause; @AuraEnabled public List<Exception> all; }",
          "classes/AppException.cls": "public class AppException extends Exception { @AuraEnabled public Exception wrapped; }",
        };
        const consumer = `const e = {} as Apex.AppException;
const code: number | undefined = e.code;
const causeCode: number | undefined = e.cause?.cause?.code;
const allCode: number | undefined = e.all?.[0]?.code;
const wrappedCode: number | undefined = e.wrapped?.code;
// @ts-expect-error the project's Exception has no message
e.cause?.message;
export { code, causeCode, allCode, wrappedCode };`;
        assert.deepEqual(await check(files, consumer), []);
      });

      // an SObject's Name is a string; System types' properties are unknown
      const isSObject = `type IsSObject<T> = unknown extends T[keyof T & "Name"] ? false : true;`;

      it("keep a project class's references apart from an SObject definition's of the same name", async () => {
        const files = {
          ".sfdx/tools/sobjects/standardObjects/Account.cls":
            "global class Account { global String Name; global Address BillingAddress; global Assert Check; }",
          ".sfdx/tools/sobjects/standardObjects/Contact.cls": "global class Contact { global String Name; }",
          "classes/Account.cls": `public class Account {
    @AuraEnabled public Address shipping;
    @AuraEnabled public Assert verified;
    @AuraEnabled public Contact contact;
    @AuraEnabled public Line line;
    public class Line { @AuraEnabled public Integer quantity; }
}`,
        };
        // an SObject's Name is a string; System types' properties are unknown, and System.Assert has none
        const consumer = (assertIsSObject: boolean) => `type HasName<T> = "Name" extends keyof T ? true : false;
const account = {} as Apex.Account;
const billing: unknown = account.BillingAddress?.city;
const shipping: unknown = account.shipping?.city;
const check: HasName<NonNullable<Apex.Account["Check"]>> = ${assertIsSObject};
const verified: HasName<NonNullable<Apex.Account["verified"]>> = ${assertIsSObject};
const contact: string | undefined = account.contact?.Name;
const quantity: number | undefined = account.line?.quantity;
export { billing, shipping, check, verified, contact, quantity };`;
        // System.Assert
        assert.deepEqual(await check(files, consumer(false)), []);
        // an SObject named Assert, which shadows it
        assert.deepEqual(
          await check(
            { ...files, ".sfdx/tools/sobjects/customObjects/Assert.cls": "global class Assert { global String Name; }" },
            consumer(true),
          ),
          [],
        );
      });

      it("resolve to an SObject in Schema before a type in System", async () => {
        const definitions = {
          "classes/Visit.cls": "public class Visit { @AuraEnabled public Assert check; @AuraEnabled public System.Assert systemCheck; }",
        };
        // System.Assert has no properties
        const consumer = (sobject: boolean) => `type HasName<T> = "Name" extends keyof T ? true : false;
const check: HasName<NonNullable<Apex.Visit["check"]>> = ${sobject};
const systemCheck: HasName<NonNullable<Apex.Visit["systemCheck"]>> = false;
export { check, systemCheck };`;
        // System.Assert
        assert.deepEqual(await check(definitions, consumer(false)), []);
        // an SObject named Assert, from the Salesforce extensions' definitions
        const withSObject = {
          ...definitions,
          ".sfdx/tools/sobjects/customObjects/Assert.cls": "global class Assert { global String Name; }",
        };
        assert.deepEqual(await check(withSObject, consumer(true)), []);
      });

      it("resolve Address and Location to the compound field types before the SObjects, as configured", async () => {
        const files = {
          ".sfdx/tools/sobjects/standardObjects/Address.cls": "global class Address { global String Name; }",
          ".sfdx/tools/sobjects/standardObjects/Location.cls": "global class Location { global String Name; }",
          ".sfdx/tools/sobjects/standardObjects/Account.cls":
            "global class Account { global Address BillingAddress; global Schema.Location Site__r; }",
        };
        assert.deepEqual(
          await check(
            files,
            `${isSObject}
const billing: IsSObject<NonNullable<Apex.Account["BillingAddress"]>> = false;
const site: IsSObject<NonNullable<Apex.Account["Site__r"]>> = true;
export { billing, site };`,
          ),
          [],
        );
      });

      it("declare library types with their base classes and enum values, in any namespace option", async () => {
        const files = {
          "classes/A.cls": "public class A { @AuraEnabled public Address address; @AuraEnabled public Schema.DisplayType kind; }",
          // the same library types, declared again, merge
          "classes/B.cls": "public class B { @AuraEnabled public System.Address address; @AuraEnabled public Schema.DisplayType kind; }",
        };
        for (const apexNamespace of [undefined, "Org.Apex", null]) {
          const prefix = apexNamespace === undefined ? "Apex." : apexNamespace === null ? "" : "Org.Apex.";
          assert.deepEqual(
            await check(
              files,
              `const a = {} as ${prefix}A;
const latitude: unknown = a.address?.latitude;
const kind: "PICKLIST" | "STRING" | undefined = a.kind === "PICKLIST" || a.kind === "STRING" ? a.kind : undefined;
// @ts-expect-error not a DisplayType
const wrong: ${prefix}B["kind"] = "NOPE";
export { latitude, kind, wrong };`,
              { apexNamespace },
            ),
            [],
            String(apexNamespace),
          );
        }
      });

      it("keep System's primitive types primitive, and take Schema's other names as SObjects", async () => {
        const [converted] = await convertAll({
          "classes/C.cls": "public class C { @AuraEnabled public System.String name; @AuraEnabled public Schema.Account account; }",
        });
        assert.match(converted?.text ?? "", /name\?: string;/);
        assert.match(converted?.text ?? "", /account\?: Apex\.Account;/);
      });
    });
  });
});
