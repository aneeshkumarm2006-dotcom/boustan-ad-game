"use client";

import { createContext, useContext } from "react";
import type { Lang, Translator } from "@/i18n";
import type { HostEvent } from "@/lib/embed/bridge";

export interface Ui {
  t: Translator;
  lang: Lang;
  setLang: (lang: Lang) => void;
  muted: boolean;
  toggleMuted: () => void;
  /** Placement ID from ?src, for UTM-tagged outbound links. */
  src: string | null;
  emit: (event: HostEvent) => void;
  toast: (message: string) => void;
}

export const UiContext = createContext<Ui | null>(null);

export function useUi(): Ui {
  const ui = useContext(UiContext);
  if (!ui) throw new Error("useUi outside UiContext");
  return ui;
}
