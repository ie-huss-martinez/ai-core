/**
 * Core of ai-core: the message model, provider types, errors, limits, the
 * message catalogue and the browser transport.
 *
 * @remarks
 * This entry makes no request on import and touches no DOM, so it imports in
 * browsers, Node and Workers runtimes (sdk-core ADR 0035).
 *
 * @packageDocumentation
 */

export type { HttpTransportOptions } from "./adapters/http/transport.js";
export { httpTransport } from "./adapters/http/transport.js";
export type { AiErrorCode } from "./core/errors/ai-error.js";
export { AiError, isAiError } from "./core/errors/ai-error.js";
export type {
  AiLimitName,
  RequestLimitDefinitions,
  RequestLimitOverrides,
  RequestPolicy,
  ResponseLimitDefinitions,
  ResponseLimitOverrides,
  ResponsePolicy,
} from "./core/limits/ai-limits.js";
export {
  requestLimitDefinitions,
  requestLimits,
  responseLimitDefinitions,
  responseLimits,
} from "./core/limits/ai-limits.js";
export type {
  AiFinishReason,
  AiImageMediaType,
  AiImagePart,
  AiJsonValue,
  AiMessage,
  AiPart,
  AiProviderState,
  AiProviderStatePart,
  AiRole,
  AiTextPart,
  AiToolCallPart,
  AiToolResultPart,
  AiUsage,
} from "./core/model/message.js";
export type {
  AiCallOptions,
  AiEvent,
  AiFinishEvent,
  AiPartEvent,
  AiProvider,
  AiRequest,
  AiResult,
  AiSummaryDeltaEvent,
  AiTextDeltaEvent,
  AiTool,
  AiToolChoice,
} from "./core/model/provider.js";
export { withoutProviderState } from "./core/protocol/wire.js";
export type { AiLimitWarning } from "./core/stream/call-guard.js";
export type { AiCoreMessageCatalogue } from "./messages/en.js";
export { aiCoreMessages } from "./messages/en.js";
