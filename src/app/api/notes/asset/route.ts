import { NextRequest, NextResponse } from "next/server";
import { PASTED_IMAGE_MAX_BYTES, mapVaultError, readVaultImage, writePastedImage } from "@/lib/notesVault";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const assetPath = request.nextUrl.searchParams.get("path");
  const fromPath = request.nextUrl.searchParams.get("from");

  if (!assetPath) {
    return NextResponse.json({ error: "Missing asset path." }, { status: 400 });
  }

  try {
    const image = await readVaultImage(assetPath, fromPath);
    return new NextResponse(image.body, {
      headers: {
        "cache-control": "private, max-age=300",
        "content-length": String(image.size),
        "content-type": image.contentType,
        "last-modified": image.updatedAt,
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    const mappedError = mapVaultError(error);
    return NextResponse.json({ error: mappedError.message }, { status: mappedError.status });
  }
}

/** 编辑器粘贴图片：base64 载荷（与桌面端 paste_image 同构），存到笔记同目录 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as {
      notePath?: string;
      originalName?: string;
      mimeType?: string;
      dataBase64?: string;
    } | null;

    if (!body?.notePath || !body?.mimeType || !body?.dataBase64) {
      return NextResponse.json({ error: "Missing notePath, mimeType or dataBase64." }, { status: 400 });
    }
    // base64 长度先粗筛，避免超大载荷才解码
    if (body.dataBase64.length > (PASTED_IMAGE_MAX_BYTES * 4) / 3 + 8) {
      return NextResponse.json({ error: "图片不能超过 20 MB。" }, { status: 413 });
    }

    const data = Buffer.from(body.dataBase64, "base64");
    const saved = await writePastedImage(body.notePath, body.originalName ?? "", body.mimeType, data);
    return NextResponse.json(saved);
  } catch (error) {
    const mappedError = mapVaultError(error);
    return NextResponse.json({ error: mappedError.message }, { status: mappedError.status });
  }
}
