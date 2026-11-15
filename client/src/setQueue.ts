// ---------------------------------------------------------------------------
// SETS — play by project, as a small pure machine the deck drives.
//
// A set is a visit: play a project from the top, in catalog order, and
// when its last track ends the deck hands control back to the shuffle —
// unless the project loop is armed, in which case the set runs again.
// The full run is a top-50 privilege: a listener ranked below the gate
// (or unranked) gets the set's first song only, then the shuffle takes
// them back. The gate is read once, when the set starts; a set already
// running is never re-judged.
//
// The loop knows its scope by context, and that knowledge lives here
// too: outside a set, an armed loop on a natural track end repeats the
// SONG; inside a set, it re-runs the SET. A manual skip never honors
// either loop — the listener's hand outranks the machine.
// ---------------------------------------------------------------------------

export const SET_FULL_RANK = 50;

export interface SetState {
  project: string;
  tracks: number[];
  pos: number;
}

// Start a set over a project's catalog indices (already in catalog
// order). Rank at the press decides the queue: at or inside the gate,
// the whole project; below it or unranked, the first track alone.
export function startSet(
  project: string,
  projectTracks: number[],
  rank: number | null,
): SetState | null {
  if (projectTracks.length === 0) return null;
  const full = rank !== null && rank <= SET_FULL_RANK;
  const tracks = full ? [...projectTracks] : projectTracks.slice(0, 1);
  return { project, tracks, pos: 0 };
}

export type AdvanceAction =
  // Song loop: repeat the track that just ended.
  | { kind: "repeat"; index: number; set: null }
  // Play this catalog index next; `set` is the set state to keep
  // (null once the set is over and the shuffle owns the deck again).
  | { kind: "track"; index: number; set: SetState }
  // The set is over (or never was): the shuffle picks what is next.
  | { kind: "shuffle"; set: null };

// Decide what a track end means. `natural` is true only for the audio
// element's own ended event — skips and error advances pass false for
// the loop's sake (an error still walks the set's order, it just never
// triggers a repeat or a re-run).
export function decideAdvance(
  current: number,
  set: SetState | null,
  natural: boolean,
  loopOn: boolean,
): AdvanceAction {
  if (!set) {
    if (natural && loopOn && current >= 0) {
      return { kind: "repeat", index: current, set: null };
    }
    return { kind: "shuffle", set: null };
  }
  const nextPos = set.pos + 1;
  const nextIdx = set.tracks[nextPos];
  if (nextIdx !== undefined) {
    return {
      kind: "track",
      index: nextIdx,
      set: { ...set, pos: nextPos },
    };
  }
  // The set's last track ended. An armed loop on a natural end runs
  // the whole set again from the top; anything else ends the visit.
  if (natural && loopOn) {
    const first = set.tracks[0];
    if (first !== undefined) {
      return { kind: "track", index: first, set: { ...set, pos: 0 } };
    }
  }
  return { kind: "shuffle", set: null };
}

// The catalog index the set would serve next, without moving anything
// — the preload's aim. Null when the set has nothing after the current
// track and no loop is armed (the shuffle's pick is the warm target
// then, and the caller falls back to it).
export function peekSetNext(set: SetState, loopOn: boolean): number | null {
  const nextIdx = set.tracks[set.pos + 1];
  if (nextIdx !== undefined) return nextIdx;
  if (loopOn) return set.tracks[0] ?? null;
  return null;
}
