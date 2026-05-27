import { NextRequest, NextResponse } from "next/server";
import { localeCookie } from "@/i18n/config";
import { getLocaleFromAcceptLanguage, normalizeLocale } from "@/i18n/locale";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
const NOTES_AUTH_REALM = process.env.NEXT_PUBLIC_APP_NAME?.trim() || "My Notes";

const isNotesPath = (pathname: string) => pathname === "/notes" || pathname.startsWith("/notes/");
const isNotesApiPath = (pathname: string) => pathname.startsWith("/api/notes/");
const isProtectedNotesPath = (pathname: string) => isNotesPath(pathname) || isNotesApiPath(pathname);

const getNotesAuthConfig = () => ({
  username:
    process.env.NOTES_BASIC_AUTH_USERNAME?.trim() ||
    process.env.NOTES_BASIC_AUTH_USER?.trim() ||
    "notes",
  password:
    process.env.NOTES_BASIC_AUTH_PASSWORD?.trim() ||
    process.env.NOTES_PASSWORD?.trim() ||
    "",
});

const parseBasicAuth = (authorization: string | null) => {
  if (!authorization?.startsWith("Basic ")) {
    return null;
  }

  try {
    const decoded = atob(authorization.slice("Basic ".length));
    const separatorIndex = decoded.indexOf(":");
    if (separatorIndex < 0) {
      return null;
    }

    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1),
    };
  } catch {
    return null;
  }
};

const isValidNotesAuth = (request: NextRequest) => {
  const expected = getNotesAuthConfig();
  if (!expected.password) {
    return false;
  }

  const supplied = parseBasicAuth(request.headers.get("authorization"));
  return supplied?.username === expected.username && supplied.password === expected.password;
};

const createNotesAuthResponse = (isApiRequest: boolean) =>
  new NextResponse(
    isApiRequest ? JSON.stringify({ error: "Authentication required." }) : "Authentication required.",
    {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "content-type": isApiRequest ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
        "www-authenticate": `Basic realm="${NOTES_AUTH_REALM}", charset="UTF-8"`,
      },
    },
  );

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isProtectedNotesPath(pathname) && !isValidNotesAuth(request)) {
    return createNotesAuthResponse(isNotesApiPath(pathname));
  }

  const segments = pathname.split("/");
  const maybeLocale = segments[1];
  const pathLocale = normalizeLocale(maybeLocale);

  if (pathLocale) {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-locale", pathLocale);
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.cookies.set(localeCookie, pathLocale, {
      path: "/",
      maxAge: ONE_YEAR_SECONDS,
    });
    return response;
  }

  if (pathname === "/") {
    const cookieLocale = normalizeLocale(request.cookies.get(localeCookie)?.value);
    const locale = cookieLocale
      ? cookieLocale
      : getLocaleFromAcceptLanguage(request.headers.get("accept-language"));
    const url = request.nextUrl.clone();
    url.pathname = `/${locale}`;
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/notes/:path*", "/api/notes/:path*", "/((?!_next|api|.*\\..*).*)"],
};
