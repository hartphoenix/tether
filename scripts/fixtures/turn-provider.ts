/** Deterministic Paseo protocol peer for isolated transport checks; never invokes a model. */
export default function contribute(server: any) {
  server.registerProvider({
    id: "tether-go-fixture", label: "Tether transport fixture",
    async connect() {
      let listener: (event: any) => void = () => {};
      const emit = (event: any) => listener(event);
      return {
        version: 1, capabilities: ["prompt.message", "session.persistence"],
        onEvent(fn: typeof listener) { listener = fn; return () => { listener = () => {}; }; },
        async close() {},
        async send(input: any) {
          if (input.type === "catalog") emit({ type: "catalog", requestId: input.requestId, catalog: {
            models: [{ id: "fixture", label: "Fixture" }], modes: [], thinkingOptions: [], defaultModel: "fixture",
          } });
          else if (input.type === "session.open") {
            emit({ type: "session.opened", requestId: input.requestId, sessionId: input.sessionId, capabilities: ["prompt.message", "session.persistence"],
              restoration: "core", persistence: { version: 1, data: {} }, cwd: input.config.cwd });
            emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
          } else if (input.type === "session.prompt") {
            // Repeated turn IDs deliberately exercise Tether's signal-based correlation.
            const turnId = "repeated";
            emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: "turn", turnId } });
            emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "started" });
            emit({ type: "timeline.item", sessionId: input.sessionId, item: { type: "assistant_message", id: crypto.randomUUID(), text: "Fixture completed." } });
            emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "completed" });
          } else if (input.type === "session.close") emit({ type: "session.closed", sessionId: input.sessionId });
          else if (input.requestId) emit({ type: "request.completed", requestId: input.requestId });
        },
      };
    },
  });
  return () => {};
}
