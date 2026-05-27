import { NextRequest, NextResponse } from "next/server";
import { mapVaultError, readVaultImage } from "@/lib/notesVault";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const assetPath = request.nextUrl.searchParams.get("path");
  const fromPath = request.nextUrl.searchParams.get("from");

  if (!assetPath) {
    return NextResponse.json({ error: "Missing asset path." }, { status: 400 });
  }

  try {
    const image = await readVaultImage(assetPath, fromPath);
    return new NextResponse(image.body, {
      headers: {
        "cache-control": "private, max-age=300",
        "content-length": String(image.size),
        "content-type": image.contentType,
        "last-modified": image.updatedAt,
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    const mappedError = mapVaultError(error);
    return NextResponse.json({ error: mappedError.message }, { status: mappedError.status });
  }
}
