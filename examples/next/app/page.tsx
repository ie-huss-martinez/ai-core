import { Chat } from "./Chat";

export default function Page() {
  return (
    <main>
      <h1>Chat with ai-core</h1>
      <p>
        The page streams answers from its own endpoint, <code>/api/chat</code>, which calls the
        provider from the server.
      </p>
      <Chat />
    </main>
  );
}
