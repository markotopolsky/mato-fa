/**
 * Single-password site gate.
 *
 * The password lives in `SITE_PASSWORD`. After a successful login the browser
 * holds an httpOnly cookie whose value is an HMAC derived from that password,
 * so the password itself is never stored client-side and changing it logs
 * every existing session out.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const AUTH_COOKIE = "mato-fa-session";

/** Session lifetime: 30 days. */
export const AUTH_MAX_AGE_S = 60 * 60 * 24 * 30;

export function sitePassword(): string | null {
  return process.env.SITE_PASSWORD || null;
}

export function sessionToken(password: string): string {
  return createHmac("sha256", password).update("mato-fa-session-v1").digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** True when `candidate` matches `SITE_PASSWORD`. False if it is not configured. */
export function checkPassword(candidate: string): boolean {
  const password = sitePassword();
  if (!password) return false;
  // Compare fixed-length digests so the check does not leak the password length.
  return safeEqual(sessionToken(candidate), sessionToken(password));
}

/** True when the cookie value is a valid session for the current password. */
export function isValidSession(cookieValue: string | undefined): boolean {
  const password = sitePassword();
  if (!password || !cookieValue) return false;
  return safeEqual(cookieValue, sessionToken(password));
}
