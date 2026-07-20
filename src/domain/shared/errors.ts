export type ErrorCode =
  | "CONFIG_INVALID"
  | "VALIDATION_FAILED"
  | "INVARIANT_VIOLATION"
  | "STATE_TRANSITION_INVALID"
  | "EXTERNAL_TIMEOUT"
  | "EXTERNAL_RETRYABLE"
  | "EXTERNAL_FATAL"
  | "CONFLICT"
  | "NOT_FOUND"
  | "UNAUTHORIZED";

export type AppErrorOptions = {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable?: boolean;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(options: AppErrorOptions) {
    super(
      options.message,
      options.cause === undefined ? undefined : { cause: options.cause }
    );
    this.name = new.target.name;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details
    };
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({
      code: "VALIDATION_FAILED",
      message,
      ...(details === undefined ? {} : { details })
    });
  }
}

export class InvariantViolationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({
      code: "INVARIANT_VIOLATION",
      message,
      ...(details === undefined ? {} : { details })
    });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({
      code: "CONFLICT",
      message,
      ...(details === undefined ? {} : { details }),
      retryable: true
    });
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({
      code: "NOT_FOUND",
      message,
      ...(details === undefined ? {} : { details })
    });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication is required") {
    super({ code: "UNAUTHORIZED", message });
  }
}

export class ExternalTimeoutError extends AppError {
  constructor(message: string, details?: Record<string, unknown>, cause?: unknown) {
    super({
      code: "EXTERNAL_TIMEOUT",
      message,
      retryable: true,
      ...(details === undefined ? {} : { details }),
      ...(cause === undefined ? {} : { cause })
    });
  }
}

export class ExternalRetryableError extends AppError {
  constructor(message: string, details?: Record<string, unknown>, cause?: unknown) {
    super({
      code: "EXTERNAL_RETRYABLE",
      message,
      retryable: true,
      ...(details === undefined ? {} : { details }),
      ...(cause === undefined ? {} : { cause })
    });
  }
}

export class ExternalFatalError extends AppError {
  constructor(message: string, details?: Record<string, unknown>, cause?: unknown) {
    super({
      code: "EXTERNAL_FATAL",
      message,
      ...(details === undefined ? {} : { details }),
      ...(cause === undefined ? {} : { cause })
    });
  }
}
