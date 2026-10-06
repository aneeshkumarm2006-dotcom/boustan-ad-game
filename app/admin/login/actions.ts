"use server";

import { headers } from "next/headers";
import { requestLoginLink } from "@/lib/server/admin/auth";
import { clientIp } from "@/lib/server/http";

export type LoginState =
  | null
  | { status: "invalid" }
  | { status: "limited" }
  /** The same answer for listed and unlisted addresses. */
  | { status: "sent"; devLink?: string };

export async function requestLink(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return { status: "invalid" };
  const result = await requestLoginLink(email, clientIp(await headers()));
  if (!result.ok) return { status: "limited" };
  return { status: "sent", devLink: result.devLink };
}
