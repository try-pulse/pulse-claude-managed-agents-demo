# Claude Managed Agents for Pulse

A standalone [Bun](https://bun.sh) example that connects a [Claude Managed Agent](https://platform.claude.com/docs/en/managed-agents/overview) to a Pulse agent app. It follows the shape of [Linear's Claude Managed Agents demo](https://github.com/linear/claude-managed-agents-demo): Pulse receives an agent session webhook, the bridge starts a Claude session, and Claude's work appears as Pulse activities. This is an example, not a production deployment template.

## Run it

You need Bun 1.4+, an Anthropic API key, a Claude Managed Agent ID and environment ID, and permission to register an agent app in a Pulse workspace.

```bash
bun install --frozen-lockfile
cp .env.example .env.local
# Fill in .env.local, then:
bun run dev
```

The SDK is bundled in this repository as `vendor/try-pulse-agent-sdk-0.1.0.tgz`. It is the output of `npm pack` from `@try-pulse/agent-sdk` 0.1.0. Bun installs that packed artifact as a regular dependency; no SDK checkout, workspace, or registry publication is required. The committed `bun.lock` pins its checksum.

Configure these values in `.env.local`:

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `CLAUDE_AGENT_ID`, `CLAUDE_ENVIRONMENT_ID` | Existing Claude Managed Agent and environment |
| `PULSE_CLIENT_ID`, `PULSE_CLIENT_SECRET`, `PULSE_WEBHOOK_SECRET` | Values returned once when you register the Pulse app |
| `INSTALL_SECRET` | Long random secret guarding `/oauth/authorize` |
| `BASE_URL` | Public HTTPS origin reaching this server |
| `PORT` | Local listener port; defaults to `3000` |
| `PULSE_API_URL` | Optional Pulse API root; defaults to `https://api.trypulse.tech/api/v1` |

Set the webhook URL in `pulse-agent-app.json` to `<BASE_URL>/webhook` and its OAuth redirect URL to `<BASE_URL>/oauth/callback`. Register that manifest through `POST https://api.trypulse.tech/api/v1/agent-apps` with a signed-in person's session token and `X-Workspace-ID`; an app token cannot register an app. Add the returned client ID, client secret (`pulse_sk_…`), and webhook secret (`pwhsec_…`) to `.env.local`. The server validates its configuration at startup. Open `<BASE_URL>/oauth/authorize?install_secret=<INSTALL_SECRET>` as a workspace admin and approve installation. Finally, @mention or delegate an issue to the app.

`BASE_URL` must be reachable from Pulse over HTTPS. For local development, use an HTTPS tunnel to the configured `PORT` and set `BASE_URL` to the tunnel's public origin.

## Verify

```bash
bun test
bun run typecheck
```

Tests use fake Pulse and Anthropic boundaries, so no live credentials are needed. They cover successful response, Stop, failure reporting, and startup configuration.

## How it works

1. `POST /webhook` verifies the lowercase hex `Pulse-Signature` over the raw body and checks the signed body `webhook_timestamp` within 60 seconds. The `Pulse-Timestamp` header is not signed. The SDK acknowledges before starting the callback; Pulse requires a `2xx` within 5 seconds. It deduplicates by `data.event_id`.
2. On `created` or a normal `prompted` follow-up, the bridge posts a `thought`, opens a Claude Managed Agent event stream, sends the prompt, then relays tool use as `action` activities and the answer as a final `response`. The first activity on `created` is due within 10 seconds.
3. A Pulse Stop signal interrupts the active Claude session and posts one final response within 60 seconds. Uninstall removes stored installation tokens.

The other routes are `GET /` (health), `GET /oauth/authorize` (protected install), and `GET /oauth/callback` (OAuth exchange). OAuth tokens are stored in `.pulse-tokens.json` with file mode `0600`. This file and `.env.local` are ignored by Git. File token storage and in-memory Stop/deduplication state are suited to a single process; a multi-replica deployment needs shared stores.

## Updating the SDK artifact

When a new SDK tarball is built with `npm pack` in the SDK package, copy it into `vendor/`, update the `@try-pulse/agent-sdk` tarball path in `package.json`, run `bun install`, and commit the new tarball and `bun.lock` together. The sample always installs the same packed artifact that an outside application would install.
