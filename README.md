# Claude Managed Agents for Pulse

Connect a [Claude Managed Agent](https://platform.claude.com/docs/en/managed-agents/overview) to Pulse as an agent app. When someone delegates an issue to the app or @mentions it, Pulse opens an agent session, this bridge runs the Claude session, and Claude's work shows up in Pulse as session activities. Built with [`@try-pulse/agent-sdk`](https://www.npmjs.com/package/@try-pulse/agent-sdk) and [Bun](https://bun.sh).

This is an example, not a production deployment template.

## How it works

1. `POST /webhook` receives signed `AgentSessionEvent` webhooks. The SDK verifies the `Pulse-Signature` HMAC over the raw body and the signed `webhook_timestamp` (60 seconds), answers `200` right away (Pulse requires a `2xx` within 5 seconds), and deduplicates by `data.event_id`.
2. On `created`, or a `prompted` follow-up, the bridge posts a `thought` (the first activity is due within 10 seconds), opens a Claude Managed Agent event stream, sends the prompt, relays Claude's tool use as `action` activities, and posts the answer as a final `response`.
3. A Stop from Pulse interrupts the Claude session and posts one final response within 60 seconds. Uninstalling the app removes its stored tokens.

## Prerequisites

- [Bun](https://bun.sh) 1.4 or later
- An Anthropic API key, and a Claude Managed Agent with its environment
- A Pulse workspace where you can register an agent app, and a workspace admin to install it
- A public HTTPS URL that reaches this server (for local development, an HTTPS tunnel such as ngrok)

## Setup

### 1. Install dependencies

```bash
bun install
```

### 2. Register the agent app in Pulse

Edit `pulse-agent-app.json`: set `oauth.redirect_uris` to `<BASE_URL>/oauth/callback` and `webhook.url` to `<BASE_URL>/webhook`.

In Pulse, open **Settings → API → Agent apps**, choose **Import manifest**, and paste the file. You can also send it to `POST https://api.trypulse.tech/api/v1/agent-apps` with your session token and `X-Workspace-ID`. Pulse shows the client secret (`pulse_sk_…`) and webhook secret (`pwhsec_…`) once; copy them.

### 3. Configure the environment

```bash
cp .env.example .env.local
```

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `CLAUDE_AGENT_ID`, `CLAUDE_ENVIRONMENT_ID` | Your Claude Managed Agent and environment |
| `PULSE_CLIENT_ID`, `PULSE_CLIENT_SECRET`, `PULSE_WEBHOOK_SECRET` | From step 2 |
| `INSTALL_SECRET` | A long random secret that guards `/oauth/authorize` |
| `BASE_URL` | The public HTTPS origin of this server |
| `PORT` | Local port, default `3000` |
| `PULSE_API_URL` | Optional; defaults to `https://api.trypulse.tech/api/v1` |

### 4. Start the server

```bash
bun run dev
```

The server validates its configuration at startup.

### 5. Install the app in your workspace

As a workspace admin, open `<BASE_URL>/oauth/authorize?install_secret=<INSTALL_SECRET>`. This starts OAuth with `actor=app`: Pulse shows the consent screen, you pick the teams the app may work in, and Pulse creates the app's own user.

### 6. Use it

Delegate an issue to the app, or @mention it in a comment. Follow the session in the issue's agent panel; reply there to send a follow-up, or press Stop.

## Tests

```bash
bun test
bun run typecheck
```

The tests use fake Pulse and Anthropic boundaries, so they need no credentials. They cover a successful response, Stop, failure reporting and startup configuration.

## Project structure

```
src/
  main.ts     HTTP server: /, /webhook, /oauth/authorize, /oauth/callback
  agent.ts    Agent session handling: Claude run, activities, Stop
  oauth.ts    Install flow, token storage, uninstall
  config.ts   Environment validation
test/         Tests with fake Pulse and Anthropic clients
pulse-agent-app.json   Agent app manifest
```

OAuth tokens are stored in `.pulse-tokens.json` (mode `0600`); it and `.env.local` are ignored by Git. File token storage and in-memory Stop and deduplication state suit a single process; run several replicas only with shared stores.

## Learn more

- [Pulse agent developer docs](https://trypulse.tech/docs/developers/agents)
- [`@try-pulse/agent-sdk`](https://github.com/try-pulse/pulse-agent-sdk)
- [Scout](https://github.com/try-pulse/pulse-agent-scout), a sample agent without an LLM
