"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { audit } from "@/lib/server/admin/audit";
import {
  ADMIN_NAME,
  SESSION_COOKIE,
  sessionCookieOptions,
  signInWithPassword,
} from "@/lib/server/admin/auth";
import { db } from "@/lib/server/db";
import { clientIp } from "@/lib/server/http";

export type LoginState = null | { status: "wrong" | "rate_limited" | "not_configured" };

export async function signIn(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const password = String(formData.get("password") ?? "");
  const result = await signInWithPassword(password, clientIp(await headers()));
  if (!result.ok) return { status: result.reason };
  (await cookies()).set(SESSION_COOKIE, result.session, sessionCookieOptions());
  await audit(db(), ADMIN_NAME, "admin.login");
  redirect("/admin");
}
