/* Resolve an assistant's finished video path without allowing it outside the current vault. */
(function (root) {
  function projectFromVideoPath(videoPath, vaultPath) {
    if (typeof videoPath !== "string" || typeof vaultPath !== "string") return null;
    const path = videoPath.trim().replaceAll("\\", "/").replace(/^\.\//, "");
    const vault = vaultPath.trim().replaceAll("\\", "/").replace(/\/+$/, "");
    if (!path || !vault || /[\0-\x1f]/.test(path) || !/\.mp4$/i.test(path)) return null;
    if (path.split("/").some(part => part === ".." || part === ".")) return null;
    let relative = path;
    if (/^[A-Za-z]:\//.test(path)) {
      if (!/^[A-Za-z]:\//.test(vault) || !path.toLowerCase().startsWith(`${vault.toLowerCase()}/`)) return null;
      relative = path.slice(vault.length + 1);
    } else if (path.startsWith("/") || path.includes(":") || path.startsWith("//")) {
      return null;
    }
    const parts = relative.split("/");
    const outIndex = parts.findIndex(part => part.toLowerCase() === "out");
    if (outIndex < 1 || outIndex >= parts.length - 1 || !parts.at(-1)) return null;
    return parts.slice(0, outIndex).join("/");
  }
  root.InkfellowVideoOpenPath = Object.freeze({ projectFromVideoPath });
})(globalThis);
