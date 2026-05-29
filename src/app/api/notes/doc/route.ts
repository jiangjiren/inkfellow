import { NextRequest, NextResponse } from "next/server";
import { mapVaultError, readVaultDocument } from "@/lib/notesVault";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/notes/doc?path=...  — 只读返回文档字节（目前仅 PDF）供 <iframe> 内联预览
export async function GET(request: NextRequest) {
  const docPath = request.nextUrl.searchParams.get("path");

  if (!docPath) {
    return NextResponse.json({ error: "Missing document path." }, { status: 400 });
  }

  try {
    const doc = await readVaultDocument(docPath);
    return new NextResponse(doc.body, {
      headers: {
        "cache-control": "private, max-age=300",
        "content-length": String(doc.size),
        "content-type": doc.contentType,
        // inline + filename：浏览器内联预览而非下载
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`,
        "last-modified": doc.updatedAt,
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    const mappedError = mapVaultError(error);
    return NextResponse.json({ error: mappedError.message }, { status: mappedError.status });
  }
}
