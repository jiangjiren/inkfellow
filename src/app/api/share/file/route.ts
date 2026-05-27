import { NextRequest, NextResponse } from "next/server";
import { mapSharedNoteError, readSharedNote } from "@/lib/sharedNotes";
import { mapVaultError, VaultAccessError } from "@/lib/notesVault";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");

  if (!token) {
    return NextResponse.json({ error: "Missing share token." }, { status: 400 });
  }

  try {
    const { note, share } = await readSharedNote(token);
    return NextResponse.json(
      {
        name: share.title?.trim() || note.name,
        content: note.content,
        size: note.size,
        updatedAt: note.updatedAt,
      },
      {
        headers: {
          "cache-control": "no-store",
          "x-robots-tag": share.noindex === false ? "noarchive" : "noindex, nofollow, noarchive",
        },
      },
    );
  } catch (error) {
    const mappedError = error instanceof VaultAccessError ? mapVaultError(error) : mapSharedNoteError(error);
    return NextResponse.json({ error: mappedError.message }, { status: mappedError.status });
  }
}
