import path from "node:path";
import { init, parse as parseModule } from "es-module-lexer";
import type { Root, RootContent } from "mdast";
import { defaultTreeAdapter, html as htmlNamespaces, parse as parseHtml, serialize, type DefaultTreeAdapterTypes } from "parse5";
import { parse as parseCss } from "postcss";
import valueParser from "postcss-value-parser";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import {
  isShareableHtmlAsset,
  readVaultHtmlAsset,
  readVaultImage,
  VaultAccessError,
} from "@/lib/notesVault";
import { splitObsidianTarget, WIKI_IMAGE_EXT_RE } from "@/lib/obsidianTargets";
import { readSharedNote } from "@/lib/sharedNotes";

type ShareableNote = Awaited<ReturnType<typeof readSharedNote>>["note"];
type HtmlElement = DefaultTreeAdapterTypes.Element;
type HtmlNode = DefaultTreeAdapterTypes.Node;
type AssetKind = "markdown" | "html" | "relative";

const markdownParser = unified().use(remarkParse).use(remarkGfm);
const virtualOrigin = "https://share-assets.invalid";
const ASSET_PATH_MARKER = "_html";
const encodePath = (value: string) => value.split("/").map(encodeURIComponent).join("/");
export const isHtmlShare = (notePath: string) => /\.html?$/i.test(notePath);
export const sharedHtmlAssetMarker = ASSET_PATH_MARKER;

export const shareHtmlAssetBase = (token: string, notePath: string) => {
  const folder = path.posix.dirname(notePath);
  return `/api/share/asset/${token}/${ASSET_PATH_MARKER}/${folder === "." ? "" : `${encodePath(folder)}/`}`;
};

export const markdownShareAssetHref = (token: string, reference: string) =>
  `/api/share/asset?${new URLSearchParams({ token, path: reference })}`;

const isRelativeResource = (value: string) =>
  !!value && !/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(value);

const markdownImageKey = (reference: string) => {
  const value = reference.split(/[?#]/, 1)[0].trim().replace(/\\/g, "/");
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

function markdownDescription(content: string) {
  // The Markdown reader omits YAML front matter when rendering image references.
  const frontMatter = /^---\r?\n([\s\S]*?)^---[ \t]*\r?$(?:\n|$)/m.exec(content);
  const body = frontMatter?.index === 0 ? content.slice(frontMatter[0].length) : content;
  const tree: Root = markdownParser.parse(body);
  const definitions = new Map<string, string>();
  const imageNodes: Array<{ url: string } | { identifier: string }> = [];
  const images = new Map<string, string>();
  let title = "";

  const text = (node: RootContent): string => {
    if ("value" in node && typeof node.value === "string") return node.value;
    if ("children" in node) return node.children.map((child) => text(child as RootContent)).join("");
    return "";
  };
  const visit = (node: Root | RootContent) => {
    if (node.type === "image") imageNodes.push(node);
    if (node.type === "imageReference") imageNodes.push(node);
    if (node.type === "definition" && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    }
    if (node.type === "heading" && !title) title = text(node).trim();
    if (node.type === "text") {
      for (const match of node.value.matchAll(/!\[\[([^\]]+)\]\]/g)) {
        const { target } = splitObsidianTarget(match[1]);
        if (WIKI_IMAGE_EXT_RE.test(target)) imageNodes.push({ url: target });
      }
    }
    if ("children" in node) node.children.forEach((child) => visit(child as RootContent));
  };

  visit(tree);
  for (const image of imageNodes) {
    const url = ("url" in image ? image.url : definitions.get(image.identifier))?.trim();
    if (url && !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(url)) {
      images.set(markdownImageKey(url), url);
    }
  }
  return { title, images };
}

const attribute = (node: HtmlElement, name: string) =>
  node.attrs.find((attr) => attr.name === name)?.value.trim() ?? "";

function findHtmlElement(node: HtmlNode, matches: (node: HtmlElement) => boolean): HtmlElement | undefined {
  if ("tagName" in node && matches(node)) return node;
  if ("childNodes" in node) {
    for (const child of node.childNodes) {
      const match = findHtmlElement(child, matches);
      if (match) return match;
    }
  }
}

const findHtmlBase = (node: HtmlNode) => findHtmlElement(node, (element) =>
  element.tagName === "base" && element.attrs.some((attr) => attr.name === "href"));

function resolveHtmlBase(base: HtmlElement | undefined, fallback: URL) {
  try {
    return base ? new URL(attribute(base, "href"), fallback) : fallback;
  } catch {
    return fallback;
  }
}

export function prepareSharedHtml(note: ShareableNote, token: string) {
  const document = parseHtml(note.content);
  const head = findHtmlElement(document, (element) => element.tagName === "head");
  if (!head) return note.content;

  const authorBase = findHtmlBase(document);
  const resolved = resolveHtmlBase(authorBase, new URL(shareHtmlAssetBase(token, note.path), virtualOrigin));
  const href = resolved.origin === virtualOrigin ? resolved.href.slice(virtualOrigin.length) : resolved.href;
  const base = defaultTreeAdapter.createElement("base", htmlNamespaces.NS.HTML, [{ name: "href", value: href }]);
  if (authorBase) {
    authorBase.attrs = authorBase.attrs.filter((attr) => attr.name !== "href");
  }
  if (head.childNodes[0]) defaultTreeAdapter.insertBefore(head, base, head.childNodes[0]);
  else defaultTreeAdapter.appendChild(head, base);
  return serialize(document);
}

const textContent = (node: HtmlNode): string => {
  if (node.nodeName === "#text" && "value" in node) return node.value;
  return "childNodes" in node ? node.childNodes.map(textContent).join("") : "";
};

const getLocalResource = (reference: string, base: URL) => {
  if (!isRelativeResource(reference)) return null;

  try {
    const url = new URL(reference, base);
    if (url.origin !== virtualOrigin) return null;
    const candidate = path.posix.normalize(decodeURIComponent(url.pathname).slice(1));
    if (candidate.startsWith("../") || candidate.startsWith("/") || candidate.includes("\0") ||
        candidate.includes("\\") || !isShareableHtmlAsset(candidate)) return null;
    return candidate;
  } catch {
    return null;
  }
};

function cssResources(source: string) {
  const references: string[] = [];
  try {
    const css = parseCss(source);
    const addUrls = (value: string) => {
      valueParser(value).walk((node) => {
        if (node.type === "function" && node.value.toLowerCase() === "url") {
          const item = node.nodes.find((child) => child.type !== "space");
          if (item) references.push(item.value);
          return false;
        }
      });
    };
    css.walkDecls((declaration) => { addUrls(declaration.value); });
    css.walkAtRules("import", (rule) => {
      const first = valueParser(rule.params).nodes[0];
      if (first?.type === "string") references.push(first.value);
      addUrls(rule.params);
    });
  } catch {
    // A malformed stylesheet has no reliably parseable dependencies.
  }
  return references;
}

async function moduleResources(source: string) {
  await init;
  try {
    return parseModule(source)[0].flatMap(({ n }) => n?.startsWith(".") ? [n] : []);
  } catch {
    return [];
  }
}

function srcsetResources(source: string) {
  const urls: string[] = [];
  let rest = source.trim();
  while (rest) {
    rest = rest.replace(/^[\s,]+/, "");
    const url = /^\S+/.exec(rest)?.[0];
    if (!url) break;
    urls.push(url.replace(/,+$/, ""));
    rest = rest.slice(url.length);
    if (url.endsWith(",")) continue;
    const comma = rest.indexOf(",");
    rest = comma < 0 ? "" : rest.slice(comma + 1);
  }
  return urls;
}

function htmlDescription(note: ShareableNote) {
  const html = parseHtml(note.content);
  const originalBase = new URL(encodePath(note.path), virtualOrigin);
  const base = resolveHtmlBase(findHtmlBase(html), originalBase);
  let title = "";
  let description = "";
  let cover = "";
  let firstImage = "";
  const references: string[] = [];
  const modules: string[] = [];

  const visit = (node: HtmlNode) => {
    if ("tagName" in node) {
      const src = attribute(node, "src");
      const href = attribute(node, "href");
      const style = attribute(node, "style");
      if (style) references.push(...cssResources(`asset {${style}}`));

      switch (node.tagName) {
        case "title":
          title ||= textContent(node).trim();
          break;
        case "meta":
          if (attribute(node, "name") === "inkfellow-share-asset") references.push(attribute(node, "content"));
          if (attribute(node, "name") === "description") description ||= attribute(node, "content");
          if (attribute(node, "property") === "og:image") {
            const value = attribute(node, "content");
            cover ||= value;
            references.push(value);
          }
          break;
        case "img":
          firstImage ||= src;
          references.push(src, ...srcsetResources(attribute(node, "srcset")));
          break;
        case "source":
          references.push(src, ...srcsetResources(attribute(node, "srcset")));
          break;
        case "audio":
        case "track":
        case "video":
          references.push(src, attribute(node, "poster"));
          break;
        case "link":
          if (attribute(node, "rel").toLowerCase().split(/\s+/).some((rel) =>
            ["stylesheet", "modulepreload", "preload", "icon", "manifest"].includes(rel))) {
            references.push(href, ...srcsetResources(attribute(node, "imagesrcset")));
          }
          break;
        case "script":
          if (src) references.push(src);
          else if (attribute(node, "type") === "module") modules.push(textContent(node));
          break;
        case "style":
          references.push(...cssResources(textContent(node)));
          break;
        case "a":
          if (node.attrs.some((attr) => attr.name === "download")) references.push(href);
          break;
      }
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
    if ("content" in node) visit(node.content);
  };

  visit(html);
  const assets = references.flatMap((url) => getLocalResource(url, base) ?? []);
  return {
    title,
    description,
    cover: getLocalResource(cover || firstImage, base),
    assets,
    base,
    modules,
    originalBase,
  };
}

export function describeSharedNote(note: ShareableNote, token: string) {
  if (isHtmlShare(note.path)) {
    const { title, description, cover } = htmlDescription(note);
    return {
      title,
      description,
      cover: cover ? `/api/share/asset/${token}/${ASSET_PATH_MARKER}/${encodePath(cover)}` : null,
    };
  }

  const { title, images } = markdownDescription(note.content);
  const firstImage = images.values().next().value;
  return { title, description: "", cover: firstImage ? markdownShareAssetHref(token, firstImage) : null };
}

async function permittedHtmlAsset(note: ShareableNote, requested: string, kind: AssetKind) {
  const { assets, base, modules, originalBase } = htmlDescription(note);
  const match = kind === "html"
    ? requested
    : getLocalResource(requested, originalBase);
  if (!match || !isShareableHtmlAsset(match)) return null;

  const seen = new Set(assets);
  if (seen.has(match)) return match;

  for (const moduleSource of modules) {
    for (const relative of await moduleResources(moduleSource)) {
      const reference = getLocalResource(relative, base);
      if (reference) seen.add(reference);
    }
  }

  // Follow dependencies in linked CSS and JS, with Set insertion order acting
  // as the queue and preventing cycles.
  for (const asset of seen) {
    if (asset === match) return match;
    const extension = path.posix.extname(asset).toLowerCase();
    if (![".css", ".js", ".mjs"].includes(extension)) continue;
    try {
      const { body } = await readVaultHtmlAsset(encodeURIComponent(asset), true);
      const source = body.toString("utf8");
      const references = extension === ".css" ? cssResources(source) : await moduleResources(source);
      const assetUrl = new URL(encodePath(asset), virtualOrigin);
      for (const relative of references) {
        const reference = getLocalResource(relative, assetUrl);
        if (reference) seen.add(reference);
      }
    } catch (error) {
      if (!(error instanceof VaultAccessError && error.status < 500)) throw error;
    }
  }
  return null;
}

export async function readSharedNoteAsset(token: string, assetPath: string, kind: AssetKind) {
  const { note } = await readSharedNote(token);

  if (isHtmlShare(note.path)) {
    const permitted = await permittedHtmlAsset(note, assetPath, kind);
    if (permitted) return readVaultHtmlAsset(encodeURIComponent(permitted), true);
  } else if (kind === "markdown") {
    const { images } = markdownDescription(note.content);
    const reference = images.get(markdownImageKey(assetPath));
    if (reference) {
      const image = await readVaultImage(reference, encodeURIComponent(note.path));
      return { ...image, fileName: path.posix.basename(markdownImageKey(reference)) };
    }
  }

  throw new VaultAccessError("Share asset not found.", 404);
}
