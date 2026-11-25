import { expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { AgentSessionCreatedEvent, AgentSessionPromptedEvent, PulseAgentClient } from "@try-pulse/agent-sdk";
import { createAgentSessionHandler } from "../src/agent";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function event(action: "created" | "prompted" = "created") {
  return {
    type: "AgentSessionEvent", action, installation_id: "inst1", workspace_id: "ws1",
    data: {
      agent_session: { id: "session1", issue: { identifier: "PUL-1", title: "Example" } },
      prompt_context: "Read PUL-1", previous_comments: [],
      agent_activity: { content: { body: "Continue" } },
    },
  } as unknown as AgentSessionCreatedEvent & AgentSessionPromptedEvent;
}

function pulseRecorder() {
  const calls: Array<{ kind: string; body: string }> = [];
  const pulse = {
    thought: async (_id: string, body: string) => { calls.push({ kind: "thought", body }); },
    action: async (_id: string, input: { action: string }) => { calls.push({ kind: "action", body: input.action }); },
    respond: async (_id: string, body: string) => { calls.push({ kind: "response", body }); },
    error: async (_id: string, body: string) => { calls.push({ kind: "error", body }); },
  } as unknown as PulseAgentClient;
  return { pulse, calls };
}

test("relays Claude text and tool use, then posts one final response", async () => {
  const { pulse, calls } = pulseRecorder();
  const sent: unknown[] = [];
  const anthropic = {
    beta: { sessions: {
      create: async () => ({ id: "claude1" }),
      events: {
        stream: async () => (async function* () {
          yield { type: "agent.tool_use", name: "Search" };
          yield { type: "agent.message", content: [{ type: "text", text: "Done." }] };
        })(),
        send: async (_id: string, body: unknown) => { sent.push(body); },
      },
    } },
  } as unknown as Anthropic;
  const handle = createAgentSessionHandler({
    anthropic, pulseForEvent: () => pulse, agentId: "agent1", environmentId: "env1",
  });
  await handle(event(), { signal: new AbortController().signal });
  expect(calls.map((call) => call.kind)).toEqual(["thought", "action", "response"]);
  expect(calls.at(-1)?.body).toBe("Done.");
  expect(JSON.stringify(sent[0])).toContain("Read PUL-1");
});

test("Stop interrupts the active Claude run and posts exactly one final response", async () => {
  const { pulse, calls } = pulseRecorder();
  const started = deferred();
  const release = deferred();
  const sent: unknown[] = [];
  const anthropic = {
    beta: { sessions: {
      create: async () => ({ id: "claude1" }),
      events: {
        stream: async () => (async function* () {
          started.resolve();
          await release.promise;
          yield { type: "agent.message", content: [{ type: "text", text: "Too late" }] };
        })(),
        send: async (_id: string, body: unknown) => { sent.push(body); },
      },
    } },
  } as unknown as Anthropic;
  const handle = createAgentSessionHandler({
    anthropic, pulseForEvent: () => pulse, agentId: "agent1", environmentId: "env1",
  });
  const controller = new AbortController();
  const running = handle(event(), { signal: controller.signal });
  await started.promise;
  controller.abort();
  await handle(event("prompted"), { signal: controller.signal, isStop: true });
  release.resolve();
  await running;
  expect(sent.some((body) => JSON.stringify(body).includes("user.interrupt"))).toBe(true);
  expect(calls.filter((call) => call.kind === "response")).toEqual([{ kind: "response", body: "Stopped. I made no further changes." }]);
});

for (const stopAt of ["create", "stream"] as const) {
  test(`Stop during ${stopAt} prevents the current and queued prompts from reaching Claude`, async () => {
    const { pulse, calls } = pulseRecorder();
    const started = deferred();
    const release = deferred();
    const sent: string[] = [];
    let created = 0;
    async function hold(stage: typeof stopAt) {
      if (stage === stopAt) {
        started.resolve();
        await release.promise;
      }
    }
    const anthropic = {
      beta: { sessions: {
        create: async () => { created++; await hold("create"); return { id: "claude1" }; },
        events: {
          stream: async () => { await hold("stream"); return []; },
          send: async (_id: string, body: { events: { type: string }[] }) => {
            sent.push(...body.events.map((entry) => entry.type));
          },
        },
      } },
    } as unknown as Anthropic;
    const handle = createAgentSessionHandler({ anthropic, pulseForEvent: () => pulse, agentId: "a", environmentId: "e" });
    const controller = new AbortController();
    const running = handle(event(), controller);
    await started.promise;
    const queued = handle(event("prompted"), controller);
    controller.abort();
    await handle(event("prompted"), { signal: controller.signal, isStop: true });
    release.resolve();
    await Promise.all([running, queued]);
    expect(created).toBe(1);
    expect(sent).toEqual(["user.interrupt"]);
    expect(calls.map((call) => call.kind)).toEqual(["thought", "response"]);
  });
}

test("a reopened turn waits for Stop's final write and bypasses the cancelled turn", async () => {
  const oldStarted = deferred();
  const oldGate = deferred();
  const stopGate = deferred();
  const responses: string[] = [];
  const { pulse } = pulseRecorder();
  const writer = {
    ...pulse,
    respond: async (_id: string, text: string) => {
      if (text.startsWith("Stopped.")) await stopGate.promise;
      responses.push(text);
      return { id: "activity", seq: responses.length };
    },
  } as unknown as PulseAgentClient;
  let created = 0;
  const anthropic = {
    beta: { sessions: {
      create: async () => {
        const id = ++created;
        if (id === 1) { oldStarted.resolve(); await oldGate.promise; }
        return { id: String(id) };
      },
      events: {
        stream: async () => [{ type: "agent.message", content: [{ type: "text", text: "Reopened" }] }],
        send: async () => {},
      },
    } },
  } as unknown as Anthropic;
  const handle = createAgentSessionHandler({ anthropic, pulseForEvent: () => writer, agentId: "a", environmentId: "e" });
  const old = new AbortController();
  const running = handle(event(), old);
  await oldStarted.promise;
  old.abort();
  const stop = handle(event("prompted"), { signal: old.signal, isStop: true });
  const reopened = handle(event("prompted"), new AbortController());
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(created).toBe(1);
  stopGate.resolve();
  await Promise.all([stop, reopened]);
  oldGate.resolve();
  await running;
  expect(responses).toEqual(["Stopped. I made no further changes.", "Reopened"]);
});

test("a follow-up starts after the previous turn completes", async () => {
  const { pulse, calls } = pulseRecorder();
  const running = deferred();
  const release = deferred();
  const sessions: string[] = [];
  const anthropic = {
    beta: { sessions: {
      create: async () => {
        const id = `claude${sessions.length + 1}`;
        sessions.push(id);
        return { id };
      },
      events: {
        stream: async (id: string) => (async function* () {
          if (id === "claude1") {
            running.resolve();
            await release.promise;
          }
          yield { type: "agent.message", content: [{ type: "text", text: id }] };
        })(),
        send: async () => {},
      },
    } },
  } as unknown as Anthropic;
  const handle = createAgentSessionHandler({ anthropic, pulseForEvent: () => pulse, agentId: "a", environmentId: "e" });
  const ctx = new AbortController();
  const first = handle(event(), ctx);
  await running.promise;
  const second = handle(event("prompted"), ctx);
  release.resolve();
  await Promise.all([first, second]);
  expect(calls.filter((call) => call.kind === "response").map((call) => call.body)).toEqual(["claude1", "claude2"]);
  expect(calls.map((call) => call.kind)).toEqual(["thought", "response", "thought", "response"]);
});

test("reports a Claude failure as an agent error", async () => {
  const { pulse, calls } = pulseRecorder();
  const anthropic = {
    beta: { sessions: { create: async () => { throw new Error("offline"); } } },
  } as unknown as Anthropic;
  const handle = createAgentSessionHandler({
    anthropic, pulseForEvent: () => pulse, agentId: "agent1", environmentId: "env1",
  });
  await handle(event(), { signal: new AbortController().signal });
  expect(calls.map((call) => call.kind)).toEqual(["thought", "error"]);
  expect(calls.at(-1)?.body).toContain("offline");
});
