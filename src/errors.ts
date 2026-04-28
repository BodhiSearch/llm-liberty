export class LibertyError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "LibertyError";
    if (cause !== undefined) this.cause = cause;
  }
}
