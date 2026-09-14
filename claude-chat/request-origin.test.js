import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedBrowserOrigin } from "./request-origin.js";
test("browser requests must originate on the chat host, including proxied and separate-port setups", () => {
  const allows = (host, origin) => isAllowedBrowserOrigin({ headers: { host, origin } });
  assert.equal(allows("ink.example", "https://ink.example"), true);
  assert.equal(allows("localhost:8082", "http://localhost:3000"), true);
  assert.equal(allows("127.0.0.1:8082", "https://foreign.example"), false);
  assert.equal(allows("ink.example", "https://ink.example.attacker.test"), false);
  assert.equal(allows("localhost:8082", "null"), false);
  assert.equal(allows("localhost:8082", undefined), true);
});

 test("only a local reverse proxy may provide the original host", () => {
  const headers = { host: "127.0.0.1:8082", origin: "https://ink.example", "x-forwarded-host": "ink.example" };
  assert.equal(isAllowedBrowserOrigin({ headers, socket: { remoteAddress: "127.0.0.1" } }), true);
  assert.equal(isAllowedBrowserOrigin({ headers, socket: { remoteAddress: "203.0.113.1" } }), false);
});
