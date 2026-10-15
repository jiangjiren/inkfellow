import type { Metadata } from "next";
import { notFound } from "next/navigation";
import NotesHtml from "@/app/notes/NotesHtml";
import { VaultAccessError } from "@/lib/notesVault";
import { readSharedNote, SharedNoteAccessError } from "@/lib/sharedNotes";
import SharedNoteContent from "./SharedNoteContent";
import PcTocSidebar from "./PcTocSidebar";
import { extractHeadings } from "./tocUtils";
import styles from "./share.module.css";

export const dynamic = "force-dynamic";

type SharePageProps = {
  params: Promise<{
    token: string;
  }>;
};

const stripNoteExtension = (value: string) => value.replace(/\.(md|html?)$/i, "");

const isExpectedMissingShare = (error: unknown) =>
  (error instanceof SharedNoteAccessError || error instanceof VaultAccessError) && error.status < 500;

export async function generateMetadata({ params }: SharePageProps): Promise<Metadata> {
  const { token } = await params;

  try {
    const { note, share } = await readSharedNote(token);
    const title = share.title?.trim() || stripNoteExtension(note.name);
    const noindex = share.noindex !== false;

    return {
      title: `${title} | ${process.env.NEXT_PUBLIC_APP_NAME?.trim() || "inkfellow"}`,
      robots: noindex
        ? {
            index: false,
            follow: false,
            nocache: true,
          }
        : {
            index: true,
            follow: false,
          },
    };
  } catch {
    return {
      title: `Shared Note | ${process.env.NEXT_PUBLIC_APP_NAME?.trim() || "inkfellow"}`,
      robots: {
        index: false,
        follow: false,
        nocache: true,
      },
    };
  }
}

export default async function SharePage({ params }: SharePageProps) {
  const { token } = await params;

  try {
    const { note } = await readSharedNote(token);
    const isHtml = /\.html?$/i.test(note.path);
    const headings = isHtml ? [] : extractHeadings(note.content);

    return (
      <main className={styles.page}>
        <div className={styles.shell}>
          <div className={styles.contentRow}>
            {headings.length > 0 && <PcTocSidebar headings={headings} />}

            <article className={`${styles.document} ${isHtml ? styles.htmlDocument : ""}`}>
              {isHtml ? (
                <NotesHtml html={note.content} />
              ) : (
                <SharedNoteContent
                  markdown={note.content}
                  notePath={note.path}
                  token={token}
                  headings={headings}
                />
              )}
            </article>
          </div>
        </div>
      </main>
    );
  } catch (error) {
    if (isExpectedMissingShare(error)) {
      notFound();
    }

    throw error;
  }
}
