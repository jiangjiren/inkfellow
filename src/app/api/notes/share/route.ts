import { NextRequest, NextResponse } from "next/server";
import { mapVaultError, VaultAccessError } from "@/lib/notesVault";
import {
  createSharedNote,
  findActiveSharedNoteByPath,
  mapSharedNoteError,
  revokeSharedNote,
} from "@/lib/sharedNotes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const getPublicSiteUrl = () =>
  (process.env.SITE_URL?.trim() || "http://localhost:3000").replace(/\/+$/, "");

const makeShareUrl = (token: string) => `${getPublicSiteUrl()}/share/${token}`;

export async function GET(request: NextRequest) {
  const notePath = request.nextUrl.searchParams.get("path");

  if (!notePath) {
    return NextResponse.json({ error: "Missing note path." }, { status: 400 });
  }

  try {
    const activeShare = await findActiveSharedNoteByPath(notePath);

    return NextResponse.json(
      {
        token: activeShare.token,
        url: activeShare.token ? makeShareUrl(activeShare.token) : null,
      },
      {
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  } catch (error) {
    const mappedError = error instanceof VaultAccessError ? mapVaultError(error) : mapSharedNoteError(error);
    return NextResponse.json({ error: mappedError.message }, { status: mappedError.status });
  }
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    path?: unknown;
    title?: unknown;
    expiresAt?: unknown;
  } | null;

  if (!body || typeof body.path !== "string" || !body.path.trim()) {
    return NextResponse.json({ error: "Missing note path." }, { status: 400 });
  }

  try {
    const activeShare = await findActiveSharedNoteByPath(body.path);
    const token = activeShare.token
      ? activeShare.token
      : (
          await createSharedNote({
            notePath: body.path,
            title: typeof body.title === "string" ? body.title : null,
            expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : null,
          })
        ).token;

    return NextResponse.json(
      {
        token,
        url: makeShareUrl(token),
      },
      {
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  } catch (error) {
    const mappedError = error instanceof VaultAccessError ? mapVaultError(error) : mapSharedNoteError(error);
    return NextResponse.json({ error: mappedError.message }, { status: mappedError.status });
  }
}

export async function DELETE(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    token?: unknown;
  } | null;

  if (!body || typeof body.token !== "string" || !body.token.trim()) {
    return NextResponse.json({ error: "Missing share token." }, { status: 400 });
  }

  try {
    await revokeSharedNote(body.token);
    return NextResponse.json(
      {
        ok: true,
      },
      {
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  } catch (error) {
    const mappedError = error instanceof VaultAccessError ? mapVaultError(error) : mapSharedNoteError(error);
    return NextResponse.json({ error: mappedError.message }, { status: mappedError.status });
  }
}
