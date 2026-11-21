export const WIKI_IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;

export const splitObsidianTarget = (rawTarget: string) => {
  const [targetWithHeading, alias] = rawTarget.split("|");
  const hashIndex = targetWithHeading.indexOf("#");
  const target = hashIndex >= 0 ? targetWithHeading.slice(0, hashIndex).trim() : targetWithHeading.trim();
  const fragment = hashIndex >= 0 ? targetWithHeading.slice(hashIndex + 1).trim() : "";

  return {
    target,
    fragment,
    heading: fragment.startsWith("^") ? "" : fragment,
    blockId: fragment.startsWith("^") ? fragment.slice(1) : "",
    alias: alias?.trim() || "",
  };
};
