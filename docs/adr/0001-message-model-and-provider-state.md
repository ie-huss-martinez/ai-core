# 0001. The message model, and provider state replayed unchanged

- **Status:** Accepted
- **Date:** 2026-11-12

## Context

`ai-core` gives every provider one model for messages, results and usage, so that hosts and SDK ports deal with one shape ([sdk-core ADR 0035](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0035-ai-core-and-host-configured-network.md)). Most of a conversation maps cleanly between providers: text, images, tool calls and tool results. One part doesn't. Providers return **state that the caller must send back exactly as received**, or the next request fails or loses its reasoning. Checked against the providers' documentation on 2026-11-12:

- **Anthropic.** Thinking blocks carry a `signature`, "an encrypted copy of the full reasoning that you pass back unchanged in multi-turn and tool-use conversations". Within a tool-use turn, "pass every `thinking` block back to the API complete and unmodified", and "modified thinking blocks are rejected with a 400 error". `redacted_thinking` blocks hold an opaque `data` field and must also be passed back unchanged. On models with *preserved thinking*, such as Claude Opus 5.5 and Sonnet 5.5, "if your code changes `system`, `tools`, or an earlier message, every thinking block that already follows the change fails the prefix check", and the request can get a 400. A thinking block may also carry readable summary text, depending on its `display` setting. ([Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking): "Preserving thinking blocks", "Thinking encryption", "Redacted thinking blocks", "Preserved thinking".)
- **Gemini.** `Part.thoughtSignature` is "an opaque signature for the thought so it can be reused in subsequent requests", and `Part.thought` marks a part as the model's thought ([API reference: generateContent](https://aistudio.google.com/api-reference/generate-content)). The thinking guide says thought blocks must be resent "exactly as they were received from the model", and that a thought block "may contain only a signature with no summary" ([Thinking](https://aistudio.google.com/docs/thinking)). The signature is attached to a part, which can be a function call, rather than being a part of its own.
- **Kimi (OpenAI-compatible).** Thinking models return `reasoning_content` next to `content`, and for tool calls and multi-turn chats you must "pass the complete assistant message back as-is, including `reasoning_content`" ([Kimi K2 thinking model](https://platform.kimi.ai/docs/guide/use-kimi-k2-thinking-model)).

Anthropic's documented stop reasons are `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`, `refusal` and `model_context_window_exceeded`. A refusal arrives "as a normal HTTP 200 response, not an error" ([Handling stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)).

A model that keeps only the readable parts would break tool use on all three providers.

## Decision

### Messages and parts

- **A message** has a `role`, either `user` or `assistant`, and an ordered list of `parts`. The system prompt isn't a message: it's a field of the request, which the server sets ([0002](0002-provider-shape.md)).
- **Parts:**

  | Part | Fields | Notes |
  |---|---|---|
  | `text` | `text` | Untrusted text when it comes from a model. Never markup. |
  | `image` | `mediaType`, `data` | `data` is the image's bytes (`Uint8Array`). There's no URL form, so a provider is never asked to fetch an address. Media types are allowlisted: PNG, JPEG, WebP and GIF. |
  | `tool-call` | `id`, `name`, `input` | `input` is the parsed JSON arguments, untrusted. Reported, never executed. |
  | `tool-result` | `callId`, `content`, `isError?` | Sent in a `user` message. `content` is text or text and image parts. |
  | `provider-state` | `provider`, `data`, `summary?` | Opaque state to replay; see below. |

- **Tool results go in `user` messages,** as Anthropic's API expects. Adapters map them to each provider's form, such as a `tool` role or a function response.

### Provider state

- **`provider-state` parts hold whatever a provider requires back unchanged** and that isn't a text, image or tool part of its own. That's Anthropic's `thinking` and `redacted_thinking` blocks, and Kimi's `reasoning_content`.
- **`providerState` on `text` and `tool-call` parts:** when a provider attaches its state to another part, as Gemini attaches `thoughtSignature` to a function-call or text part, that part carries it in an optional `providerState` field, `{ provider, data }`.
- **`data` is opaque.** It's JSON-serialisable data that only the adapter that produced it reads. Nothing else interprets, edits, reorders, merges or drops it. Adapters replay it in its original position, exactly as received.
- **`provider`** names the adapter that produced it, such as `"anthropic"`, `"gemini"` or `"kimi"`. An adapter replays only its own provider's state, and silently leaves out another provider's state when a conversation switches provider. The text, image and tool parts still go through.
- **`summary`** is readable text that some providers return about the model's reasoning: Anthropic's summarised thinking or progress updates, Gemini's thought summaries, Kimi's `reasoning_content`. It may be empty or absent. It's **untrusted text**, never markup. A host or an SDK may show it, under its own display rules. It never contains or replaces `data`, and editing it changes nothing that's replayed.
- **`data` is never display content.** It isn't shown, logged, put in events or error details, or sent to any provider other than the one that produced it.

### Results and usage

- **Finish reasons** are normalised. The provider's own value is kept in `rawFinishReason` for diagnostics:

  | `finishReason` | Anthropic | Meaning |
  |---|---|---|
  | `stop` | `end_turn`, `stop_sequence` | The model finished. |
  | `length` | `max_tokens`, `model_context_window_exceeded` | Output was cut off by a limit. |
  | `tool-calls` | `tool_use` | The message ends with tool calls for the host to handle. |
  | `refusal` | `refusal` | The model declined. HTTP 200, not an error. |
  | `other` | `pause_turn`, and any value an adapter doesn't know | Check `rawFinishReason`. |

  Each adapter's mapping for the other providers is checked against their documentation in its own pull request.
- **Usage** has `inputTokens` and `outputTokens`, plus `cacheReadTokens`, `cacheWriteTokens` and `reasoningTokens` where the provider reports them. Fields a provider doesn't report are absent, never zero.
- **A complete result** is the assistant `message`, the `finishReason`, `rawFinishReason` and `usage`. Streamed events are defined with the provider shape ([0002](0002-provider-shape.md)).

### Conversations

- **Hosts keep conversations append-only,** replaying every message and part as returned, including provider state. Editing or removing an earlier message, or changing the system prompt or tools during a conversation, can make a provider reject or ignore the state that follows. That's documented in the README and in the handler's guide (the handler's ADR, which follows).
- **The model is plain data,** apart from image bytes. It can be stored and sent as JSON, with images as base64 in JSON. The wire protocol defines that encoding.

## Alternatives considered

- **Dropping reasoning content:** rejected. It breaks tool use on Anthropic, with a 400 for modified or missing blocks, and loses Gemini's and Kimi's reasoning continuity.
- **Each provider's raw message format as the model:** rejected. Hosts and SDK ports would need provider-specific code, which is what `ai-core` exists to avoid.
- **A typed reasoning part per provider,** such as `anthropic-thinking`: rejected. Every new provider or block type would change the public model. One opaque part, plus a field for state attached to other parts, absorbs new kinds of state without a release.
- **Treating `summary` as `data`:** rejected. Providers return readable reasoning separately from the state they verify. Mixing them would invite hosts to display or edit the part that must stay unchanged.
- **Images by URL:** rejected. A URL asks the provider to fetch an address chosen by the host or, worse, by a model or user, which ADR 0035 and the security policy rule out.

## Consequences

- Tool use and reasoning continuity work on all three providers, and conversations can switch provider without errors, losing only the other provider's opaque state.
- Hosts and SDK ports must carry `provider-state` parts and `providerState` fields through unchanged, even though they never display `data`. SDK ports need a way to pass them through, and the first SDK that displays model output records how in its own ADR.
- Hosts that edit history or change the system prompt or tools mid-conversation will see provider errors. The documentation says so, and the handler keeps those server-side (the handler's ADR, which follows).
- Adding a provider means mapping its parts, state and finish reasons into this model, checked against its documentation, without changing the model.
