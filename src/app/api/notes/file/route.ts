import { NextRequest, NextResponse } from "next/server";
import { mapVaultError, readMarkdownNote, statMarkdownNote, createMarkdownNote, updateMarkdownNote, deleteNote } from "@/lib/notesVault";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as { path?: string; content?: string };
    if (!body.path || body.content === undefined) {
      return NextResponse.json({ error: "Missing path or content." }, { status: 400 });
    }
    const note = await updateMarkdownNote(body.path, body.content);
    return NextResponse.json(note);
  } catch (error) {
    const mappedError = mapVaultError(error);
    return NextResponse.json({ error: mappedError.message }, { status: mappedError.status });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = (await request.json()) as { path?: string; content?: string };
    if (!body.path) {
      return NextResponse.json({ error: "Missing note path." }, { status: 400 });
    }
    const note = await createMarkdownNote(body.path, body.content ?? "");
    return NextResponse.json(note, { status: 201 });
  } catch (error) {
    const mappedError = mapVaultError(error);
    return NextResponse.json({ error: mappedError.message }, { status: mappedError.status });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = (await request.json()) as { path?: string };
    if (!body.path?.trim()) {
      return NextResponse.json({ error: "Missing note path." }, { status: 400 });
    }
    const result = await deleteNote(body.path);
    return NextResponse.json(result);
  } catch (error) {
    const mappedError = mapVaultError(error);
    return NextResponse.json({ error: mappedError.message }, { status: mappedError.status });
  }
}

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
