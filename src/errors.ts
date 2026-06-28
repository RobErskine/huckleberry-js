/**
 * Structured, LLM-friendly errors.
 *
 * Every error thrown by the client extends `HuckleberryError`, which carries
 * machine-readable fields (`category`, `retryable`, `recovery`) on top of the
 * normal `Error` message. This makes failures easy to branch on in code and
 * easy for an MCP/LLM client to act on: `toJSON()` produces the exact envelope
 * the MCP server serializes back to the model.
 *
 * Backwards-compatible: `AuthError` and `FirestoreError` still extend this base
 * while keeping their original `name`/`status`/`body` shape, so existing
 * `instanceof` checks and field access keep working.
 */

export type ErrorCategory =
  | "auth"
  | "not_found"
  | "invalid_input"
  | "api"
  | "network";

/** The serialized shape returned to MCP/LLM callers. */
export interface StructuredErrorJSON {
  error: string;
  message: string;
  category: ErrorCategory;
  retryable: boolean;
  recovery: string;
}

export interface HuckleberryErrorOptions {
  /** Overrides `name` (defaults to `"HuckleberryError"`). */
  name?: string;
  category: ErrorCategory;
  /** Whether retrying the same call could succeed. Defaults to `false`. */
  retryable?: boolean;
  /** Human/LLM-actionable hint on how to recover. */
  recovery?: string;
}

/** Base class for every error this library throws. */
export class HuckleberryError extends Error {
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly recovery: string;

  constructor(message: string, opts: HuckleberryErrorOptions) {
    super(message);
    this.name = opts.name ?? "HuckleberryError";
    this.category = opts.category;
    this.retryable = opts.retryable ?? false;
    this.recovery = opts.recovery ?? "";
  }

  /** The structured envelope an MCP/LLM client can branch on. */
  toJSON(): StructuredErrorJSON {
    return {
      error: this.name,
      message: this.message,
      category: this.category,
      retryable: this.retryable,
      recovery: this.recovery,
    };
  }
}

/** Thrown when a child id (`cid`) does not exist for this account. */
export class ChildNotFoundError extends HuckleberryError {
  constructor(readonly cid: string) {
    super(`Child not found: ${cid}`, {
      name: "ChildNotFoundError",
      category: "not_found",
      retryable: false,
      recovery:
        "Call client.user.listChildren() (or list_children) to get valid child IDs (cid).",
    });
  }
}

/** Thrown when a date range is missing, malformed, or empty (start >= end). */
export class InvalidDateRangeError extends HuckleberryError {
  constructor(message: string) {
    super(message, {
      name: "InvalidDateRangeError",
      category: "invalid_input",
      retryable: false,
      recovery:
        "Provide a range { start, end } where both are Date objects or epoch values and start is before end.",
    });
  }
}

/** Thrown when a value passed to a write/encode operation is invalid. */
export class InvalidInputError extends HuckleberryError {
  constructor(
    message: string,
    recovery = "Check the values passed and try again.",
  ) {
    super(message, {
      name: "InvalidInputError",
      category: "invalid_input",
      retryable: false,
      recovery,
    });
  }
}

/** Thrown when a write tool is called but writes are not enabled server-side. */
export class WritesDisabledError extends HuckleberryError {
  constructor() {
    super(
      "Write tools are disabled. Set HUCKLEBERRY_ENABLE_WRITES=1 in the server environment to enable them.",
      {
        name: "WritesDisabledError",
        category: "invalid_input",
        retryable: false,
        recovery:
          "Ask the server operator to set HUCKLEBERRY_ENABLE_WRITES=1 and restart the server.",
      },
    );
  }
}

/** Wraps an upstream Firestore/network failure surfaced to callers. */
export class ApiError extends HuckleberryError {
  constructor(
    message: string,
    readonly code?: string | number,
  ) {
    super(message, {
      name: "ApiError",
      category: "api",
      retryable: true,
      recovery:
        "Retry shortly. If it persists, Huckleberry's backend may have changed — check for a library update.",
    });
  }
}
