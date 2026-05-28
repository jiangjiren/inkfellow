import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const execFileAsync = promisify(execFile);
const DEFAULT_VAULT_PATH = path.join(process.cwd(), "vault");
const VAULT = path.resolve(process.env.VAULT_PATH?.trim() || DEFAULT_VAULT_PATH);

async function git(args: string[]) {
  const { stdout, stderr } = await execFileAsync("git", ["-C", VAULT, "-c", "core.quotepath=false", ...args], {
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

type ChangedFile = {
  name: string;
  path: string;
  state: "added" | "deleted" | "modified" | "renamed";
};

// Graceful fallback message generator
function generateFallbackMessage(files: ChangedFile[]): string {
  if (files.length === 0) {
    return `同步笔记于 ${new Date().toLocaleDateString("zh-CN")} ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  }
  
  const stripExt = (p: string) => p.split("/").pop()?.replace(/\.(md|html?)$/i, "") || p;
  
  if (files.length === 1) {
    const file = files[0];
    const cleanName = stripExt(file.path);
    const action = file.state === "added" ? "新增" : file.state === "deleted" ? "删除" : "修改";
    return `${action}了《${cleanName}》`;
  }
  
  const firstFile = files[0];
  const cleanName = stripExt(firstFile.path);
  return `更新了《${cleanName}》等 ${files.length} 篇笔记`;
}

export async function POST() {
  let changedFiles: ChangedFile[] = [];
  
  try {
    // 1. Stage all changes temporarily so we can capture untracked files
    await git(["add", "-A"]);
    
    // 2. Fetch porcelain status to count changes and list files
    const { stdout: statusOut } = await git(["status", "--porcelain", "-uall"]);
    changedFiles = statusOut
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const code = line.slice(0, 2).trim();
        const rawPath = line.slice(3).trim().replace(/^"(.*)"$/, "$1");
        const filePath = rawPath.includes(" -> ") ? rawPath.split(" -> ")[1] : rawPath;
        const cleanPath = filePath.replace(/\/$/, "");
        const name = cleanPath.split("/").pop() || cleanPath;

        let state: ChangedFile["state"] = "modified";
        if (code === "??" || code === "A" || code.startsWith("A")) state = "added";
        else if (code === "D" || code === "DD" || code === " D") state = "deleted";
        else if (code === "R" || code.startsWith("R")) state = "renamed";

        return { name, path: cleanPath, state };
      });
      
    if (changedFiles.length === 0) {
      return NextResponse.json({ 
        ok: true, 
        message: "所有内容已同步", 
        fallback: "所有内容已同步",
        isAi: false 
      });
    }

    // 3. Read auth-profile.json to get AI credentials
    const profilePath = path.join(process.cwd(), "claude-chat", "auth-profile.json");
    let profileData: any = null;
    try {
      const content = await readFile(profilePath, "utf-8");
      profileData = JSON.parse(content);
    } catch {
      // Ignored: fallback to template
    }

    const activeId = profileData?.activeProfileId;
    let activeProfile = profileData?.profiles?.find((p: any) => p.id === activeId);

    // Fallback: if active profile has no key (e.g. p_claude), find ANY profile that does
    if (!activeProfile || !activeProfile.apiKey) {
      const anyWithKey = profileData?.profiles?.find((p: any) => p.apiKey);
      if (anyWithKey) {
        activeProfile = anyWithKey;
      }
    }

    if (!activeProfile || !activeProfile.apiKey) {
      // No active key found: return graceful fallback immediately
      return NextResponse.json({
        ok: true,
        message: generateFallbackMessage(changedFiles),
        fallback: generateFallbackMessage(changedFiles),
        isAi: false
      });
    }

    // 4. Retrieve cached diff
    const { stdout: diffOut } = await git(["diff", "--cached"]);
    const truncatedDiff = diffOut.slice(0, 4500); // Truncate to prevent token bloating

    // 5. Construct custom LLM API call based on the provider
    let endpoint = "";
    let modelName = "";
    let bodyPayload: any = {};
    const apiKey = activeProfile.apiKey;

    const systemPrompt = "你是一个专业的个人笔记与知识管理专家。请根据以下 Git 变更差异（git diff）生成一条极简、温润、苹果风的笔记同步日志。\n\n设计原则：\n1. 最多 80 字，必须是中文，严禁废话。\n2. 去除所有开发技术噪音：绝对不要包含 git 命令、Markdown 标记、类名、哈希值、分支名或文件名后缀（如 .md）。\n3. 语气要温暖、专注、生活化。多用“整理”、“重写”、“添加”、“修正”等有温度的词。例如：'重写了关于心流的大纲，补充了阅读感悟' 或 '修正了年度计划中的错别字，优化排版'。\n4. 如果改动极其微小，请用一句话高度概括（如：'微调了部分段落的措辞与排版'）。";

    if (activeProfile.provider === "deepseek") {
      endpoint = "https://api.deepseek.com/v1/chat/completions";
      modelName = "deepseek-chat";
      bodyPayload = {
        model: modelName,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `这是当前的变更差异内容：\n\n${truncatedDiff}` }
        ],
        temperature: 0.3,
        max_tokens: 100
      };
    } else if (activeProfile.provider === "openrouter") {
      endpoint = "https://openrouter.ai/api/v1/chat/completions";
      // Determine openrouter model (strip out local proxy prefix "~")
      const rawModel = activeProfile.haikuModel || activeProfile.sonnetModel || "";
      modelName = rawModel.replace(/^~/, "") || "google/gemini-2.5-flash";
      bodyPayload = {
        model: modelName,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `这是当前的变更差异内容：\n\n${truncatedDiff}` }
        ],
        temperature: 0.3,
        max_tokens: 100
      };
    } else {
      // Unrecognized provider fallback
      return NextResponse.json({
        ok: true,
        message: generateFallbackMessage(changedFiles),
        fallback: generateFallbackMessage(changedFiles),
        isAi: false
      });
    }

    // 6. Invoke AI API
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(bodyPayload),
      signal: AbortSignal.timeout(8000) // 8 seconds timeout
    });

    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    const data = await response.json();
    let textMessage = data?.choices?.[0]?.message?.content?.trim();

    if (textMessage) {
      // Clean up quotes if LLM added them
      textMessage = textMessage.replace(/^["'「『](.*)["'」』]$/, "$1").trim();
      return NextResponse.json({
        ok: true,
        message: textMessage,
        fallback: generateFallbackMessage(changedFiles),
        isAi: true
      });
    } else {
      throw new Error("Empty response from AI");
    }

  } catch (err) {
    console.error("AI Sync Log generation error:", err);
    // Gracefully return fallback message
    return NextResponse.json({
      ok: true,
      message: generateFallbackMessage(changedFiles),
      fallback: generateFallbackMessage(changedFiles),
      isAi: false,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
