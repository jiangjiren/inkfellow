export interface TocEntry {
  level: number;
  text: string;
  slug: string;
}

export const slugifyHeading = (value: string) =>
  value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .replace(/\s+/g, "-");

export function extractHeadings(markdown: string): TocEntry[] {
  const body = markdown.replace(/^---[\s\S]*?---\n*/, "").trim();
  const all: TocEntry[] = [];
  const lines = body.split("\n");
  let inCodeBlock = false;
  const seenSlugs = new Set<string>();

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (/^```/.test(trimmedLine) || /^~~~/.test(trimmedLine)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const match = trimmedLine.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      const level = match[1].length;
      const text = match[2].trim();
      const slug = slugifyHeading(text);
      if (seenSlugs.has(slug)) continue;
      seenSlugs.add(slug);
      all.push({ level, text, slug });
    }
  }

  if (all.length === 0) return [];

  const minLevel = Math.min(...all.map((h) => h.level));
  const minCount = all.filter((h) => h.level === minLevel).length;
  const deeperLevels = all.filter((h) => h.level > minLevel).map((h) => h.level);
  const topLevel = minCount > 1 || deeperLevels.length === 0 ? minLevel : Math.min(...deeperLevels);

  // 找到第二层（topLevel 之下最浅的一层）
  const secondaryLevels = all.filter((h) => h.level > topLevel).map((h) => h.level);
  const secondLevel = secondaryLevels.length > 0 ? Math.min(...secondaryLevels) : null;

  return all.filter((h) => h.level === topLevel || (secondLevel !== null && h.level === secondLevel));
}
