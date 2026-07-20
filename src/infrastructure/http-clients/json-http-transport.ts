import { request } from "undici";

import {
  AppError,
  ExternalFatalError,
  ExternalRetryableError,
  ExternalTimeoutError,
  ValidationError
} from "../../domain/shared/errors.js";

export type JsonHttpRequest = {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly correlationId: string;
  readonly body?: Record<string, unknown>;
  readonly signal: AbortSignal | undefined;
};

export type JsonHttpTransport = {
  send(input: JsonHttpRequest): Promise<unknown>;
};

export type UndiciJsonHttpTransportOptions = {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxGetAttempts: number;
};

export type RawHttpRequestOptions = {
  readonly method: "GET" | "POST";
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly signal: AbortSignal;
};

export type RawHttpResponse = {
  readonly statusCode: number;
  readonly body: {
    text(): Promise<string>;
  };
};

export type HttpRequestFunction = (
  url: URL,
  options: RawHttpRequestOptions
) => Promise<RawHttpResponse>;

const sendUndiciRequest: HttpRequestFunction = async (url, options) =>
  request(url, options);

export class UndiciJsonHttpTransport implements JsonHttpTransport {
  private readonly baseUrl: URL;

  constructor(
    private readonly options: UndiciJsonHttpTransportOptions,
    private readonly requestFunction: HttpRequestFunction = sendUndiciRequest
  ) {
    this.baseUrl = new URL(options.baseUrl);
    if (this.baseUrl.protocol !== "http:" && this.baseUrl.protocol !== "https:") {
      throw new ValidationError("HTTP client baseUrl must use http or https");
    }
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 30_000) {
      throw new ValidationError("HTTP timeoutMs must be between 100 and 30000");
    }
    if (
      !Number.isInteger(options.maxGetAttempts) ||
      options.maxGetAttempts < 1 ||
      options.maxGetAttempts > 3
    ) {
      throw new ValidationError("maxGetAttempts must be between 1 and 3");
    }
  }

  async send(input: JsonHttpRequest): Promise<unknown> {
    const attempts = input.method === "GET" ? this.options.maxGetAttempts : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.sendOnce(input);
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === attempts) {
          throw error;
        }
      }
    }

    throw new ExternalRetryableError("HTTP request exhausted all attempts", undefined, lastError);
  }

  private async sendOnce(input: JsonHttpRequest): Promise<unknown> {
    const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs);
    const signal =
      input.signal === undefined
        ? timeoutSignal
        : AbortSignal.any([input.signal, timeoutSignal]);
    const url = new URL(input.path, this.baseUrl);

    try {
      const response = await this.requestFunction(url, {
        method: input.method,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-correlation-id": input.correlationId
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        signal
      });
      const text = await response.body.text();
      const responseBody = parseResponseBody(text, response.statusCode, input.path);

      if (response.statusCode >= 200 && response.statusCode < 300) {
        return responseBody;
      }
      if (isRetryableStatus(response.statusCode)) {
        throw new ExternalRetryableError("Upstream returned a retryable HTTP status", {
          path: input.path,
          statusCode: response.statusCode,
          response: responseBody
        });
      }
      throw new ExternalFatalError("Upstream returned a fatal HTTP status", {
        path: input.path,
        statusCode: response.statusCode,
        response: responseBody
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      if (signal.aborted) {
        throw new ExternalTimeoutError(
          "Upstream HTTP request timed out",
          { path: input.path },
          error
        );
      }
      throw new ExternalRetryableError(
        "Upstream HTTP request failed before a valid response",
        { path: input.path },
        error
      );
    }
  }
}

function parseResponseBody(text: string, statusCode: number, path: string): unknown {
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ExternalFatalError(
      "Upstream returned invalid JSON",
      { path, statusCode },
      error
    );
  }
}

function isRetryable(error: unknown): boolean {
  return error instanceof AppError && error.retryable;
}

function isRetryableStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 429 || statusCode >= 500;
}
