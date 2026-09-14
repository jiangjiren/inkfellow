// Browsers always send Origin on WebSocket handshakes. Reject foreign sites;
// authentication remains the responsibility of the deployment's reverse proxy.
export function isAllowedBrowserOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // CLI/native clients do not carry browser origins.
  try {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    // Preserve the explicit wsPort setup: same hostname, separate app/chat ports.
    const hosts = [req.headers.host];
    const peer = req.socket?.remoteAddress;
    if (["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer) && typeof req.headers["x-forwarded-host"] === "string") {
      hosts.push(req.headers["x-forwarded-host"].split(",")[0].trim());
    }
    return hosts.some(host => parsed.hostname === new URL(`http://${host}`).hostname);
  } catch { return false; }
}
