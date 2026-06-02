import { NextRequest, NextResponse } from "next/server";
import { mapVaultError, createFolder, deleteFolder, renameVaultEntry } from "@/lib/notesVault";

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

/** PATCH /api/notes/folder — 重命名文件夹 */
export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as { path?: string; name?: string };
    if (!body.path || !body.name) {
      return NextResponse.json({ error: "Missing folder path or name." }, { status: 400 });
    }
    const result = await renameVaultEntry(body.path, body.name, "folder");
    return NextResponse.json(result);
  } catch (error) {
    const mappedError = mapVaultError(error);
    return NextResponse.json({ error: mappedError.message }, { status: mappedError.status });
  }
}

/** DELETE /api/notes/folder — 删除文件夹 */
export async function DELETE(request: NextRequest) {
  try {
    const body = (await request.json()) as { path?: string };
    if (!body.path?.trim()) {
      return NextResponse.json({ error: "Missing folder path." }, { status: 400 });
    }
    const result = await deleteFolder(body.path);
    return NextResponse.json(result);
  } catch (error) {
    const mappedError = mapVaultError(error);
    return NextResponse.json({ error: mappedError.message }, { status: mappedError.status });
  }
}
