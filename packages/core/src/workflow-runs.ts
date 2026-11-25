/**
 * The statuses of a workflow run that has ended. The engine never moves a run on from one of them: `WorkflowEngine.tick`
 * returns at once, and a cancel leaves the run as it is. This is the one list, for the engine (packages/workflows) and
 * for everything that asks whether a run is still going. It lives here because core cannot import the engine.
 */
export const ENDED_RUN: readonly string[] = ["completed", "failed", "cancelled"];
