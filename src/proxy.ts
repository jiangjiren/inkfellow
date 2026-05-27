import { NextRequest, NextResponse } from "next/server";

const NOTES_AUTH_REALM = process.env.NEXT_PUBLIC_APP_NAME?.trim() || "inkfellow";

const isNotesApiPath = (pathname: string) => pathname.startsWith("/api/notes/");

const isProtectedPath = (pathname: string) =>
  pathname === "/" || isNotesApiPath(pathname);

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

  if (isProtectedPath(pathname) && !isValidNotesAuth(request)) {
    return createNotesAuthResponse(isNotesApiPath(pathname));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/api/notes/:path*"],
};
