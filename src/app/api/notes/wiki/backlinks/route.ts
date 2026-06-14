import { NextResponse } from "next/server";
import { scanWikiBacklinks, mapVaultError } from "@/lib/notesVault";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const notePath = searchParams.get("path");
    if (!notePath) {
      return NextResponse.json({ error: "Missing path parameter" }, { status: 400 });
    }

    const backlinks = await scanWikiBacklinks(notePath);
    return NextResponse.json({ backlinks });
  } catch (error) {
    const { message, status } = mapVaultError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
