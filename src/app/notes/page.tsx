import type { Metadata } from "next";
import NotesExplorer from "./NotesExplorer";

export const dynamic = "force-dynamic";

const appName = process.env.NEXT_PUBLIC_APP_NAME?.trim() || "My Notes";

export const metadata: Metadata = {
  title: `Markdown Notes | ${appName}`,
  description: `Read-only Markdown knowledge base — ${appName}.`,
};

export default function NotesPage() {
  return <NotesExplorer />;
}
