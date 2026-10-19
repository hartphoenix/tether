// Tests sign agents explicitly; the host agent IDs of the session running them must not leak in.
delete process.env.PASEO_AGENT_ID;
delete process.env.CLAUDE_CODE_SESSION_ID;
