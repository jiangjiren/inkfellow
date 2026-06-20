import { NextResponse } from "next/server";
import { getWikiIndex, mapVaultError } from "@/lib/notesVault";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({ entries: await getWikiIndex() });
  } catch (error) {
    const { message, status } = mapVaultError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
