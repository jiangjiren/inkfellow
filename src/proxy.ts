import { NextRequest, NextResponse } from "next/server";

const NOTES_AUTH_REALM = process.env.NEXT_PUBLIC_APP_NAME?.trim() || "inkfellow";
const AUTH_COOKIE = "notes_auth";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

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

// HMAC-SHA256 token tied to credentials — auto-invalidates when password changes
const computeAuthToken = async (username: string, password: string): Promise<string> => {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(username));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
};

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

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!isProtectedPath(pathname)) {
    return NextResponse.next();
  }

  const { username, password } = getNotesAuthConfig();
  if (!password) {
    return createNotesAuthResponse(isNotesApiPath(pathname));
  }

  const expectedToken = await computeAuthToken(username, password);

  // 1. Cookie session — survives mobile page refresh without re-prompting
  const cookieToken = request.cookies.get(AUTH_COOKIE)?.value;
  if (cookieToken === expectedToken) {
    return NextResponse.next();
  }

  // 2. Basic Auth header — set cookie on success so future requests skip the dialog
  const supplied = parseBasicAuth(request.headers.get("authorization"));
  if (supplied?.username === username && supplied.password === password) {
    const response = NextResponse.next();
    response.cookies.set(AUTH_COOKIE, expectedToken, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      maxAge: COOKIE_MAX_AGE,
      path: "/",
    });
    return response;
  }

  return createNotesAuthResponse(isNotesApiPath(pathname));
}

export const config = {
  matcher: ["/", "/api/notes/:path*"],
};
