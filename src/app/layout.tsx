import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { cookies, headers } from "next/headers";
import "./globals.css";
import { localeCookie } from "@/i18n/config";
import { getLocaleFromAcceptLanguage, normalizeLocale } from "@/i18n/locale";

export const metadata: Metadata = {
  title: "inkfellow",
  description: "inkfellow — Personal knowledge base powered by LLM Wiki",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "inkfellow",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#000000",
};

const resolveLocale = async () => {
  const headerList = await headers();
  const cookieStore = await cookies();
  const headerLocale = normalizeLocale(headerList.get("x-locale"));
  if (headerLocale) {
    return headerLocale;
  }
  const cookieLocale = normalizeLocale(cookieStore.get(localeCookie)?.value);
  if (cookieLocale) {
    return cookieLocale;
  }
  return getLocaleFromAcceptLanguage(headerList.get("accept-language"));
};

const cloudflareWebAnalyticsToken = process.env.NEXT_PUBLIC_CF_WEB_ANALYTICS_TOKEN?.trim();

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await resolveLocale();
  return (
    <html lang={locale}>
      <body className="antialiased">
        {children}
        {cloudflareWebAnalyticsToken ? (
          <Script
            defer
            src="https://static.cloudflareinsights.com/beacon.min.js"
            data-cf-beacon={JSON.stringify({ token: cloudflareWebAnalyticsToken })}
            strategy="afterInteractive"
          />
        ) : null}
      </body>
    </html>
  );
}
