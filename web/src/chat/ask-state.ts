/**
 * Pending elicitation UI state machine (KDD4 dismiss rules).
 */

export type AskPending = {
  id: number;
  question: string;
  options: string[] | null;
};

export type AskState = { kind: "idle" } | { kind: "pending"; ask: AskPending };

export type AskAction =
  | { type: "show"; ask: AskPending }
  | { type: "resolved" }
  | { type: "gone" }
  | { type: "retry_error" }
  | { type: "stream_frame" }
  | { type: "stream_end" }
  | { type: "clear" }
  | { type: "stop" };

export function reduceAsk(state: AskState, action: AskAction): AskState {
  switch (action.type) {
    case "show":
      return { kind: "pending", ask: action.ask };
    case "resolved":
    case "gone":
    case "stream_frame":
    case "stream_end":
    case "clear":
    case "stop":
      return { kind: "idle" };
    case "retry_error":
      return state; // keep pending
    default:
      return state;
  }
}
