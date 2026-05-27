import { NextRequest, NextResponse } from "next/server";
import { mapVaultError, VaultAccessError } from "@/lib/notesVault";
import { mapSharedNoteError, readSharedNoteAsset } from "@/lib/sharedNotes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  const assetPath = request.nextUrl.searchParams.get("path");

  if (!token) {
    return NextResponse.json({ error: "Missing share token." }, { status: 400 });
  }

  if (!assetPath) {
    return NextResponse.json({ error: "Missing asset path." }, { status: 400 });
  }

  try {
    const image = await readSharedNoteAsset(token, assetPath);
    return new NextResponse(image.body, {
      headers: {
        "cache-control": "public, max-age=300",
        "content-length": String(image.size),
        "content-type": image.contentType,
        "last-modified": image.updatedAt,
        "x-content-type-options": "nosniff",
        "x-robots-tag": "noindex, nofollow, noarchive",
      },
    });
  } catch (error) {
    const mappedError = error instanceof VaultAccessError ? mapVaultError(error) : mapSharedNoteError(error);
    return NextResponse.json({ error: mappedError.message }, { status: mappedError.status });
  }
}
