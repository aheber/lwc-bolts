/** @import { Component } from "../lib/index.mjs" */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { convert, MetadataType } from "../lib/index.mjs";

describe("Convert:ApexClass", async () => {
  beforeEach(async () => {
    // hopefully this returns after the Apex Parser is ready
    try {
      /** @type { Component } */
      let component = {
        path: "file1/TestClass1.cls",
        type: MetadataType.ApexClass,
        content: `public class TestClass1 {
  @AuraEnabled
  public static void method1(){}
}`,
      };
      // if this throws it also includes a promise that we can track for when it will be ready
      convert([component]);
    } catch (/** @type {any}*/ error) {
      if (error?.waitFor) {
        return error.waitFor;
      }
    }
  });

  it("Parse AuraEnabled Method", async () => {
    /** @type { Component } */
    let component = {
      path: "file1/TestClass1.cls",
      type: MetadataType.ApexClass,
      content: `public class TestClass1 {
  @AuraEnabled
  public static void method1(){}
}`,
    };
    let convertedComp = convert([component]);
    assert.equal(
      convertedComp[0].declarationContent,
      `declare module "@salesforce/apex/TestClass1.method1" {
  const method1: {
    (): Promise<void>;
  };
  export default method1;
}
`
    );
    // assert.equal(
    //   mapFileContents,
    //   `{"version":3,"file":"TestClass1.d.ts","sourceRoot":"","sources":["../../../../../file1/TestClass1.cls"],"names":[],"mappings":";;;;;;;;uBAEuB;;;"}`
    // );
  });

  it("Parse Cacheable AuraEnabled Method", async () => {
    /** @type { Component } */
    let component = {
      path: "file1/TestClass1.cls",
      type: MetadataType.ApexClass,
      content: `public class TestClass1 {
  @AuraEnabled(Cacheable=true)
  public static void method1(){}
}`,
    };
    const convertedComp = await convert([component]);
    assert.equal(
      convertedComp[0].declarationContent,
      `declare module "@salesforce/apex/TestClass1.method1" {
  const method1: {
    (): Promise<void>;
    adapter: import("lwc").WireAdapterConstructor<
      never,
      { error?: any; data?: void; }
    >;
  };
  export default method1;
}
`
    );
    // assert.equal(
    //   mapFileContents,
    //   `{"version":3,"file":"TestClass1.d.ts","sourceRoot":"","sources":["../../../../../file1/TestClass1.cls"],"names":[],"mappings":";;;;;;;;;;;uBAEuB;;;"}`
    // );
  });

  it("List to array type", async () => {
    /** @type { Component } */
    let component = {
      path: "file1/TestClass1.cls",
      type: MetadataType.ApexClass,
      content: `public class TestClass1 {
    @AuraEnabled
    public static List<String> method1(){}
}`,
    };
    const convertedComp = await convert([component]);
    assert.equal(
      convertedComp[0].declarationContent,
      `declare module "@salesforce/apex/TestClass1.method1" {
  const method1: {
    (): Promise<string[]>;
  };
  export default method1;
}
`
    );
    // assert.equal(
    //   mapFileContents,
    //   `{"version":3,"file":"TestClass1.d.ts","sourceRoot":"","sources":["../../../../../file1/TestClass1.cls"],"names":[],"mappings":";;;;;;;;uBAE+B;;;"}`
    // );
  });

  it("Map to object", async () => {
    /** @type { Component } */
    let component = {
      path: "file1/TestClass1.cls",
      type: MetadataType.ApexClass,
      content: `public class TestClass1 {
  @AuraEnabled
  public static Map<String, Integer> method1(){}
}`,
    };
    const convertedComp = await convert([component]);
    assert.equal(
      convertedComp[0].declarationContent,
      `declare module "@salesforce/apex/TestClass1.method1" {
  const method1: {
    (): Promise<Record<string, number>>;
  };
  export default method1;
}
`
    );
    // assert.equal(
    //   mapFileContents,
    //   `{"version":3,"file":"TestClass1.d.ts","sourceRoot":"","sources":["../../../../../file1/TestClass1.cls"],"names":[],"mappings":";;;;;;;;uBAEuC;;;"}`
    // );
  });

  it("Class Properties", async () => {
    /** @type { Component } */
    let component = {
      path: "file1/TestClass1.cls",
      type: MetadataType.ApexClass,
      content: `public class TestClass1 {
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
  public List<String> method1(String blarg, String yip){

  }

  @AuraEnabled(Cacheable=true)
  public List<String> method2(String blarg, String yip){

  }

  public List<String> method3(){

  }

}`,
    };
    const convertedComp = await convert([component]);
    assert.equal(
      convertedComp[0].declarationContent,
      `declare interface TestClass1 {
  prop1?: string;
  prop2?: number;
  /** @deprecated not exposed; property must be @AuraEnabled, public or global */
  prop3?: number;
  /** @deprecated not exposed; property must be public or global */
  prop4?: Date;
  /** @deprecated not exposed; property must be non-static */
  prop5?: string;
  /** @deprecated not exposed; property must be @AuraEnabled */
  prop6?: string;
}
declare module "@salesforce/apex/TestClass1.method1" {
  const method1: {
    (param: { blarg: string; yip: string }): Promise<string[]>;
  };
  export default method1;
}
declare module "@salesforce/apex/TestClass1.method2" {
  const method2: {
    (param: { blarg: string; yip: string }): Promise<string[]>;
    adapter: import("lwc").WireAdapterConstructor<
      { blarg: string; yip: string },
      { error?: any; data?: string[]; }
    >;
  };
  export default method2;
}
`
    );
    // assert.equal(
    //   mapFileContents,
    //   `{"version":3,"file":"TestClass1.d.ts","sourceRoot":"","sources":["../../../../../file1/TestClass1.cls"],"names":[],"mappings":";EACY;EAGA;;EAGA;;EAEA;;EAEA;;EAGA;;;;;;;;;uBAGoB;;;;;;;;;;;;;;uBAKA;;;"}`
    // );
  });

  it("Inner Class", async () => {
    /** @type { Component } */
    let component = {
      path: "file1/TestClass1.cls",
      type: MetadataType.ApexClass,
      content: `public class TestClass1 {
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
  public List<TestClass1.TestClass2> method1(TestClass1 blarg, TestClass1.TestClass2 yip){

  }
}`,
    };
    const convertedComp = await convert([component]);
    assert.equal(
      convertedComp[0].declarationContent,
      `declare interface TestClass1 {
  prop1?: string;
  /** @deprecated not exposed; property must be non-static */
  prop4?: string;
}
declare namespace TestClass1 {
  declare interface TestClass2 {
    prop2?: number;
    /** @deprecated not exposed; property must be @AuraEnabled, public or global */
    prop3?: number;
  }
}
declare module "@salesforce/apex/TestClass1.method1" {
  const method1: {
    (param: { blarg: TestClass1; yip: TestClass1.TestClass2 }): Promise<TestClass1.TestClass2[]>;
    adapter: import("lwc").WireAdapterConstructor<
      { blarg: TestClass1; yip: TestClass1.TestClass2 },
      { error?: any; data?: TestClass1.TestClass2[]; }
    >;
  };
  export default method1;
}
`
    );
    // assert.equal(
    //   mapFileContents,
    //   `{"version":3,"file":"TestClass1.d.ts","sourceRoot":"","sources":["../../../../../file1/TestClass1.cls"],"names":[],"mappings":";EACY;;EAaA;;;;EARE;;EAGA;;;;;;;;;;;;;;uBASiC;;;"}`
    // );
  });
});
