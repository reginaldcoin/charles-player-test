// Song-page share metadata for the standalone host.
//
// A song's address (/s/<slug>) is an SPA route: the client renders the
// page itself. But a shared link is first read by software that never
// runs the client — chat apps, social crawlers — and all of those see
// only the served HTML. So for /s/ paths this handler answers with the
// app's own index.html carrying the song's identity in its title and
// Open Graph tags. The slug→track lookup comes from the shared
// client/src/songSlug module, the same map the client renders from, so
// the metadata and the page can never name different songs.
//
// An unknown slug still gets the app shell (the client renders its own
// "not here" song view) but with a 404 status and the generic title:
// a dead address should not dress itself as a song.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  isSongPath,
  songSlugFromPath,
  songTrackFromSlug,
} from "../client/src/songSlug";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function createSongPageHandler(clientDist: string) {
  let shell: string | null = null;
  const loadShell = (): string | null => {
    if (shell !== null) return shell;
    const indexPath = join(clientDist, "index.html");
    if (!existsSync(indexPath)) return null;
    shell = readFileSync(indexPath, "utf8");
    return shell;
  };

  return (url: URL): Response | null => {
    if (!isSongPath(url.pathname)) return null;
    const html = loadShell();
    if (html === null) return null;
    // The shell names its assets relatively (./assets/...) because it is
    // built to be served from the root. Under /s/<slug> a browser resolves
    // those against /s/ and 404s, leaving a dead page, so the served copy
    // points at the root-absolute asset paths instead.
    const shellHtml = html.replace(
      /(src|href)="\.\/assets\//g,
      '$1="/assets/',
    );
    const slug = songSlugFromPath(url.pathname);
    const track = slug ? songTrackFromSlug(slug) : undefined;
    const headers = { "content-type": "text/html; charset=utf-8" };
    if (!track) {
      return new Response(shellHtml, { status: 404, headers });
    }
    const title = `${track.title} — Charles Hamilton`;
    const description = `${track.title}, from ${track.project}. On the Charles Hamilton Player.`;
    const meta = [
      `<meta name="description" content="${escapeHtml(description)}" />`,
      `<meta property="og:type" content="music.song" />`,
      `<meta property="og:site_name" content="Charles Hamilton Player" />`,
      `<meta property="og:title" content="${escapeHtml(title)}" />`,
      `<meta property="og:description" content="${escapeHtml(description)}" />`,
      `<meta property="og:url" content="${escapeHtml(url.href)}" />`,
      `<meta name="twitter:card" content="summary" />`,
      `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
      `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
    ].join("\n    ");
    const page = shellHtml
      .replace(
        /<title>[^<]*<\/title>/,
        `<title>${escapeHtml(`${title} · ${track.project}`)}</title>`,
      )
      .replace("</head>", `    ${meta}\n  </head>`);
    return new Response(page, { status: 200, headers });
  };
}
