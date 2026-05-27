import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { localeCookie } from "@/i18n/config";
import { getLocaleFromAcceptLanguage, normalizeLocale } from "@/i18n/locale";

export const dynamic = "force-dynamic";

export default async function RootPage() {
  const cookieStore = await cookies();
  const headerList = await headers();
  const cookieLocale = normalizeLocale(cookieStore.get(localeCookie)?.value);
  const locale = cookieLocale
    ? cookieLocale
    : getLocaleFromAcceptLanguage(headerList.get("accept-language"));

  redirect(`/${locale}`);
}
