import { describe, expect, it } from "vitest";
import { ChangeSet } from "@codemirror/state";
import { TargetCompletionTracker } from "./targetCompletion";
import { summarizeReadingTimes, type SectionMeterSettings } from "./readingTime";

// Completion depends on counts/targets, not the display flags used by badges.
const settings = { wordsPerMinute: 200, countCharactersWithSpaces: true,
  targetProgressLabelStyle: "count", targetOverageWarningPercent: 125,
  compactWordsLabel: "w", compactCharactersLabel: "c", compactMinutesLabel: "m"
} as SectionMeterSettings;

describe("target completion transitions", () => {
  it("reports the first edit that crosses a target, including an insertion above the heading", () => {
    const before = "# Section\nTarget: 3 words\none two";
    const changes = ChangeSet.of([
      { from: 0, insert: "preamble\n" },
      { from: before.length, insert: " three" }
    ], before.length);
    const tracker = new TargetCompletionTracker(summarizeReadingTimes(before, settings));
    tracker.mapPositions((position) => changes.mapPos(position, 1));
    const after = "preamble\n# Section\nTarget: 3 words\none two three";
    const reached = tracker.update(summarizeReadingTimes(after, settings));
    expect(reached.map((entry) => entry.label)).toEqual(["Section"]);
    expect(tracker.update(summarizeReadingTimes(after, settings))).toEqual([]);
  });
});
