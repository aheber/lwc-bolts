import { LightningElement, api, wire } from "lwc";
import { getRecord } from "lightning/uiRecordApi";
import ERROR_MESSAGE from "@salesforce/schema/dlrs__LookupRollupSummaryLog__c.dlrs__ErrorMessage__c";
import NOTES from "@salesforce/schema/dlrs__LookupRollupSummaryLog__c.Notes__c";
import NOT_INSERTABLE from "@salesforce/label/dlrs.fflib_security_error_field_not_insertable";
import DLRS_LOGO from "@salesforce/resourceUrl/dlrs__DLRS_Logo";
import calculate from "@salesforce/apex/dlrs.RollupController.calculate";

/** Shows a rollup log of the installed dlrs package, through its cached metadata in managed/dlrs. */
export default class RollupLog extends LightningElement {
  @api recordId;
  logo = DLRS_LOGO;
  notInsertable = NOT_INSERTABLE;

  @wire(getRecord, { recordId: "$recordId", fields: [ERROR_MESSAGE, NOTES] })
  log;

  async recalculate() {
    const result = await calculate({ recordId: this.recordId });
    return result.message;
  }
}
