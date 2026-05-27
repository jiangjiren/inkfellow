import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { normalizeLocale } from "@/i18n/locale";

type LocaleLayoutProps = {
  children: ReactNode;
  params: Promise<{
    locale: string;
  }>;
};

export default async function LocaleLayout({ children, params }: LocaleLayoutProps) {
  const resolvedParams = await params;
  const locale = normalizeLocale(resolvedParams.locale);
  if (!locale) {
    notFound();
  }
  return children;
}
