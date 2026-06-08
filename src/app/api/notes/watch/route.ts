import { type NextRequest } from "next/server";
import { watch } from "fs";
import path from "path";
import { mapVaultError, resolveVaultPath } from "@/lib/notesVault";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const notePath = request.nextUrl.searchParams.get("path");
  if (!notePath) {
    return new Response("Missing path", { status: 400 });
  }

  let absolutePath: string;
  try {
    const resolved = await resolveVaultPath(notePath);
    absolutePath = resolved.absolutePath;
  } catch (error) {
    const { message, status } = mapVaultError(error);
    return new Response(message, { status });
  }

  const encoder = new TextEncoder();

  // 监听父目录而非文件本身：编辑器/Agent 常用「写临时文件 + rename 覆盖」的原子写入，
  // 直接 watch 文件会在 rename 后因 inode 失效而停止触发。目录 inode 稳定，可靠捕获。
  const watchDir = path.dirname(absolutePath);
  const watchBasename = path.basename(absolutePath);

  const stream = new ReadableStream({
    start(controller) {
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;

      const watcher = watch(watchDir, { persistent: false }, (eventType, filename) => {
        if (eventType !== "change" && eventType !== "rename") return;
        // filename 为 null（极少数平台）时保守触发，避免漏更新
        if (filename !== null && filename !== watchBasename) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          try {
            controller.enqueue(encoder.encode("event: change\ndata: {}\n\n"));
          } catch { /* stream already closed */ }
        }, 100);
      });

      // 每 20s 发一个 SSE 注释，防止 nginx/代理因空闲关闭连接
      const pingTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          clearInterval(pingTimer);
        }
      }, 20000);

      request.signal.addEventListener("abort", () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        clearInterval(pingTimer);
        watcher.close();
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
