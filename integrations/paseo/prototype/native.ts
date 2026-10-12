/// <reference lib="dom" />
/** Unsupported Paseo 0.11.2 boundary. No hook index or component-name assumptions. */
export type NativeClient = {
  sendAgentMessage(agent: string, text: string, options: { messageId: string; [key: string]: unknown }): Promise<void>;
  fetchAgentTimeline(agent: string, options: Record<string, unknown>): Promise<{ entries: { item: { type: string; clientMessageId?: string; messageId?: string } }[]; hasOlder: boolean; startCursor: unknown }>;
};
export type Composer = {
  voiceServerId: string; voiceAgentId: string; client: NativeClient;
  attachments: unknown[]; onSubmit: (payload: unknown) => void;
  onQueue?: (payload: unknown) => void;
  defaultSendBehavior: string; isAgentRunning: boolean;
  disabled?: boolean; readOnly?: boolean; isSubmitDisabled?: boolean;
};
type QueueItem = { id: string; text: string; attachments: unknown[] };
export type QueueWriter = { read(agent: string): QueueItem[]; write(update: (before: Map<string, QueueItem[]>) => Map<string, QueueItem[]>): void };
type Hook = { memoizedState: unknown; next?: Hook };
type Fiber = { memoizedProps?: Partial<Composer>; memoizedState?: Hook; return?: Fiber };

export function isNativeSendButton(element: HTMLElement): boolean {
  const key = Object.keys(element).find(key => key.startsWith("__reactFiber$"));
  let fiber: { memoizedProps?: Record<string, unknown>; return?: unknown } | undefined = key ? Reflect.get(element, key) : undefined;
  for (let depth = 0; fiber && depth < 30; depth++, fiber = fiber.return as typeof fiber) {
    const props = fiber.memoizedProps;
    if (typeof props?.onDefaultSendAction === "function" && typeof props.submitAccessibilityLabel === "string" && props.shouldShow === true) return true;
  }
  return false;
}

export function queueWriter(input: HTMLTextAreaElement): QueueWriter | null {
  const key = Object.keys(input).find(key => key.startsWith("__reactFiber$"));
  let fiber: Fiber | undefined = key ? Reflect.get(input, key) : undefined;
  for (let depth = 0; fiber && depth < 120; depth++, fiber = fiber.return) {
    let hook = fiber.memoizedState;
    for (let count = 0; hook && count < 400; count++, hook = hook.next) {
      const value = Array.isArray(hook.memoizedState) ? hook.memoizedState[0] : null;
      if (value && typeof value.read === "function" && typeof value.write === "function") return value as QueueWriter;
    }
  }
  return null;
}

export function composer(input: HTMLTextAreaElement): Composer | null {
  const key = Object.keys(input).find(key => key.startsWith("__reactFiber$"));
  let fiber: Fiber | undefined = key ? Reflect.get(input, key) : undefined;
  for (let depth = 0; fiber && depth < 120; depth++, fiber = fiber.return) {
    const p = fiber.memoizedProps;
    if (typeof p?.voiceServerId === "string" && typeof p.voiceAgentId === "string" && typeof p.onSubmit === "function" && Array.isArray(p.attachments) && typeof p.client?.sendAgentMessage === "function" && typeof p.client.fetchAgentTimeline === "function") return p as Composer;
  }
  return null;
}

// Composer editing pattern adapted from Annotations/Quote; see NOTICE.md.
export function replaceText(input: HTMLTextAreaElement, value: string): void {
  input.focus({ preventScroll: true });
  input.setSelectionRange(0, input.value.length);
  if (!document.execCommand("insertText", false, value) || input.value !== value) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (input.value !== value) throw new Error("Native composer rejected the prepared text.");
}

export const inputSelector = "textarea[data-composer-input]";
export function inputs(): HTMLTextAreaElement[] { return Array.from(document.querySelectorAll<HTMLTextAreaElement>(inputSelector)); }
export function scope(c: Composer): string { return JSON.stringify([c.voiceServerId, c.voiceAgentId]); }
