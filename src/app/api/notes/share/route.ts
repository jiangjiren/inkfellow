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

const shareResponse = (
  request: NextRequest,
  active: Awaited<ReturnType<typeof findActiveSharedNoteByPath>>,
) => {
  const origin = (process.env.SITE_URL?.trim() || request.nextUrl.origin).replace(/\/+$/, "");
  return NextResponse.json({
    token: active?.token ?? null,
    url: active ? `${origin}/share/${active.token}` : null,
    title: active?.share.title ?? null,
    expiresAt: active?.share.expiresAt ?? null,
  }, { headers: { "cache-control": "no-store" } });
};

export async function GET(request: NextRequest) {
  const notePath = request.nextUrl.searchParams.get("path");

  if (!notePath) {
    return NextResponse.json({ error: "Missing note path." }, { status: 400 });
  }

  try {
    return shareResponse(request, await findActiveSharedNoteByPath(notePath));
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
  const { path: notePath, title, expiresAt } = body;
  if ((title != null && typeof title !== "string") || (expiresAt != null && typeof expiresAt !== "string")) {
    return NextResponse.json({ error: "分享标题和有效期格式不正确。" }, { status: 400 });
  }

  try {
    return shareResponse(request, await createSharedNote({ notePath, title, expiresAt }));
  } catch (error) {
    const mappedError = error instanceof VaultAccessError ? mapVaultError(error) : mapSharedNoteError(error);
    return NextResponse.json({ error: mappedError.message }, { status: mappedError.status });
  }
}

export async function DELETE(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    token?: unknown;
    path?: unknown;
  } | null;

  if (!body || typeof body.token !== "string" || !body.token.trim()) {
    return NextResponse.json({ error: "Missing share token." }, { status: 400 });
  }

  try {
    await revokeSharedNote(body.token, typeof body.path === "string" ? body.path : undefined);
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
