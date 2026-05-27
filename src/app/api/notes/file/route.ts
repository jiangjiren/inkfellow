import { NextRequest, NextResponse } from "next/server";
import { mapVaultError, readMarkdownNote, statMarkdownNote } from "@/lib/notesVault";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const notePath = request.nextUrl.searchParams.get("path");

  if (!notePath) {
    return NextResponse.json({ error: "Missing note path." }, { status: 400 });
  }

  // ?meta=true — 只返回修改时间，不加载内容，供轮询用
  const metaOnly = request.nextUrl.searchParams.get("meta") === "true";

  try {
    if (metaOnly) {
      const meta = await statMarkdownNote(notePath);
      return NextResponse.json(meta, { headers: { "cache-control": "no-store" } });
    }

    const note = await readMarkdownNote(notePath);
    return NextResponse.json(note, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    const mappedError = mapVaultError(error);
    return NextResponse.json({ error: mappedError.message }, { status: mappedError.status });
  }
}
