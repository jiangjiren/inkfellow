import type { Metadata } from "next";
import Link from "next/link";
import { defaultLocale, type Locale } from "@/i18n/config";
import { normalizeLocale } from "@/i18n/locale";
import { HOME_MESSAGES } from "@/i18n/messages";

type HomePageProps = {
  params: Promise<{
    locale: string;
  }>;
};

const resolveLocale = (value: string): Locale =>
  normalizeLocale(value) ?? defaultLocale;

export async function generateMetadata({ params }: HomePageProps): Promise<Metadata> {
  const resolvedParams = await params;
  const locale = resolveLocale(resolvedParams.locale);
  const t = HOME_MESSAGES[locale];
  return {
    title: t.brand,
    description: t.tagline,
  };
}

export default async function HomePage({ params }: HomePageProps) {
  const resolvedParams = await params;
  const locale = resolveLocale(resolvedParams.locale);
  const t = HOME_MESSAGES[locale];

  return (
    <main className="min-h-screen bg-[#FBFBFD] text-[#1D1D1F] selection:bg-[#007AFF] selection:text-white">
      {/* Navigation: Top Right Language Switcher */}
      <nav className="fixed right-6 top-6 z-50 flex items-center gap-1 rounded-full border border-[#D2D2D7]/50 bg-white/70 p-1 backdrop-blur-md shadow-sm">
        <Link
          href="/en"
          className={`rounded-full px-4 py-1.5 text-[11px] font-bold tracking-wider transition-all ${
            locale === "en" ? "bg-[#1D1D1F] text-white" : "text-[#86868B] hover:text-[#1D1D1F]"
          }`}
        >
          EN
        </Link>
        <Link
          href="/zh-CN"
          className={`rounded-full px-4 py-1.5 text-[11px] font-bold tracking-wider transition-all ${
            locale === "zh-CN" ? "bg-[#1D1D1F] text-white" : "text-[#86868B] hover:text-[#1D1D1F]"
          }`}
        >
          中文
        </Link>
      </nav>

      <div className="mx-auto max-w-[1200px] px-6 py-12 md:py-24">
        {/* Compact Hero Section */}
        <header className="mb-12 md:mb-16">
          <div className="flex flex-col items-center text-center">
            <div className="mb-6 h-16 w-16 rounded-[18px] bg-gradient-to-tr from-[#7be2c7] via-[#7aa7ff] to-[#ffd08a] shadow-[0_15px_30px_rgba(0,0,0,0.08)] transition-transform hover:scale-105" />
            <h1 className="mb-3 text-3xl font-bold tracking-tight md:text-5xl">{t.brand}</h1>
            <p className="max-w-xl text-base font-medium text-[#86868B] md:text-lg">{t.tagline}</p>
          </div>
        </header>

        <footer className="mt-24 border-t border-[#D2D2D7]/30 pt-8 text-center text-[11px] font-medium text-[#86868B]">
          <p>© 2026 {t.brand}. Designed for focus and clarity.</p>
        </footer>
      </div>
    </main>
  );
}
