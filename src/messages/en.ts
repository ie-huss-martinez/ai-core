import { defineMessages, type MessageValue, sdkCoreMessages } from "@hussmartinez/sdk-core";
import type { AiErrorCode } from "../core/errors/ai-error.js";
import type { AiLimitName } from "../core/limits/ai-limits.js";

/**
 * ai-core's English message catalogue: sdk-core's messages, and text for
 * every {@link AiErrorCode} and every limit's warning. ai-core renders
 * nothing, but hosts show errors to their users. Pass it to `createMessages`
 * from `@hussmartinez/sdk-core`, with the host's locale and overrides.
 *
 * Error text is looked up by code, with the error's `details` as
 * parameters, and never taken from `error.message` (sdk-core ADR 0019).
 *
 * @example
 * ```ts
 * const messages = createMessages(aiCoreMessages, { locale: "en", overrides });
 * messages.error(error); // "The response took longer than 15 minutes, so it was stopped."
 * ```
 *
 * @public
 */
export const aiCoreMessages = /* @__PURE__ */ defineMessages({
  ...sdkCoreMessages,
  "errors.INVALID_CONFIGURATION":
    "The assistant isn't set up correctly. Please contact the site's support.",
  "errors.INVALID_REQUEST": "This message couldn't be sent. Please try again.",
  "errors.MISSING_API_KEY":
    "The assistant isn't set up correctly. Please contact the site's support.",
  "errors.BROWSER_KEY_REFUSED":
    "The assistant isn't set up correctly. Please contact the site's support.",
  "errors.METHOD_NOT_ALLOWED": "This message couldn't be sent. Please try again.",
  "errors.UNSUPPORTED_MEDIA_TYPE": "This message couldn't be sent. Please try again.",
  "errors.ORIGIN_NOT_ALLOWED": "This page isn't allowed to use the assistant.",
  "errors.PROTOCOL_MISMATCH":
    "The page and the assistant are out of date with each other. Reload the page and try again.",
  "errors.CONTEXT_CHANGED":
    "The assistant's settings changed during this conversation. Start a new conversation to continue.",
  "errors.PREPARE_FAILED": "The assistant couldn't take your message. Please try again later.",
  "errors.REQUEST_TOO_LARGE":
    "This message is {actual, fileSize}, which is over the {maximum, fileSize} limit. Send less text or smaller images.",
  "errors.RESPONSE_TOO_LARGE":
    "The response was over the {maximum, fileSize} limit, so it was stopped.",
  "errors.STREAM_TIMEOUT": "The response took longer than {maximum, duration}, so it was stopped.",
  "errors.STREAM_IDLE":
    "The assistant stopped responding for {maximum, duration}, so the response was stopped. Please try again.",
  "errors.STREAM_TRUNCATED": "The response was cut off. Please try again.",
  "errors.PROVIDER_RESPONSE_INVALID":
    "The assistant sent a response that couldn't be read. Please try again.",
  "errors.SPEND_LIMIT_REACHED":
    "The assistant has reached its usage limit. Please try again later.",
  "warnings.responseBytes": "This response is large ({actual, fileSize}), and may be slow to show.",
  "warnings.streamDuration": "This response is taking a long time.",
  "warnings.idleTime": "The assistant is taking a long time to respond.",
  "warnings.requestBytes": "This message is large ({actual, fileSize}), and may be slow to send.",
}) satisfies Record<`errors.${AiErrorCode}`, MessageValue> &
  Record<`warnings.${AiLimitName}`, MessageValue>;

/**
 * The type of {@link aiCoreMessages}, for typing a host's overrides with
 * `MessageOverrides<AiCoreMessageCatalogue>`.
 *
 * @public
 */
export type AiCoreMessageCatalogue = typeof aiCoreMessages;
