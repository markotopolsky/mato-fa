"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AUTH_COOKIE, AUTH_MAX_AGE_S, checkPassword, sessionToken } from "@/app/lib/auth";

export async function login(formData: FormData): Promise<void> {
  const password = formData.get("password");
  if (typeof password !== "string" || !checkPassword(password)) {
    redirect("/login?error=1");
  }

  (await cookies()).set(AUTH_COOKIE, sessionToken(password), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: AUTH_MAX_AGE_S,
  });
  redirect("/");
}
