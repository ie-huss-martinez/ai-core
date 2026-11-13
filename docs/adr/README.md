# Architecture decision records

Decisions specific to `@hussmartinez/ai-core`. Decisions for the whole SDK family live in [`sdk-core`'s `docs/adr`](https://github.com/ie-huss-martinez/sdk-core/tree/main/docs/adr); the records here build on them and never contradict them. To change a family decision, write a record in `sdk-core`.

Each record captures one significant decision: the context that forced it, what we chose, the alternatives we rejected and the consequences we accept. Records are numbered and immutable. To change a decision, write a new record that supersedes the old one and link the two. Records that depend on a provider's behaviour quote and link the provider's documentation, as checked on the record's date.

Use [`template.md`](template.md) for new records. Name files `NNNN-short-title.md`, taking the next free number.

| # | Decision | Status |
|---|---|---|
| [0001](0001-message-model-and-provider-state.md) | The message model, and provider state replayed unchanged | Accepted |
| [0002](0002-provider-shape.md) | One provider shape for adapters, the transport and custom providers | Accepted; amended 2026-11-13 (the contract suite takes `describe` and `it`) |
| [0003](0003-request-handler-and-wire-protocol.md) | The request handler, a required `prepare`, and the `ai-core/1` protocol | Accepted |
| [0004](0004-keys-and-runtime-detection.md) | Keys stay on the server: how adapters hold keys and recognise a server | Accepted |
| [0005](0005-limits-and-streams.md) | Limits on requests and responses, and how streams are read | Accepted |
| [0006](0006-recorded-fixtures.md) | Tests replay recorded provider responses, recorded only by hand | Accepted |
| [0007](0007-no-automatic-retries.md) | No automatic retries: errors say whether and when to retry | Accepted |
| [0008](0008-no-provider-side-storage.md) | ai-core never asks a provider to retain conversations | Accepted; amended 2026-11-13 (OpenAI-compatible and Kimi) |
