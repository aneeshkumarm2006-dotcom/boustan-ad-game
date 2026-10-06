"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useActionState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import type { ActionState } from "./state";

type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;

/** A form that runs a server action and shows its answer underneath, without leaving the page. */
export function ActionForm({
  action,
  children,
  className = "adm-form",
}: {
  action: Action;
  children: ReactNode;
  className?: string;
}) {
  const [state, run] = useActionState<ActionState, FormData>(action, null);
  return (
    <form action={run} className={className}>
      {children}
      <Feedback state={state} />
    </form>
  );
}

export function Feedback({ state }: { state: ActionState }) {
  if (!state) return null;
  return (
    <div className={`adm-msg ${state.ok ? "ok" : "err"}`} role={state.ok ? "status" : "alert"}>
      <strong>{state.message}</strong>
      {state.details && (
        <dl className="adm-dl" style={{ marginTop: 8 }}>
          {state.details.map(([label, value]) => (
            <div key={label} style={{ display: "contents" }}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {state.items && state.items.length > 0 && (
        <ul>
          {state.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Submit({
  children,
  pending: label,
  className = "adm-btn",
}: {
  children: ReactNode;
  pending?: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending ? (label ?? "Working…") : children}
    </button>
  );
}

const NAV = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/codes", label: "Code pools" },
  { href: "/admin/players", label: "Players" },
  { href: "/admin/moderation", label: "Moderation" },
  { href: "/admin/campaign", label: "Campaign" },
  { href: "/admin/audit", label: "Audit log" },
];

export function AdminNav() {
  const path = usePathname();
  return (
    <nav className="adm-nav" aria-label="Admin">
      {NAV.map((item) => {
        const current = item.href === "/admin" ? path === "/admin" : path.startsWith(item.href);
        return (
          <Link key={item.href} href={item.href} aria-current={current ? "page" : undefined}>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
