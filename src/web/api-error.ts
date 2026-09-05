type ApiErrorPayload = {
  error?: string | { message?: unknown };
  message?: unknown;
};

export function apiErrorMessage(text: string, fallback: string): string {
  if (!text) return fallback;
  try {
    const payload = JSON.parse(text) as ApiErrorPayload;
    if (typeof payload.error === "string") return payload.error;
    if (payload.error && typeof payload.error.message === "string") return payload.error.message;
    if (typeof payload.message === "string") return payload.message;
  } catch {}
  return text;
}
