// @ts-check

import { LightningElement } from "lwc";
import Comp1 from "c/comp1";
import getFile1Data from "@salesforce/apex/File1.getFile1Data";

import comp3Template from "./comp3.html";
import TestTemplate1 from "./templates/testTemplate1.html";
import TestTemplate2 from "./templates/testTemplate2.html";

export default class Comp3 extends LightningElement {

  prop1 = "hello";
  prop2 = 1234;

  constructor(){
    super();
    const cmp1 = new Comp1();
    cmp1.data2;
  }

  render() {
    return this.prop2 > 1000 ? TestTemplate1 : TestTemplate2;
  }
}
