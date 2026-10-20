export type TurnBehavior = "steer" | "interrupt" | "queue";
export type HostSubscription = {
  documentId: string; path: string; machineId: string; agentId: string; hostId: string;
  owner: string; availability?: string; label?: string; behavior: TurnBehavior; signalId?: string;
  /** Host session receiving this role's invitations; absent in legacy registrations. */
  recipientId?: string;
};
export type HostSignal = HostSubscription & {
  signalId: string; operationId: string; requestedAt: string; text: string;
  state: "pending" | "dispatching" | "accepted" | "completed" | "failed" | "uncertain";
  acceptedAt?: string; reason?: string; position?: unknown;
};
