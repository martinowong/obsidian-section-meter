export interface HeadingDecorationChange {
  from: number;
  to: number;
  removedText: string;
  insertedText: string;
}

export function documentChangesMayAffectHeadings(
  changes: Iterable<HeadingDecorationChange>
): boolean {
  for (const change of changes) {
    if (change.removedText.includes("\n")
      || change.insertedText.includes("\n")
      || change.removedText.includes("#")
      || change.insertedText.includes("#")) {
      return true;
    }
  }

  return false;
}

export interface HeadingDecorationRange {
  from: number;
  headingEnd: number;
}

export function selectionIntersectsHeading(
  selectionFrom: number,
  selectionTo: number,
  headings: Iterable<HeadingDecorationRange>
): boolean {
  return [...headings].some((heading) => (
    selectionFrom <= heading.headingEnd && selectionTo >= heading.from
 ));
}
