export type JpydfSdkErrorCode =
  | "ACTION_EXPIRED"
  | "INVALID_INPUT"
  | "MANIFEST_MISMATCH"
  | "NEXT_BLOCK_REQUIRED"
  | "ORACLE_UNAVAILABLE"
  | "POLICY_VIOLATION"
  | "RATE_LIMITED"
  | "STALE_BLOCK"
  | "WRONG_CHAIN"
  | "TEST_ONLY_SCOPE_REQUIRED"
  | "UNSUPPORTED_DEPLOYMENT"
  | "UNKNOWN_BRANCH"
  | "SIMULATION_REVERTED";

export class JpydfSdkError extends Error {
  readonly code: JpydfSdkErrorCode;
  readonly retryAfterMs?: number;

  constructor(
    code: JpydfSdkErrorCode,
    message: string,
    options?: ErrorOptions & { retryAfterMs?: number },
  ) {
    const { retryAfterMs, ...errorOptions } = options ?? {};
    super(message, errorOptions);
    this.name = "JpydfSdkError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}
