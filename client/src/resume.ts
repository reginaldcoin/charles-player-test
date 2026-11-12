// ============================================================================
// DURABLE NOW-PLAYING SAVE — the reopen fix (2026-11-11, Teo's report).
//
// The player used to keep the in-progress song only in page memory. On
// a long dark-screen run the OS can kill the page outright; the reopen
// was then a cold load, and a cold load started a fresh shuffle song —
// "it didnt continue when opened. Went to the next song." The
// haunting fix's auto-resume only ever covered returns where the page
// itself survived.
//
// This module is the save's shape and its judge. The player writes the
// save continuously while a track plays (see persistResume in App.tsx):
// which track, where the playhead is, how many honest seconds have
// been heard but NOT yet captured by a play report, and whether the
// listener left it playing or paused it himself. On load, judgeResume
// decides whether that save may come back:
//
//   - identity is title + project (the pair plays are logged from),
//     with src as fallback — a catalog regeneration between visits
//     must not resurrect the wrong song at a stale array index;
//   - a save older than the window is history, not a hijack;
//   - a track already heard to >= 90% is finished business: the
//     reopen moves on normally instead of resuming a corpse;
//   - a track no longer in the catalog falls back to a normal start.
//
// Settle-once lives in how the save is written and consumed, not here:
// the banked seconds a report has already captured are zeroed in the
// save at capture time, so the seconds in `unreported` are claimed by
// exactly one report, ever — the one that ends the restored play.
// ============================================================================

export interface ResumeSave {
  v: 1;
  title: string;
  project: string;
  src: string;
  /** Seconds into the track when the save was written. */
  pos: number;
  /** Duration snapshot (element's own, else the catalog's), 0 if unknown. */
  dur: number;
  /** Honest seconds heard for this play, not yet captured by a report. */
  unreported: number;
  /** True when the listener left it playing; false = he paused it himself. */
  wasPlaying: boolean;
  /** Wall-clock ms when the save was written. */
  savedAt: number;
}

export const RESUME_KEY = "chp.resume.v1";

/** A save may resume within a day of the death — overnight counts,
 *  last week does not. */
export const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ResumeVerdict =
  | { ok: true; idx: number; save: ResumeSave }
  | {
      ok: false;
      reason: "none" | "corrupt" | "stale" | "gone" | "finished";
    };

function parseResumeSave(raw: string): ResumeSave | null {
  try {
    const p = JSON.parse(raw) as Partial<ResumeSave>;
    if (
      p.v !== 1 ||
      typeof p.title !== "string" ||
      typeof p.project !== "string" ||
      typeof p.src !== "string" ||
      typeof p.pos !== "number" ||
      typeof p.unreported !== "number" ||
      typeof p.savedAt !== "number" ||
      !isFinite(p.pos) ||
      !isFinite(p.unreported) ||
      p.pos < 0 ||
      p.unreported < 0
    ) {
      return null;
    }
    return {
      v: 1,
      title: p.title,
      project: p.project,
      src: p.src,
      pos: p.pos,
      dur:
        typeof p.dur === "number" && isFinite(p.dur) && p.dur > 0 ? p.dur : 0,
      unreported: p.unreported,
      wasPlaying: p.wasPlaying === true,
      savedAt: p.savedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Judge a stored save for a reopening page. `resolveIdx` maps the save
 * back to a catalog index (title + project first, src fallback) and
 * returns -1 when the track is gone.
 */
export function judgeResume(
  raw: string | null,
  now: number,
  resolveIdx: (save: ResumeSave) => number,
): ResumeVerdict {
  if (!raw) return { ok: false, reason: "none" };
  const save = parseResumeSave(raw);
  if (!save) return { ok: false, reason: "corrupt" };
  // Stale: too old — or dated in the future by more than clock skew,
  // which no honest save can be.
  if (now - save.savedAt > RESUME_WINDOW_MS || save.savedAt > now + 5 * 60 * 1000) {
    return { ok: false, reason: "stale" };
  }
  const idx = resolveIdx(save);
  if (idx < 0) return { ok: false, reason: "gone" };
  // Effectively finished: a finish is judged at >= 90% of the track.
  // Resuming a corpse would re-hear its tail and risk a second claim
  // on a play whose ending already belongs to the previous session.
  if (save.dur > 0 && save.pos >= 0.9 * save.dur) {
    return { ok: false, reason: "finished" };
  }
  // Defensive clamp: no play can hold more unreported time than the
  // track holds, whatever a damaged save claims.
  if (save.dur > 0 && save.unreported > save.dur) {
    save.unreported = save.dur;
  }
  return { ok: true, idx, save };
}
