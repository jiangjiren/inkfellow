import type { Metadata } from "next";
import NotesExplorer from "./notes/NotesExplorer";

export const dynamic = "force-dynamic";

const appName = process.env.NEXT_PUBLIC_APP_NAME?.trim() || "My Notes";

export const metadata: Metadata = {
  title: appName,
  description: `${appName} — Personal knowledge base powered by LLM Wiki`,
};

export default function NotesPage() {
  return <NotesExplorer />;
}
