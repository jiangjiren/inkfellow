self.addEventListener("activate", (event) => {
  // Remove shared content written by previous releases with offline caching.
  event.waitUntil(caches.keys().then((names) => Promise.all(names.map(async (name) => {
    const cache = await caches.open(name);
    const entries = await cache.keys();
    await Promise.all(entries.filter(({ url }) => {
      const { origin, pathname } = new URL(url);
      return origin === self.location.origin && (
        pathname.startsWith("/share/") ||
        pathname.startsWith("/api/share/") ||
        pathname === "/api/notes/share"
      );
    }).map((request) => cache.delete(request)));
  }))).catch((error) => console.warn("Unable to clear old share caches.", error)));
});
