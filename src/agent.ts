import type Anthropic from "@anthropic-ai/sdk";
import {
  isSessionEnded,
  type AgentSessionCreatedEvent,
  type AgentSessionPromptedEvent,
  type PulseAgentClient,
  type SessionContext,
} from "@try-pulse/agent-sdk";

type AgentSessionEvent = AgentSessionCreatedEvent | AgentSessionPromptedEvent;
type PulseWriter = Pick<PulseAgentClient, "thought" | "action" | "respond" | "error">;

/** The network boundaries are injected so the bridge can be tested without real credentials. */
export function createAgentSessionHandler(deps: {
  anthropic: Anthropic;
  pulseForEvent: (event: AgentSessionEvent) => PulseWriter;
  agentId: string;
  environmentId: string;
}) {
  const { anthropic, pulseForEvent, agentId, environmentId } = deps;
  const turns = new Map<string, Promise<unknown>>();

  async function runTurn(event: AgentSessionEvent, { signal }: SessionContext, pulse: PulseWriter) {
    const sessionId = event.data.agent_session.id;
    let interrupt: (() => void) | undefined;
    try {
      signal.throwIfAborted();
      await pulse.thought(sessionId, "Processing your request...", { signal });
      signal.throwIfAborted();
      const claudeSession = await anthropic.beta.sessions.create({
        agent: { type: "agent", id: agentId },
        environment_id: environmentId,
        betas: ["managed-agents-2026-04-01"],
      }, { signal });
      interrupt = () => {
        void anthropic.beta.sessions.events.send(claudeSession.id, {
          events: [{ type: "user.interrupt" }],
          betas: ["managed-agents-2026-04-01"],
        }).catch((err) => console.error(`[agent] Interrupt failed for ${claudeSession.id}:`, err));
      };
      // Stop can arrive before Claude returns its session ID.
      if (signal.aborted) {
        interrupt();
        return;
      }
      signal.addEventListener("abort", interrupt, { once: true });

      console.log(`[agent] Claude session created: ${claudeSession.id}`);

      // Open stream before sending message
      const stream = await anthropic.beta.sessions.events.stream(claudeSession.id, {
        betas: ["managed-agents-2026-04-01"],
      }, { signal });

      signal.throwIfAborted();
      await anthropic.beta.sessions.events.send(claudeSession.id, {
        events: [
          {
            type: "user.message",
            content: [{ type: "text", text: buildPrompt(event) }],
          },
        ],
        betas: ["managed-agents-2026-04-01"],
      }, { signal });

      // Stream Claude's response and relay to Pulse
      let responseText = "";

      for await (const event of stream) {
        // Stopped: stop relaying; the stop handler interrupts Claude and posts the final activity
        if (signal.aborted) break;
        if (event.type === "agent.message") {
          for (const block of event.content) {
            if (block.type === "text") {
              responseText += block.text;
            }
          }
        } else if (
          event.type === "agent.tool_use" ||
          event.type === "agent.mcp_tool_use" ||
          event.type === "agent.custom_tool_use"
        ) {
          // Show tool usage as an action in Pulse
          await pulse.action(
            sessionId,
            { action: event.name || "Processing", parameter: null },
            { ephemeral: true, signal }
          );
        } else if (event.type === "session.status_terminated") {
          break;
        } else if (
          event.type === "session.status_idle" &&
          event.stop_reason.type !== "requires_action"
        ) {
          break;
        }
      }

      // Stopped while streaming: the stop handler posts the final activity
      if (signal.aborted) return;

      // Post the final response
      await pulse.respond(
        sessionId,
        responseText.trim() || "I finished without a written answer.",
        { signal }
      );

      console.log(`[agent] Session ${sessionId} completed`);
    } catch (err) {
      // Pulse ended the session (uninstall, team removed, issue deleted): stop, post nothing
      if (isSessionEnded(err) || signal.aborted) return;
      console.error(`[agent] Error in session ${sessionId}:`, err);
      await pulse.error(
        sessionId,
        `Agent encountered an error: ${err instanceof Error ? err.message : String(err)}`,
        { signal }
      );
    } finally {
      if (interrupt) signal.removeEventListener("abort", interrupt);
    }
  }

  return async function handleAgentSession(event: AgentSessionEvent, ctx: SessionContext & { isStop?: boolean }) {
    const sessionId = event.data.agent_session.id;
    const pulse = pulseForEvent(event);
    let turn: Promise<unknown>;
    if (ctx.isStop) {
      // Bypass the cancelled queue. A reopened turn must wait for this final write.
      turn = pulse.respond(sessionId, "Stopped. I made no further changes.").catch((err) => {
        if (!isSessionEnded(err)) throw err;
      });
    } else {
      const prior = turns.get(sessionId) ?? Promise.resolve();
      const run = () => runTurn(event, ctx, pulse);
      turn = prior.then(run, run);
    }
    turns.set(sessionId, turn);
    try {
      await turn;
    } finally {
      if (turns.get(sessionId) === turn) turns.delete(sessionId);
    }
  };
}

function buildPrompt(event: AgentSessionEvent): string {
  // Use Pulse's pre-formatted prompt context if available
  if (event.action === "created" && event.data.prompt_context) {
    return event.data.prompt_context;
  }

  const parts: string[] = [];
  const { agent_session: agentSession } = event.data;

  if (agentSession.issue) {
    const issue = agentSession.issue;
    parts.push(`Issue: ${issue.identifier} - ${issue.title}`);
  }

  if (event.action === "created" && event.data.previous_comments.length) {
    parts.push(
      "Previous comments:\n" +
        event.data.previous_comments.map((c) => `- ${c.body}`).join("\n")
    );
  }

  if (event.action === "prompted" && event.data.agent_activity.content.body) {
    parts.push(`User message: ${event.data.agent_activity.content.body}`);
  } else if (agentSession.comment?.body) {
    parts.push(`User message: ${agentSession.comment.body}`);
  }

  return parts.join("\n\n") || "Hello! How can I help?";
}
