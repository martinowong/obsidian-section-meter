import { ChangeSet } from "@codemirror/state";
import { Decoration, WidgetType } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  documentChangesMayAffectHeadings,
  selectionIntersectsHeading
} from "./headingDecorations";

describe("documentChangesMayAffectHeadings", () => {
  it("keeps a heading badge in place while ordinary heading text is typed", () => {
    expect(documentChangesMayAffectHeadings([
      {
        from: 8,
        to: 8,
        removedText: "",
        insertedText: "s"
      }
    ])).toBe(false);
  });

  it("clears badges when Markdown heading structure can change", () => {
    expect(documentChangesMayAffectHeadings([
      { from: 0, to: 0, removedText: "", insertedText: "#" }
    ])).toBe(true);
    expect(documentChangesMayAffectHeadings([
      { from: 4, to: 4, removedText: "", insertedText: "\n" }
    ])).toBe(true);
  });
});

describe("selectionIntersectsHeading", () => {
  const headings = [{ from: 0, headingEnd: 8 }];

  it("recognizes a cursor in the heading line", () => {
    expect(selectionIntersectsHeading(8, 8, headings)).toBe(true);
  });

  it("allows a pending badge refresh once the cursor leaves the heading", () => {
    expect(selectionIntersectsHeading(9, 9, headings)).toBe(false);
  });
});

class TestWidget extends WidgetType {
  toDOM(): HTMLElement {
    return {} as HTMLElement;
  }
}

describe("heading badge mapping", () => {
  it("keeps a badge after text inserted at the end of its heading", () => {
    const decorations = Decoration.set([
      Decoration.widget({ widget: new TestWidget(), side: 1 }).range(10)
    ]);
    const mapped = decorations.map(ChangeSet.of([{ from: 10, insert: "x" }], 10));
    const positions: number[] = [];
    mapped.between(0, 11, (from) => {
      positions.push(from);
    });

    expect(positions).toEqual([11]);
  });
});
