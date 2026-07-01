import { NextResponse } from "next/server";
import { getMentionIndex, mapVaultError } from "@/lib/notesVault";
import type { MentionsResponse } from "@/lib/notesTypes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const payload: MentionsResponse = { entries: await getMentionIndex() };
    return NextResponse.json(payload, {
      headers: {
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    const { message, status } = mapVaultError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
