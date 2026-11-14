// ===========================================================================
// SONG ADDRESSES — every catalog track owns one stable, shareable URL:
// /s/<project-slug>--<title-slug>. The map is derived from the catalog
// alone, in catalog order, so the client and the standalone server (which
// renders per-song share metadata) build the identical map from the
// identical source. Collisions — two tracks whose names slugify to the
// same string — take a deterministic -2, -3, … suffix in catalog order.
// A track's address never depends on anything outside the catalog, so a
// shared link keeps naming the same song for as long as the catalog
// entry stands.
// ===========================================================================

import { CATALOG, type CatalogTrack } from "./catalog";

function slugifyPart(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const SLUG_BY_INDEX: string[] = [];
const INDEX_BY_SLUG = new Map<string, number>();

{
  const used = new Set<string>();
  CATALOG.forEach((t, i) => {
    const project = slugifyPart(t.project) || "project";
    const title = slugifyPart(t.title) || "track";
    const base = `${project}--${title}`;
    let slug = base;
    let n = 1;
    while (used.has(slug)) {
      n += 1;
      slug = `${base}-${n}`;
    }
    used.add(slug);
    SLUG_BY_INDEX.push(slug);
    INDEX_BY_SLUG.set(slug, i);
  });
}

/** The shareable path for one catalog track, e.g. /s/a-shot-in-the-dark--01-agency-issues. */
export function songPath(idx: number): string {
  return `/s/${SLUG_BY_INDEX[idx] ?? ""}`;
}

/** The clip address for one catalog track: /clip/<slug> (the start second rides as ?t=). */
export function songClipPath(idx: number): string {
  return `/clip/${SLUG_BY_INDEX[idx] ?? ""}`;
}

/** The catalog index a slug names, or -1 when no track owns it. */
export function songIndexFromSlug(slug: string): number {
  return INDEX_BY_SLUG.get(slug) ?? -1;
}

/** The track a slug names, or undefined when no track owns it. */
export function songTrackFromSlug(slug: string): CatalogTrack | undefined {
  const idx = songIndexFromSlug(slug);
  return idx >= 0 ? CATALOG[idx] : undefined;
}

const SONG_PATH_RE = /^\/s\/([^/]+)\/?$/;

/** True when a pathname is a song address (whether or not the slug resolves). */
export function isSongPath(pathname: string): boolean {
  return SONG_PATH_RE.test(pathname);
}

/** The catalog index a pathname names: >= 0 for a real song, -1 otherwise. */
export function songIndexFromPath(pathname: string): number {
  const slug = SONG_PATH_RE.exec(pathname)?.[1];
  return slug ? songIndexFromSlug(slug) : -1;
}

/** The raw slug in a song pathname, or null when the path is not one. */
export function songSlugFromPath(pathname: string): string | null {
  return SONG_PATH_RE.exec(pathname)?.[1] ?? null;
}
