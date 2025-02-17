// @ts-check

import { LightningElement } from "lwc";
import Comp1 from "c/comp1";
import getFile1Data from "@salesforce/apex/File1.getFile1Data";

export default class Comp3 extends LightningElement {
  constructor(){
    super();
    const cmp1 = new Comp1();
    cmp1.data2;
  }
}
