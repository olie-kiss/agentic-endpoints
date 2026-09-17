/**
 * The service icon, inlined.
 *
 * The Bazaar persists `iconUrl` and renders it next to the listing, so this
 * has to be reachable over HTTP before the catalog entry is worth anything.
 * There is no assets binding on this Worker and wrangler does not resolve
 * `?raw` imports, so the markup lives here as a string rather than as a file
 * that would 404 in production — which is exactly what it did.
 *
 * SVG rather than the 222 KB PNG beside it: the bundle is shipped on every
 * cold start, and a directory listing renders this at about 32px.
 */
export const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="Agentic Endpoints">
  <title>Agentic Endpoints</title>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1B1F3B"/>
      <stop offset="100%" stop-color="#0B0D1A"/>
    </linearGradient>
  </defs>

  <rect width="512" height="512" rx="112" fill="url(#bg)"/>

  <text x="256" y="304"
        font-family="ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace"
        font-size="176" font-weight="700" letter-spacing="-6"
        text-anchor="middle" fill="#F5F7FF">402</text>

  <rect x="120" y="360" width="272" height="14" rx="7" fill="#2E3457"/>
  <circle cx="326" cy="367" r="26" fill="#5B8CFF"/>
  <circle cx="326" cy="367" r="10" fill="#0B0D1A"/>
</svg>
`;
