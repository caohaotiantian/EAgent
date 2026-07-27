/**
 * Chat session id + Clear / generation guard (KDD11).
 */

export function newSessionId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export type ClearPlan = {
  previousId: string;
  currentId: string;
  generation: number;
};

/** Mint first, then abort old reader against the new id/generation. */
export function planClear(currentId: string, generation: number): ClearPlan {
  return {
    previousId: currentId,
    currentId: newSessionId(),
    generation: generation + 1,
  };
}

/**
 * Switch the chat binding to an existing server (or other) session id so the
 * next POST /run continues that conversation. Bumps generation to drop in-flight
 * frames from the previous binding. No-op identity change still bumps generation
 * when `force` is true (caller usually skips if id unchanged).
 */
export function planSwitchSession(
  currentId: string,
  targetId: string,
  generation: number,
): ClearPlan {
  return {
    previousId: currentId,
    currentId: targetId,
    generation: generation + 1,
  };
}

export function shouldAcceptFrame(
  boundSession: string,
  boundGeneration: number,
  currentId: string,
  currentGeneration: number,
): boolean {
  return boundSession === currentId && boundGeneration === currentGeneration;
}
