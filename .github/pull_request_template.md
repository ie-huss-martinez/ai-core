<!--
The title must be a Conventional Commit with a lowercase subject, such as
"fix: stop the stream when the idle limit is reached". It becomes the commit
title on main. See CONTRIBUTING.md for how pull requests are merged.
-->

## What

<!-- What changed, in a few bullet points. -->

## Why

<!-- The problem this solves, with links to issues or ADRs. -->

## How it was tested

<!-- Include the result of `pnpm verify`, and anything you checked by hand. -->

## Checklist

- [ ] `pnpm verify` passes locally, and its result is above.
- [ ] Tests cover the change, next to the code.
- [ ] Exported APIs are typed and have TSDoc, and the API report is updated.
- [ ] New dependencies are justified above.
- [ ] READMEs and docs are accurate.
- [ ] No request is added on import, no request goes anywhere but the configured endpoint, and nothing is retried automatically.
- [ ] Keys, prompts and bodies stay out of errors, events, logs and the handler's responses, and the sentinel tests cover any new failure path.
- [ ] New input or output a provider or browser controls has a limit, and malformed input fails with a specific code.
- [ ] Provider-specific facts are checked against the provider's live documentation, linked above, and new fixtures were recorded by hand and contain no secrets.
- [ ] A changeset is added, if the change alters what the package publishes.
- [ ] Significant decisions are recorded as an ADR in `docs/adr`.
