// @ts-check
import { LightningElement, api } from "lwc";
import commonStyles from "@salesforce/resourceUrl/commonStyles";
import hasAdvancedSettings from "@salesforce/customPermission/ViewAdvancedSettings";

export default class BaseCard extends LightningElement {
  /** @type {string} */
  @api title = "";

  /** @type {number} */
  @api count = 0;

  stylesheetUrl = commonStyles;
  showAdvanced = hasAdvancedSettings;
  expanded = true;

  handleToggle() {
    this.expanded = !this.expanded;
    // parents' ontoggle handlers receive CustomEvent<{ expanded: boolean, title: string }>
    this.dispatchEvent(new CustomEvent("toggle", { detail: { expanded: this.expanded, title: this.title } }));
  }
}
