import { NextRequest, NextResponse } from "next/server";
import { importVaultFiles, mapVaultError } from "@/lib/notesVault";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const targetFolder = String(form.get("folder") ?? "");
    const entries = form.getAll("files").filter((entry): entry is File => entry instanceof File);

    if (entries.length === 0) {
      return NextResponse.json({ error: "Missing files." }, { status: 400 });
    }

    const files = await Promise.all(
      entries.map(async (file) => ({
        name: file.name,
        data: new Uint8Array(await file.arrayBuffer()),
      })),
    );
    const result = await importVaultFiles(targetFolder, files);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const mappedError = mapVaultError(error);
    return NextResponse.json({ error: mappedError.message }, { status: mappedError.status });
  }
}
