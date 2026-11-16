/**
 * Typed errors shared by every package. Stubs MUST throw NotImplementedError (never return zeros)
 * so that unfinished features fail loudly and are traceable to their owning workstream.
 */

/** Identifies an unimplemented feature, e.g. 'engine.rmd', 'tax.us-federal', 'stochastic.monteCarlo'. */
export type FeatureId = string;

export class GlideworthError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "GlideworthError";
    this.code = code;
    this.details = details;
  }
}

export class NotImplementedError extends GlideworthError {
  readonly feature: FeatureId;
  /** Workstream letter (area of the code base) that owns the feature. */
  readonly workstream: string;
  constructor(feature: FeatureId, workstream: string, hint?: string) {
    super(
      "NOT_IMPLEMENTED",
      `Not implemented: ${feature} (workstream ${workstream})${hint ? `: ${hint}` : ""}`,
      {
        feature,
        workstream,
      },
    );
    this.name = "NotImplementedError";
    this.feature = feature;
    this.workstream = workstream;
  }
}

export class ValidationError extends GlideworthError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("VALIDATION", message, details);
    this.name = "ValidationError";
  }
}

/** Input is structurally valid but semantically inconsistent (dangling id, circular milestone...). */
export class ScenarioError extends GlideworthError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("SCENARIO", message, details);
    this.name = "ScenarioError";
  }
}

export function isNotImplemented(e: unknown): e is NotImplementedError {
  return (
    e instanceof NotImplementedError || (e instanceof Error && e.name === "NotImplementedError")
  );
}
