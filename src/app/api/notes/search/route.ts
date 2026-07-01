import { NextResponse } from "next/server";
import { mapVaultError, searchNotes } from "@/lib/notesVault";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams.get("q") ?? "";
    const hits = await searchNotes(query);
    return NextResponse.json(
      { hits },
      {
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  } catch (error) {
    const { message, status } = mapVaultError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
