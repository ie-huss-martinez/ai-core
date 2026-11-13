# Contributing

Thank you for helping. This repository is the AI provider layer of the `@hussmartinez` SDK family, and the family's only package with network code. It sends users' prompts to AI providers, holds the API keys that pay for them, and passes model output back to other people's applications, so changes here are held to a high bar. That's why the process below is a little more formal than usual.

By taking part, you agree to follow the [code of conduct](CODE_OF_CONDUCT.md). To report a vulnerability, follow the [security policy](SECURITY.md) instead of opening an issue.

## Before you start

- **Open an issue first** for anything bigger than a small fix, so we can agree on the approach before you spend time on it. New providers, options, events, error codes, handler behaviour and changes to the wire protocol are public API or security-relevant, so they always start with an issue.
- **Read [`STANDARDS.md`](https://github.com/ie-huss-martinez/sdk-core/blob/main/STANDARDS.md)** in `sdk-core`. It's binding for every repository in the family. The reasoning behind each rule is in the [family's architecture decision records](https://github.com/ie-huss-martinez/sdk-core/tree/main/docs/adr), and decisions specific to this repository go in `docs/adr`.
- **Coding agents** also start with [`AGENTS.md`](AGENTS.md).

## Set up

You need Node 24 (see [`.node-version`](.node-version)) and pnpm. pnpm switches to the version pinned in `package.json` automatically.

```sh
pnpm install       # also installs the git hooks
pnpm verify        # everything CI runs
pnpm verify:fast   # the subset the pre-push hook runs
```

Browser tests need Playwright's browsers once: `pnpm exec playwright install chromium`. Add `firefox webkit` to run all three engines, as CI does, with `CI=1 pnpm verify` or `pnpm test:browser:all`.

The repository root is the published package, laid out as in the family's [standard layout](https://github.com/ie-huss-martinez/sdk-core/blob/main/STANDARDS.md#repository-layout): the source is in `src/`, with one entry file per export, and the workspace also holds `examples/next`, a Next.js application that uses the built package, and `e2e/`, the Playwright suite that runs against it.

The git hooks run on their own: a secret scan and lint of staged files on commit, a Conventional Commits check of each message, and `pnpm verify:fast` on push. Don't bypass them with `--no-verify`. If a hook is wrong or too slow, fix it in its own pull request.

## Make a change

- **One focused change per pull request,** on a branch from an up-to-date `main`. Small pull requests get reviewed quickly; large ones get split.
- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/), with a lowercase subject and a header of at most 72 characters:
  - **types:** `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore` and `revert`;
  - **scopes** are optional; this repository publishes one package;
  - **`feat`** for any new public capability, such as a provider, an option, an event, an error code or a handler feature;
  - **breaking changes** take a `!`, as in `feat!: …`, and explain the migration in the body.
- **Signed commits** are preferred.
- **Tests:** unit tests sit next to the code as `*.test.ts`, and browser tests as `*.browser.test.ts`. Test behaviour, not lines of code. Every adapter, the transport and the fake provider pass the provider contract suite.
- **No real requests in tests:** tests replay recorded provider responses through an injected `fetch`. CI never calls a provider and never holds a key.
- **Recorded fixtures:** recorded only by hand, with `scripts/record-fixtures.mjs` and your own key from the environment, using the fixed prompts in the script. The script replaces request IDs and keeps only allowlisted headers. Read the result, and let the secret scan run, before committing it. Never commit a key, a real user's prompt or output, or a response with account details.
- **Provider facts are checked, not remembered:** every header, API version, URL, event name, error shape or CORS behaviour an adapter relies on is confirmed against the provider's live documentation in the pull request that adds it, with the documentation's URL in the description.
- **Public API:** fully typed, with TSDoc on every export. If a change alters the API on purpose, update the reports with `pnpm api:update` and commit them.
- **Network:** nothing is requested on import, in a browser or on a server, and the tests for every entry prove it. A request goes only to the endpoint an adapter or transport was configured with, for a call the host or user started. There's no telemetry, and nothing is retried automatically.
- **Keys:** keys stay on the server by default. An adapter reads its key only when building a request, and never stores it where it could be serialised or logged. In a browser it refuses to run without `dangerouslyAllowBrowser: true`, and it refuses when the runtime is unclear.
- **Secrets never leak:** keys, prompts and request or response bodies never reach an error's `message`, `details` or `cause`, serialised errors, events, logs or the handler's responses. Every adapter and the handler have a sentinel test that plants a key and a prompt and checks every failure path. A new failure path joins it.
- **The server handler:** `prepare` is required, and it alone sets the model, system prompt, tools and output budgets. The handler accepts only `POST` with `content-type: application/json` and never logs bodies.
- **Hostile responses:** provider responses, streams and the handler's incoming requests are hostile input. Each new resource they control gets a limit from `defineLimits`, with its own error code. A malformed response fails with a specific code, never an escaping exception, a hang or a half-parsed result. Parsers have tests for chunk boundaries anywhere, including inside multi-byte characters, and for truncated and oversized input.
- **Provider state and tool calls:** opaque provider state, such as thinking blocks, is replayed to the provider unchanged and never treated as display content. Tool calls are reported, never executed automatically.
- **Errors and text:** `AiError` codes are stable once released, and every code has a message in `src/messages/en.ts`. User-facing text never comes from `error.message`.
- **Dependencies:** no vendor SDKs: adapters use `fetch` and the package's own parser. `@hussmartinez/sdk-core` is the only runtime dependency, and adding another needs an ADR. Dev dependencies need a justification in the pull request, and every licence must be compatible with Apache-2.0.
- **Docs:** keep the READMEs accurate.
- **Decisions:** anything that affects public API, consistency across the family or security, or that is hard to reverse, gets an ADR in `docs/adr` in the same pull request. To change a decision, add a new ADR that supersedes the old one. A change to a family-wide decision belongs in `sdk-core`.

## Open a pull request

- **Title:** a Conventional Commit of at most 65 characters, because it becomes the commit title on `main`, followed by ` (#NNN)`, and that must fit in 72. Put explanations in the description. The `pr-title` check enforces both.
- **Description:** fill in the template: what changed, why, and how you tested it, including the result of `pnpm verify`. Be as detailed as is useful; the description doesn't go into git history.
- **Changeset:** add one if the pull request changes what the package publishes. See [Changesets](#changesets).
- **Checks:** `verify`, `changeset` and `pr-title` must pass, and the branch must be up to date with `main`.

Mark the pull request ready once `pnpm verify` passes locally. CI is the final gate, not a substitute for running it yourself.

## How pull requests are reviewed

**The author of a pull request never merges it.** A separate reviewer does, after reviewing it:

- **The diff:** the reviewer reads the full diff and checks it against `STANDARDS.md` and the ADRs.
- **The checks:** CI must be green. For any change to code, the reviewer also runs `pnpm verify` independently, rather than relying on the author's result.
- **Not "almost right":** if the scope, title or quality isn't right, the pull request is fixed before it's merged.

**Coding agents** open one pull request at a time. After opening it, they stop and report the link, a short summary and their `pnpm verify` result. They start the next change only after the pull request is merged, from an up-to-date `main`. An agent never reviews or merges a pull request it wrote; author and reviewer are always different sessions.

## How pull requests are merged

Pull requests are squash-merged into a linear `main`, and the reviewer writes the squash commit message:

- **Title:** the pull request title, followed by the pull request number, such as `feat: add the gemini adapter (#11)`.
- **Body:** 2–6 lines of plain prose, wrapped at 72 characters, saying what changed and why.
- **Never in the body:** Markdown headings, checklists or test logs. Those belong in the pull request description.

For example:

```text
feat: add the gemini adapter (#11)

Adds an adapter for Gemini's streaming API, with the key sent in a
header and thought signatures replayed unchanged as provider state.
Recorded responses cover text, tool calls, errors and truncation.
```

## Changesets

Versions and release notes come from changesets ([ADR 0021](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0021-version-and-release-with-changesets.md)), not from commit messages. A changeset is a small Markdown file in `.changeset/` that names the version bump a pull request needs and a note for the people who use the package.

```sh
pnpm changeset
```

It asks how the package changed, then writes the file. Commit it with your change.

- **When you need one:** whenever a pull request changes the package's published source or its `package.json`, meaning `src/` outside tests and fixtures.
- **When you don't:** for tests, fixtures, examples, READMEs, documentation, CI and root tooling. If a change touches published files without affecting users, such as a pure refactor, add an empty changeset with `pnpm changeset --empty`.
- **The bump:**
  - `patch` for fixes;
  - `minor` for new capabilities, and during `0.x` for breaking changes too;
  - `major` only after `1.0`, for breaking changes.

**Write the note for users, not reviewers.** It becomes the package's changelog entry and its GitHub Release notes.

- **Say what changed for them, and what to do:** "`stream()` now fails with `STREAM_IDLE` when a provider sends nothing for `idleTime`" rather than "refactor the stream guard".
- **Name the API they'll see:** function, option, event, error code or entry point. Describe the behaviour, not the implementation.
- **Explain the migration** for anything breaking: what to change in their code, with a short example.
- **Keep it short.** One or two sentences is typical, with a list for several related changes. The pull request holds the detail.

## How releases happen

Nobody publishes by hand ([ADR 0021](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0021-version-and-release-with-changesets.md), [ADR 0023](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0023-verify-releases-in-an-unprivileged-job.md)).

1. **The version pull request.** When changesets reach `main`, the release workflow opens or updates a **`chore: version packages`** pull request. It applies the changesets: it bumps the version, writes the changelog and deletes the changeset files.
2. **Merging it.** The version pull request is reviewed and merged like any other.
3. **Publishing.** Once it's merged, the same workflow:
   - runs `pnpm verify` in the browser test image, in a job with read-only permissions;
   - publishes the new version to npm through trusted publishing, with provenance and no npm token, only if that verification passed;
   - creates a tag such as `@hussmartinez/ai-core@0.2.0` and a GitHub Release with the changelog entry;
   - attaches the tarball and `SHA256SUMS`, with artifact attestations.

**If a release partly fails,** the workflow run fails, and anything that did publish still gets its tarball, `SHA256SUMS` and attestation. After fixing the cause, re-run the workflow or push to `main` again. Every run checks the package's current version against npm and its GitHub Release, publishes what's missing, and repairs a release without its files, using the tarball downloaded from npm and verified against the registry's integrity. A complete release is left alone.

**npm can take several minutes** to serve a version it has just accepted. The workflow waits up to 10 minutes from the publish, and logs a "Visible on npm" notice with the time it took. If the version still isn't visible by then, the run fails; re-run the failed job once npm shows the version, and it repairs the release from npm.

## Setting up releases

These are one-time steps for the maintainer.

### The GitHub App for the version pull request

The App and its credentials are shared by the `ie-huss-martinez` organisation's repositories, and set up once for the organisation, as described in [sdk-core's contributing guide](https://github.com/ie-huss-martinez/sdk-core/blob/main/CONTRIBUTING.md#setting-up-releases): the variable `RELEASE_APP_CLIENT_ID` and the secret `RELEASE_APP_PRIVATE_KEY`, with access only for the repositories that release. Make sure this repository has access to both.

This repository's **`release` environment**, restricted to `main` so the `version` job only runs there, is created by `sdk-core`'s [`create-sdk-repo`](https://github.com/ie-huss-martinez/sdk-core/blob/main/CONTRIBUTING.md#setting-up-a-new-repository). It needs no secrets. The `version` job fails with these instructions until the App's credentials are available.

### npm

1. **The `npm` environment,** restricted to `main`, is created by `create-sdk-repo` too. Add yourself as a required reviewer if you want to approve each publish.
2. **Bootstrap the first publish.** npm can only configure a trusted publisher for a package that already exists, so the first version needs a token:
   1. Create a granular access token that can publish only `@hussmartinez/ai-core`, with an expiry of a few days. Store it only as the secret `NPM_TOKEN` in the `npm` environment.
   2. Merge the first version pull request. The publish job uses the token, logs a warning that it did, and still attaches provenance.
   3. **Straight away,** configure the trusted publisher for `@hussmartinez/ai-core`: Package settings → Trusted Publisher → GitHub Actions, with organisation `ie-huss-martinez`, repository `ai-core`, workflow `release.yml`, environment `npm`, and direct `npm publish` allowed. npm expires a configuration that hasn't published within two days, which is why this comes right after the bootstrap.
   4. Delete the `NPM_TOKEN` secret, revoke the token on npm, and turn on "Require two-factor authentication and disallow tokens" for the package, under Settings → Publishing access.

From then on, publishing uses trusted publishing only, with no token anywhere.

**If the repository moves to another owner,** update the package's trusted publisher to the new owner before the next release. npm rejects a publish from an owner its trusted publisher doesn't name, and provenance rejects one whose `repository.url` doesn't match the repository the workflow runs in.

## Licence

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE), like the rest of the project.
