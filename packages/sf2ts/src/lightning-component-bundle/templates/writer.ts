import { TextBuilder } from "../../text-builder.ts";

/** Writes virtual text, recording which parts map to which template text, in indented lines and blocks. */
export class Writer extends TextBuilder {
  indent = "";

  /** Writes text mapped to `length` characters at `position`, or unmapped text without somewhere to map it to. */
  writeAt(text: string, position: number | undefined, length: number, features?: number): void {
    if (position === undefined || length === 0) {
      this.write(text);
    } else {
      this.write(text, position, position + length, features);
    }
  }

  line(build: () => void): void {
    this.write(this.indent);
    build();
    this.write("\n");
  }

  block(open: () => void, body: () => void): void {
    this.line(() => {
      const start = this.text.length;
      open();
      // a block that only scopes variables has nothing before its brace
      this.write(this.text.length === start ? "{" : " {");
    });
    const outer = this.indent;
    this.indent += "  ";
    body();
    this.indent = outer;
    this.line(() => this.write("}"));
  }
}
