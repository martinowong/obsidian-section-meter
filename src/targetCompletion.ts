import type { ReadingTimeSummaries, WritingTargetProgress } from "./readingTime";

export interface TargetCompletion {
  label: string;
  target: WritingTargetProgress;
  // null identifies the whole-note target; section offsets follow document edits.
  from: number | null;
}

export class TargetCompletionTracker {
  private previous: TargetCompletion[];

  constructor(summaries: ReadingTimeSummaries) {
    this.previous = getTargets(summaries);
  }

  reset(summaries: ReadingTimeSummaries): void {
    this.previous = getTargets(summaries);
  }

  mapPositions(mapPosition: (position: number) => number | null): void {
    this.previous = this.previous.flatMap((entry) => {
      if (entry.from === null) return [entry];
      const from = mapPosition(entry.from);
      return from === null ? [] : [{ ...entry, from }];
    });
  }

  update(summaries: ReadingTimeSummaries): TargetCompletion[] {
    const next = getTargets(summaries);
    const previous = new Map(this.previous.map((entry) => [entry.from, entry.target]));
    const reached = next.filter(({ from, target }) => {
      const before = previous.get(from);
      return before?.metric === target.metric && before.targetValue === target.targetValue
        && !before.isComplete && target.isComplete;
    });
    this.previous = next;
    return reached;
  }
}

function getTargets(summaries: ReadingTimeSummaries): TargetCompletion[] {
  const targets: TargetCompletion[] = summaries.note.target
    ? [{ from: null, label: "Whole-note", target: summaries.note.target }]
    : [];
  for (const section of summaries.sections) {
    if (section.target) targets.push({ from: section.from, label: section.title, target: section.target });
  }
  return targets;
}
