// Clerk dialogue is data, not hand-built conversations — new clerks/menus can be
// added by extending these nodes. Each option either prints a service paper,
// jumps to another node, or ends the conversation.

export type ServiceId = "id" | "notices" | "tray" | "forms" | "letter";

export type DialogueAction =
  | { type: "service"; service: ServiceId }
  | { type: "goto"; node: string }
  | { type: "leave" };

export interface DialogueOption {
  label: string;
  action: DialogueAction;
}

export interface DialogueNode {
  id: string;
  speaker: string;
  text: string;
  options: DialogueOption[];
}

export const CIVILIAN_CLERK: Record<string, DialogueNode> = {
  root: {
    id: "root",
    speaker: "General Secretary",
    text: "Good day. Which matter brings you to the bureau?",
    options: [
      { label: "Request a document", action: { type: "service", service: "forms" } },
      { label: "Read the public notices", action: { type: "service", service: "notices" } },
      { label: "Check my incoming tray", action: { type: "service", service: "tray" } },
      { label: "Write to a ministry", action: { type: "service", service: "letter" } },
      { label: "Present my papers", action: { type: "service", service: "id" } },
      { label: "That is all — good day", action: { type: "leave" } },
    ],
  },
};
