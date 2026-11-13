import type { SdkError } from "@hussmartinez/sdk-core";
import { AiError, abortError } from "../errors/ai-error.js";
import type { AiLimitName, ResponsePolicy } from "../limits/ai-limits.js";

/**
 * A limit that a call, or a request to the handler, has reached its warning
 * threshold for (ADR 0005).
 *
 * @public
 */
export interface AiLimitWarning {
  /** The limit: a response limit from an adapter or the transport, or `requestBytes` from the handler. */
  readonly limit: AiLimitName;
  /** The measured value, in the limit's unit. */
  readonly actual: number;
  /** The limit's maximum. */
  readonly maximum: number;
}

/**
 * Options for {@link CallGuard}.
 *
 * @internal
 */
export interface CallGuardOptions {
  /** The resolved response limits. */
  readonly policy: ResponsePolicy;
  /** The host's signal. Aborting it fails the call with `ABORTED`. */
  readonly signal?: AbortSignal | undefined;
  /** Called at most once per limit per call, never with content. */
  readonly onWarning?: ((warning: AiLimitWarning) => void) | undefined;
}

/** The reason for a quiet cancellation, such as leaving a stream early. */
const QUIET = Symbol("quiet cancellation");

/**
 * Guards one call (ADR 0005): one signal that aborts when the host's does or
 * when a limit is exceeded, with timers for `streamDuration` and `idleTime`,
 * the running count for `responseBytes`, and warnings at most once per
 * limit.
 *
 * Create it before sending the request, so `idleTime` covers the wait for
 * the first byte, pass {@link CallGuard.signal} to `fetch`, report every
 * chunk with {@link CallGuard.received}, and call {@link CallGuard.dispose}
 * when the call ends.
 *
 * @internal
 */
export class CallGuard {
  /** Aborts on the host's abort, on any limit, and on {@link CallGuard.cancel}. */
  readonly signal: AbortSignal;

  readonly #controller = new AbortController();
  readonly #policy: ResponsePolicy;
  readonly #onWarning: ((warning: AiLimitWarning) => void) | undefined;
  readonly #warned = new Set<AiLimitWarning["limit"]>();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  readonly #startedAt = Date.now();
  #lastActivity = this.#startedAt;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #idleWarningTimer: ReturnType<typeof setTimeout> | undefined;
  #bytes = 0;

  /**
   * @throws {@link AiError} `UNSUPPORTED_ENVIRONMENT` when the runtime has
   *   no `AbortSignal.any`.
   */
  constructor(options: CallGuardOptions) {
    if (typeof AbortSignal.any !== "function") {
      throw new AiError(
        "UNSUPPORTED_ENVIRONMENT",
        "This runtime has no AbortSignal.any, which ai-core needs to cancel calls.",
        { details: { feature: "AbortSignal.any" } },
      );
    }
    this.#policy = options.policy;
    this.#onWarning = options.onWarning;
    this.signal = options.signal
      ? AbortSignal.any([options.signal, this.#controller.signal])
      : this.#controller.signal;

    const duration = this.#policy.limits.streamDuration;
    this.#after(duration.maximum, () =>
      this.fail(this.#policy.error("streamDuration", Date.now() - this.#startedAt)),
    );
    if (duration.warning < duration.maximum) {
      this.#after(duration.warning, () =>
        this.#warn("streamDuration", Date.now() - this.#startedAt, duration.maximum),
      );
    }
    this.#restartIdle();
  }

  /**
   * Counts a chunk of the response body, before it's decoded, and resets the
   * idle timer.
   *
   * @param byteLength - The chunk's size in bytes.
   * @throws {@link AiError} `RESPONSE_TOO_LARGE`, after failing the call,
   *   when the body grows past `responseBytes`.
   */
  received(byteLength: number): void {
    this.#bytes += byteLength;
    try {
      if (this.#policy.check("responseBytes", this.#bytes) === "warning") {
        this.#warn("responseBytes", this.#bytes, this.#policy.limits.responseBytes.maximum);
      }
    } catch (error) {
      this.fail(error as SdkError);
      throw error;
    }
    this.#lastActivity = Date.now();
    this.#restartIdle();
  }

  /**
   * Fails the call with an error, unless it has already ended. Limit errors
   * are typed as `SdkError` by sdk-core, and are `AiError`s at runtime.
   */
  fail(error: SdkError): void {
    if (!this.#controller.signal.aborted) {
      this.#controller.abort(error);
    }
  }

  /** Cancels the call without an error, such as when a stream is left early. */
  cancel(): void {
    if (!this.#controller.signal.aborted) {
      this.#controller.abort(QUIET);
    }
  }

  /**
   * The error the call failed with: a limit's error, `ABORTED` or `TIMEOUT`
   * for the host's signal, as sdk-core's error helpers decide.
   */
  error(): AiError {
    return abortError(this.signal);
  }

  /** Stops the timers. Call it when the call ends, however it ends. */
  dispose(): void {
    for (const timer of this.#timers) {
      clearTimeout(timer);
    }
    this.#timers.clear();
    this.#idleTimer = undefined;
    this.#idleWarningTimer = undefined;
  }

  #after(milliseconds: number, run: () => void): ReturnType<typeof setTimeout> | undefined {
    // Infinity disables a limit; setTimeout would treat it as zero.
    if (!Number.isFinite(milliseconds)) {
      return undefined;
    }
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      run();
    }, milliseconds);
    this.#timers.add(timer);
    return timer;
  }

  #restartIdle(): void {
    for (const timer of [this.#idleTimer, this.#idleWarningTimer]) {
      if (timer !== undefined) {
        clearTimeout(timer);
        this.#timers.delete(timer);
      }
    }
    const idle = this.#policy.limits.idleTime;
    this.#idleTimer = this.#after(idle.maximum, () =>
      this.fail(this.#policy.error("idleTime", Date.now() - this.#lastActivity)),
    );
    // idleTime has no default warning; a host may set one.
    this.#idleWarningTimer =
      idle.warning < idle.maximum
        ? this.#after(idle.warning, () =>
            this.#warn("idleTime", Date.now() - this.#lastActivity, idle.maximum),
          )
        : undefined;
  }

  #warn(limit: AiLimitWarning["limit"], actual: number, maximum: number): void {
    if (this.#warned.has(limit) || this.signal.aborted) {
      return;
    }
    this.#warned.add(limit);
    this.#onWarning?.({ limit, actual, maximum });
  }
}
