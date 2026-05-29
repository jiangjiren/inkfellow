import { NextResponse } from "next/server";
import { computeTreeRev, getNotesTree, mapVaultError } from "@/lib/notesVault";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const root = await getNotesTree();
    return NextResponse.json(
      {
        root,
        rev: computeTreeRev(root),
        generatedAt: new Date().toISOString(),
      },
      {
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  } catch (error) {
    const mappedError = mapVaultError(error);
    return NextResponse.json({ error: mappedError.message }, { status: mappedError.status });
  }
}
