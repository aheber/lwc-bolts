// @ts-check
import { LightningElement, wire } from "lwc";
// cacheable auraenabled apex method
import getFile1Data from "@salesforce/apex/File1.getFile1Data";
// auraenabled apex method
import getFile2Data from "@salesforce/apex/File2.getFile2Data";
// apex continuation
import startRequest from "@salesforce/apexContinuation/File3.startRequest";
// custom permission
import hasTestPerm from "@salesforce/customPermission/TestPerm";
// static resource
import pkg from "@salesforce/resourceUrl/pkg";
import bolt from "@salesforce/resourceUrl/bolt";

// custom label
import lblAustralia from "@salesforce/label/c.Australia";
import lblAccount from "@salesforce/label/c.Account";
// custom object
import Test_Object__c from "@salesforce/schema/Test_Object__c";
// custom field
import Test_Text__c from "@salesforce/schema/Test_Object__c.Test_Text__c";
// content asset
import test1 from "@salesforce/contentAssetUrl/test1";
// message channel
import RecordSelected__c from "@salesforce/messageChannel/RecordSelected__c";

// component path resolution
import { data } from "c/comp2";

export default class Comp1 extends LightningElement {

  /** @type {{ data?: Apex.File2; error?: unknown }} */
  @wire(getFile1Data, { prop1: "hello", prop2: 123 })
  data2 = {};

  constructor() {
    super();
    getFile1Data({ prop1: "stringsarecool", prop2: 123 }).then((output) => {
      output.values?.length;
    });
    if (data.key1 == "val2") {
    }
    // a continuation resolves to what its callback (processResponse) returns
    startRequest().then((body) => body.toUpperCase());
  }
}
