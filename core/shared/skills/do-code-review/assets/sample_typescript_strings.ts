// Regression asset for string-literal handling in cyclomatic complexity.
//
// Before strip_string_literals, every "or"/"and"/"if"/"for" inside these strings counted as a
// branch. This function has exactly two real branches; the prose in its messages has many more
// words that the keyword scan used to charge it for.

export function describeOutcome(state: string, retries: number): string {
  const messages = {
    blocked: "evidence disagrees and a human must reconcile it, or the gate stays shut",
    ready: "every prerequisite is verified and no claim is conflicted",
    waiting: "waiting for a build or a test or a review, and then for approval",
    failed: "the run failed and the cause was not classified for a retry",
    unknown: "no outcome was recorded, if indeed the task ever started",
  };

  if (state in messages) {
    return messages[state as keyof typeof messages];
  }
  return retries > 0 ? "retrying after a transient error" : "no state and no retries";
}

export const BANNER = `report generated for review — pass or fail, and every skipped file named`;

// Multi-line template literal. Before the spanning pass, every keyword in this prose counted as a
// branch on whichever function the slice attributed it to.
export const REPORT_TEMPLATE = `
  Coverage was partial and the verdict describes the analysed files only.
  If a file could not be read it is named here, and if a check could not run
  it is reported as not run — for every file in the set, or the report is
  incomplete and the score means less than it appears to.
`;

export function pick(kind: string): number {
  if (kind === "wide") { return 2; }
  return 1;
}
