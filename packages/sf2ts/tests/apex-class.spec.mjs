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
      // else
      throw error;
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
    assert.deepEqual(convertedComp[0].mapData, [
      { sourcePos: 62, destPos: 15 },
      { sourcePos: 69, destPos: 52 },
      { sourcePos: 62, destPos: 63 },
      { sourcePos: 69, destPos: 70 },
    ]);
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
    assert.deepEqual(convertedComp[0].mapData, [
      { sourcePos: 78, destPos: 15 },
      { sourcePos: 85, destPos: 52 },
      { sourcePos: 78, destPos: 63 },
      { sourcePos: 85, destPos: 70 },
    ]);
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
    assert.deepEqual(convertedComp[0].mapData, [
      { sourcePos: 74, destPos: 15 },
      { sourcePos: 81, destPos: 52 },
      { sourcePos: 74, destPos: 63 },
      { sourcePos: 81, destPos: 70 },
    ]);
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
    assert.deepEqual(convertedComp[0].mapData, [
      { sourcePos: 78, destPos: 15 },
      { sourcePos: 85, destPos: 52 },
      { sourcePos: 78, destPos: 63 },
      { sourcePos: 85, destPos: 70 },
    ]);
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
    assert.deepEqual(convertedComp[0].mapData, [
      { sourcePos: 13, destPos: 18 },
      { sourcePos: 23, destPos: 28 },
      { sourcePos: 57, destPos: 33 },
      { sourcePos: 62, destPos: 38 },
      { sourcePos: 50, destPos: 41 },
      { sourcePos: 56, destPos: 47 },
      { sourcePos: 97, destPos: 51 },
      { sourcePos: 102, destPos: 56 },
      { sourcePos: 89, destPos: 59 },
      { sourcePos: 96, destPos: 65 },
      { sourcePos: 123, destPos: 151 },
      { sourcePos: 128, destPos: 156 },
      { sourcePos: 115, destPos: 159 },
      { sourcePos: 122, destPos: 165 },
      { sourcePos: 142, destPos: 237 },
      { sourcePos: 147, destPos: 242 },
      { sourcePos: 133, destPos: 245 },
      { sourcePos: 141, destPos: 249 },
      { sourcePos: 188, destPos: 315 },
      { sourcePos: 193, destPos: 320 },
      { sourcePos: 181, destPos: 323 },
      { sourcePos: 187, destPos: 329 },
      { sourcePos: 208, destPos: 397 },
      { sourcePos: 213, destPos: 402 },
      { sourcePos: 205, destPos: 405 },
      { sourcePos: 207, destPos: 411 },
      { sourcePos: 253, destPos: 430 },
      { sourcePos: 260, destPos: 467 },
      { sourcePos: 253, destPos: 478 },
      { sourcePos: 260, destPos: 485 },
      { sourcePos: 347, destPos: 601 },
      { sourcePos: 354, destPos: 638 },
      { sourcePos: 347, destPos: 649 },
      { sourcePos: 354, destPos: 656 },
    ]);
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
    assert.deepEqual(convertedComp[0].mapData, [
      { sourcePos: 13, destPos: 18 },
      { sourcePos: 23, destPos: 28 },
      { sourcePos: 57, destPos: 33 },
      { sourcePos: 62, destPos: 38 },
      { sourcePos: 50, destPos: 41 },
      { sourcePos: 56, destPos: 47 },
      { sourcePos: 210, destPos: 113 },
      { sourcePos: 215, destPos: 118 },
      { sourcePos: 203, destPos: 121 },
      { sourcePos: 209, destPos: 127 },
      { sourcePos: 13, destPos: 149 },
      { sourcePos: 23, destPos: 159 },
      { sourcePos: 80, destPos: 180 },
      { sourcePos: 90, destPos: 190 },
      { sourcePos: 130, destPos: 195 },
      { sourcePos: 135, destPos: 200 },
      { sourcePos: 122, destPos: 203 },
      { sourcePos: 129, destPos: 209 },
      { sourcePos: 158, destPos: 295 },
      { sourcePos: 163, destPos: 300 },
      { sourcePos: 150, destPos: 303 },
      { sourcePos: 157, destPos: 309 },
      { sourcePos: 286, destPos: 330 },
      { sourcePos: 293, destPos: 367 },
      { sourcePos: 286, destPos: 378 },
      { sourcePos: 293, destPos: 385 },
    ]);
  });

  it("Inner Class", async () => {
    /** @type { Component } */
    let component = {
      path: "file1/TestClass1.cls",
      type: MetadataType.ApexClass,
      content: `public with sharing class SampleContinuationClass {
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
}`,
    };
    const convertedComp = await convert([component]);
    assert.equal(
      convertedComp[0].declarationContent,
      `declare interface SampleContinuationClass {
  /** @deprecated not exposed; property must be @AuraEnabled, non-static, public or global */
  LONG_RUNNING_SERVICE_URL?: string;
}
declare module "@salesforce/apexContinuation/SampleContinuationClass.startRequest" {
  const startRequest: {
    (): Promise<Object>;
    adapter: import("lwc").WireAdapterConstructor<
      never,
      { error?: any; data?: Object; }
    >;
  };
  export default startRequest;
}
declare module "@salesforce/apex/SampleContinuationClass.processResponse" {
  const processResponse: {
    (param: { labels: string[]; state: Object }): Promise<Object>;
    adapter: import("lwc").WireAdapterConstructor<
      { labels: string[]; state: Object },
      { error?: any; data?: Object; }
    >;
  };
  export default processResponse;
}
`
    );
    assert.deepEqual(convertedComp[0].mapData, [
      { sourcePos: 26, destPos: 18 },
      { sourcePos: 49, destPos: 41 },
      { sourcePos: 192, destPos: 140 },
      { sourcePos: 216, destPos: 164 },
      { sourcePos: 185, destPos: 167 },
      { sourcePos: 191, destPos: 173 },
      { sourcePos: 359, destPos: 192 },
      { sourcePos: 371, destPos: 259 },
      { sourcePos: 359, destPos: 270 },
      { sourcePos: 371, destPos: 282 },
      { sourcePos: 981, destPos: 473 },
      { sourcePos: 996, destPos: 531 },
      { sourcePos: 981, destPos: 542 },
      { sourcePos: 996, destPos: 557 },
    ]);
  });
});
