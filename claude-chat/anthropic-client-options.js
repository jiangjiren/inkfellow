// Compatible providers may only implement the older Anthropic Messages API.
// The official Anthropic client uses its own current API version by default.
export function anthropicClientOptions(profile) {
  if (profile.provider === "anthropic") return { apiKey: profile.apiKey };
  return {
    authToken: profile.apiKey,
    baseURL: profile.baseUrl,
    defaultHeaders: { "anthropic-version": "2023-06-01" },
  };
}
