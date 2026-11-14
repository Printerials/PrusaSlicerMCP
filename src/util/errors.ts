/**
 * A refusal is an expected, explainable failure: wrong input, a missing preset, a file the
 * process may not read. Its message goes to the model verbatim, so it says what to do next.
 * Anything else is a bug or an environment problem and is reported as such.
 */
export class Refusal extends Error {
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "Refusal";
    this.details = details;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
