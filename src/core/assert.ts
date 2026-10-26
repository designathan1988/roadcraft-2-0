/** RUNTIME CHECKS (Unreal's ensure): a condition the game survives but must hear of, reported once per message a session (the console,
 *  and the crash log `problems.setReporter` hands it to), the game going on. Kept in the product. */

/** THE SESSION'S PROBLEMS: each failed `ensure` told once, to the console and to the reporter set at start-up (the crash log, a reporter). */
export class ProblemLog {
  private readonly told = new Set<string>();
  private report: (message: string) => void = () => {};

  /** Where a failed `ensure` is told besides the console. */
  setReporter(report: (message: string) => void): void {
    this.report = report;
  }

  /** True when `condition` holds; otherwise reported once per message in the session and false, the caller carrying on. */
  ensure(condition: unknown, message: string): boolean {
    if (condition) return true;
    if (this.told.has(message)) return false;
    this.told.add(message);
    console.error(`[ensure] ${message}`);
    try {
      this.report(message);
    } catch (error) {
      // A reporter that fails must not take the game with it: said, and the game goes on.
      console.error('[ensure] the problem reporter failed', error);
    }
    return false;
  }
}

/** The game's one log of problems. */
export const problems = new ProblemLog();
