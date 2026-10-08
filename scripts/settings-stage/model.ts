/** Disposable simulation: never imports a daemon, installer, or credential provider. */
export function createSimulation(existing = false) {
  const expiresAt = Date.now() + 30 * 86400000;
  const machines = [
    { id: "mac", name: "Mac", connected: true, qualifyPaths: false },
    { id: "phoenix", name: "phoenix-bot", connected: true, qualifyPaths: true },
    { id: "laptop", name: "Travel laptop", connected: false, qualifyPaths: false },
  ];
  const clients: Array<{ id: string; name: string; kind: string; machineId: string | null; revokedAt: number | null; expiresAt: number }> = [...machines.slice(1).flatMap(machine => [
    { id: machine.id + "-files", name: machine.name + " files", kind: "connector", machineId: machine.id, revokedAt: null, expiresAt },
    { id: machine.id + "-paseo", name: machine.name + " Paseo", kind: "agent", machineId: machine.id, revokedAt: null, expiresAt },
  ]),
    { id: "safari", name: "Safari on iPhone", kind: "browser", machineId: null, revokedAt: null, expiresAt },
    { id: "chrome", name: "Chrome on Mac", kind: "browser", machineId: null, revokedAt: null, expiresAt },
    { id: "unassociated", name: "New Paseo workspace", kind: "agent", machineId: null, revokedAt: null, expiresAt },
  ];
  return {
    phase: existing ? "complete" : "settings",
    configured: existing, enabled: existing, passwordConfigured: existing, localMachineId: "mac",
    machines: existing ? machines : machines.slice(0, 1), clients: existing ? clients : [],
    verificationDocuments: existing ? machines.map(machine => ({ id: machine.id + "-doc", machineId: machine.id, path: `/notes/${machine.id}.md` })) : [],
    attempts: [] as any[],
  };
}
export type Simulation = ReturnType<typeof createSimulation>;

export function simulate(state: Simulation, action: string, body: any): string | undefined {
  const attempt = state.attempts.find(item => item.id === body.id) ?? state.attempts.at(-1);
  switch (action) {
    case "attempt":
      state.attempts = [{ id: "attempt-1", answers: body.answers, phase: "waiting", contact: { name: "Simulated setup agent", code: "DEMO", approved: false } }];
      return state.phase = "agent";
    case "approve-reporting":
      attempt.contact.approved = true;
      attempt.report = "Ready to install. Use Run simulated installation above.";
      return;
    case "install": {
      if (!attempt?.contact?.approved) throw new Error("Approve the setup agent’s progress reports first.");
      const answers = attempt.answers;
      state.configured = state.enabled = true;
      state.machines[0]!.name = answers.hub;
      if (answers.access === "paseo") {
        let machine = state.machines.find(item => item.id === answers.machineId);
        if (!machine) { machine = { id: "connected", name: answers.machine, qualifyPaths: answers.qualifyPaths, connected: true }; state.machines.push(machine); }
        answers.machineId = machine.id;
        machine.connected = true;
        state.clients.push({ id: machine.id + "-paseo", name: machine.name + " Paseo", kind: "agent", machineId: machine.id, revokedAt: null, expiresAt: Date.now() + 30 * 86400000 });
      }
      state.verificationDocuments = state.machines.map(machine => ({ id: machine.id + "-doc", machineId: machine.id, path: `/notes/${machine.id}.md` }));
      attempt.report = "Simulated hub, HTTPS, file connector and Paseo plugin are ready. Sign in to verify.";
      return state.phase = "sign-in";
    }
    case "sign-in":
      if (!state.configured) throw new Error("Run the simulated installation first.");
      return state.phase = attempt && attempt.phase !== "verified" ? "verify" : "settings";
    case "verify-attempt":
      if (!state.configured || state.phase !== "verify") throw new Error("Complete simulated sign-in first.");
      if (!body.documentId || attempt.answers.access === "paseo" && (!body.machineId || !body.clientId || !body.nativeConfirmed)) throw new Error("Choose a file machine, document and Paseo client, then confirm the simulated native checks.");
      if (attempt.answers.internet && !body.internetConfirmed) throw new Error("Confirm the simulated public browser check.");
      attempt.phase = "verified"; attempt.verification = true;
      return state.phase = "complete";
    case "password": state.passwordConfigured = true; return; // Never retain even simulated passwords.
    case "machine": Object.assign(state.machines.find(item => item.id === body.id)!, { name: body.name, qualifyPaths: body.qualifyPaths }); return;
    case "associate": state.clients.find(item => item.id === body.clientId)!.machineId = body.machineId; return;
    case "revoke":
    case "revoke-machine":
      for (const client of state.clients) if (action === "revoke" ? client.id === body.clientId : client.machineId === body.machineId) client.revokedAt = Date.now();
      if (action === "revoke-machine") state.machines.find(item => item.id === body.machineId)!.connected = false;
      return;
    case "enabled": state.enabled = body.enabled; return;
    default: throw new Error("Unsupported staging action: " + action);
  }
}
