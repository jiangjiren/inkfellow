import { NextResponse } from "next/server";
import { getMentionIndex, mapVaultError } from "@/lib/notesVault";
import type { MentionsResponse } from "@/lib/notesTypes";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const payload: MentionsResponse = { entries: await getMentionIndex() };
    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const { message, status } = mapVaultError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
