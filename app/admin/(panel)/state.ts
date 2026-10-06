/** What an admin form action tells the page: shown under the form by ActionForm. */
export type ActionState = null | {
  ok: boolean;
  message: string;
  /** Short facts, shown as a list of label and value. */
  details?: [string, string | number][];
  /** Longer notes such as rows that were skipped. */
  items?: string[];
};

export const done = (
  message: string,
  extra: Omit<NonNullable<ActionState>, "ok" | "message"> = {},
) => ({ ok: true, message, ...extra }) satisfies ActionState;

export const failed = (
  message: string,
  extra: Omit<NonNullable<ActionState>, "ok" | "message"> = {},
) => ({ ok: false, message, ...extra }) satisfies ActionState;
