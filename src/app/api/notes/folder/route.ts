import { NextRequest, NextResponse } from "next/server";
import { mapVaultError, createFolder } from "@/lib/notesVault";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/notes/folder  — 新建文件夹 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { path?: string };
    if (!body.path) {
      return NextResponse.json({ error: "Missing folder path." }, { status: 400 });
    }
    const result = await createFolder(body.path);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const mappedError = mapVaultError(error);
    return NextResponse.json({ error: mappedError.message }, { status: mappedError.status });
  }
}
