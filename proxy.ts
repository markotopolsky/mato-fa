import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, isValidSession, sitePassword } from "@/app/lib/auth";

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Fail closed: without a configured password nobody gets in.
  if (!sitePassword()) {
    return new NextResponse("SITE_PASSWORD is not configured.", { status: 500 });
  }

  if (pathname === "/login") return NextResponse.next();

  if (isValidSession(request.cookies.get(AUTH_COOKIE)?.value)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { ev: "error", kind: "unauthorized", message: "Not logged in." },
      { status: 401 },
    );
  }

  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  // Everything except build assets and the app icon.
  matcher: ["/((?!_next/static|_next/image|icon.svg).*)"],
};
