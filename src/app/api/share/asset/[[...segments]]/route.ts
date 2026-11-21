import { NextRequest, NextResponse } from "next/server";
import { mapVaultError, VaultAccessError } from "@/lib/notesVault";
import { readSharedNoteAsset, sharedHtmlAssetMarker } from "@/lib/sharedNoteAssets";
import { mapSharedNoteError } from "@/lib/sharedNotes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ segments?: string[] }>;
};

const accessHeaders = {
  "access-control-allow-origin": "null",
  "cache-control": "private, no-store, max-age=0",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow, noarchive",
};

const errorResponse = (error: string, status: number) =>
  NextResponse.json({ error }, { status, headers: accessHeaders });

const downloadDisposition = (name: string, defaultName: string) => {
  const filename = (name.replace(/[\\/\u0000-\u001f\u007f]/g, "_").trim() || defaultName).slice(0, 180);
  const encoded = encodeURIComponent(filename.toWellFormed()).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename*=UTF-8''${encoded}`;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const { segments = [] } = await context.params;
  const [pathToken, ...assetSegments] = segments;
  // HTML resolves assets against a directory URL, while Markdown uses query parameters.
  const token = pathToken ?? request.nextUrl.searchParams.get("token");
  const kind = !pathToken ? "markdown" : assetSegments[0] === sharedHtmlAssetMarker ? "html" : "relative";
  const assetPath = kind === "html" ? assetSegments.slice(1).join("/")
    : kind === "relative" ? assetSegments.map(encodeURIComponent).join("/")
    : request.nextUrl.searchParams.get("path");

  if (!token) {
    return errorResponse("Missing share token.", 400);
  }

  if (!assetPath) {
    return errorResponse("Missing asset path.", 400);
  }

  try {
    const asset = await readSharedNoteAsset(token, assetPath, kind);
    const headers = new Headers(accessHeaders);
    headers.set("content-length", String(asset.body.byteLength));
    headers.set("content-type", asset.contentType);
    headers.set("last-modified", asset.updatedAt);
    if (/^(image\/svg\+xml|application\/xml|text\/csv)(?:;|$)/i.test(asset.contentType)) {
      headers.set("content-security-policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'");
    }
    const download = request.nextUrl.searchParams.get("download");
    if (download !== null) headers.set("content-disposition", downloadDisposition(download, asset.fileName));
    return new NextResponse(asset.body, { headers });
  } catch (error) {
    const mappedError = error instanceof VaultAccessError ? mapVaultError(error) : mapSharedNoteError(error);
    return errorResponse(mappedError.message, mappedError.status);
  }
}
