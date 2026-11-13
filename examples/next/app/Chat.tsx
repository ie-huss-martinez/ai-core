"use client";

import {
  type AiMessage,
  type AiPart,
  aiCoreMessages,
  httpTransport,
  isAiError,
  withoutProviderState,
} from "@hussmartinez/ai-core";
import { createMessages } from "@hussmartinez/sdk-core";
import { type FormEvent, useEffect, useRef, useState } from "react";

// The browser's provider: it holds no key, and sends only the conversation.
const provider = httpTransport({ url: "/api/chat" });
// Users see text chosen by the error's code, never `error.message`.
const text = createMessages(aiCoreMessages, { locale: "en" });

/** Only text is shown. Provider state, such as thinking, is kept but never displayed. */
function visibleText(message: AiMessage): string {
  return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

export function Chat() {
  const [conversation, setConversation] = useState<AiMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<{ text: string; contextChanged: boolean } | null>(null);
  const [ready, setReady] = useState(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => setReady(true), []);

  async function send(history: AiMessage[]): Promise<void> {
    const abort = new AbortController();
    controller.current = abort;
    setConversation(history);
    setAnswer("");
    setError(null);
    setStatus("Answering…");
    const parts: AiPart[] = [];
    try {
      for await (const event of provider.stream({ messages: history }, { signal: abort.signal })) {
        if (event.type === "text-delta") {
          setAnswer((current) => (current ?? "") + event.text);
        } else if (event.type === "part") {
          // Every part is kept, in order, including the handler's context
          // hash and the provider's state: the next turn sends them back.
          parts.push(event.part);
        }
      }
      setConversation([...history, { role: "assistant", parts }]);
      setStatus("");
    } catch (caught) {
      // An unfinished answer isn't kept: its provider state would be incomplete.
      if (isAiError(caught, "ABORTED")) {
        setStatus("Stopped.");
      } else {
        setStatus("");
        setError({
          text: text.error(caught),
          contextChanged: isAiError(caught, "CONTEXT_CHANGED"),
        });
      }
    } finally {
      setAnswer(null);
      controller.current = null;
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const message = draft.trim();
    if (!message || controller.current) {
      return;
    }
    setDraft("");
    void send([...conversation, { role: "user", parts: [{ type: "text", text: message }] }]);
  }

  const busy = answer !== null;

  return (
    <>
      <ol aria-label="Conversation" aria-live="polite">
        {conversation.map((message, index) => (
          // The conversation is append-only, so the index is a stable key.
          <li key={index} data-role={message.role}>
            <strong>{message.role === "user" ? "You" : "Assistant"}:</strong> {visibleText(message)}
          </li>
        ))}
        {busy && (
          <li data-role="assistant" data-streaming="">
            <strong>Assistant:</strong> {answer}
          </li>
        )}
      </ol>
      <p role="status">{status}</p>
      {error && (
        <div role="alert">
          <p>{error.text}</p>
          {error.contextChanged && (
            <button type="button" onClick={() => void send(withoutProviderState(conversation))}>
              Continue without the earlier reasoning
            </button>
          )}
        </div>
      )}
      <form onSubmit={submit} data-ready={ready ? "" : undefined}>
        <label htmlFor="message">Message</label>
        <textarea
          id="message"
          rows={3}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div>
          <button type="submit" disabled={busy || !ready}>
            Send
          </button>
          <button type="button" disabled={!busy} onClick={() => controller.current?.abort()}>
            Stop
          </button>
        </div>
      </form>
    </>
  );
}
