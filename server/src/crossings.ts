// CROSSINGS — every pass on the board, replayed from the plays ledger.
//
// Reigns (reigns.ts) reads the record back for № 1 alone; this reads it
// back for the whole board. Walking the plays in order under the
// board's own ordering (score, then finishes, then earliest claim), a
// crossing is the moment a play moves one listener ahead of another
// who stood above them: the crosser's new rank is fixed by that play,
// and every listener the play jumps earns one headline. Nothing is
// stored and no points are minted here — judged on today's record, a
// re-judged or removed play rewrites crossing history exactly the way
// it rewrote the score, which is why this is a replay and not a log.

export interface CrossingPlay {
  listenerId: number;
  points: number;
  finished: number; // 0 | 1
  playedAtMs: number;
}

export interface CrossingEvent {
  /** Server time the crossing play landed (epoch ms). */
  atMs: number;
  crosserId: number;
  crossedId: number;
  /** The crosser's rank (1-based) after the play. One play that jumps
      several listeners gives every crossed pair this same rank. */
  newRank: number;
  /** Chronological sequence among all crossings — stable across reads,
      so headline phrasing rotation never reshuffles between loads. */
  seq: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeCrossings(
  plays: CrossingPlay[], // pre-sorted by (playedAtMs, insertion order)
  createdAtById: Map<number, number>,
): CrossingEvent[] {
  const totals = new Map<number, { score: number; finishes: number }>();
  // Strictly ahead under the board ordering: score, then finishes, then
  // the earlier claim wins a full tie. Same law as computeReigns.
  const ahead = (
    aId: number,
    a: { score: number; finishes: number },
    bId: number,
    b: { score: number; finishes: number },
  ): boolean =>
    a.score !== b.score
      ? a.score > b.score
      : a.finishes !== b.finishes
        ? a.finishes > b.finishes
        : (createdAtById.get(aId) ?? 0) < (createdAtById.get(bId) ?? 0);

  // Listener ids currently on the board (score > 0), best first.
  const ranking: number[] = [];
  const events: CrossingEvent[] = [];
  let seq = 0;

  for (const p of plays) {
    const t = totals.get(p.listenerId) ?? { score: 0, finishes: 0 };
    t.score = round2(t.score + p.points);
    t.finishes += p.finished === 1 ? 1 : 0;
    totals.set(p.listenerId, t);

    const oldIndex = ranking.indexOf(p.listenerId);
    if (oldIndex >= 0) ranking.splice(oldIndex, 1);
    // Points get you on the board; no points, no crossing.
    if (t.score <= 0) continue;

    // Insertion point under the board ordering. Totals only ever grow,
    // so a listener can only hold or climb: newIndex <= oldIndex when
    // they were already ranked, and everyone the play jumps sits in
    // ranking[newIndex .. oldIndex) (or below newIndex for a newcomer).
    let newIndex = ranking.length;
    for (let i = 0; i < ranking.length; i++) {
      const other = totals.get(ranking[i]!);
      if (other && ahead(p.listenerId, t, ranking[i]!, other)) {
        newIndex = i;
        break;
      }
    }
    const crossed =
      oldIndex >= 0
        ? ranking.slice(newIndex, oldIndex)
        : ranking.slice(newIndex);
    for (const crossedId of crossed) {
      events.push({
        atMs: p.playedAtMs,
        crosserId: p.listenerId,
        crossedId,
        newRank: newIndex + 1,
        seq: seq++,
      });
    }
    ranking.splice(newIndex, 0, p.listenerId);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Headline voice — the board read like a live timeline. Short,
// present-tense, post-like. The rotation is keyed on the crossing's
// stable sequence so the same record always reads the same way; every
// fact in the line (names, rank) is the record's own.
// ---------------------------------------------------------------------------

export function crossingHeadline(
  ev: CrossingEvent,
  crosserName: string,
  crossedName: string,
): string {
  const x = crosserName;
  const y = crossedName;
  const r = ev.newRank;
  const bank =
    r === 1
      ? [
          `${x} takes the crown — ${y} crossed at the top. New № 1.`,
          `The crown moves: ${x} over ${y} for № 1.`,
          `New champ. ${x} crosses ${y} and takes № 1.`,
          `${x} is № 1. ${y} got crossed at the top.`,
        ]
      : r <= 10
        ? [
            `${x} breaks into the top 10 — past ${y}, up to № ${r}.`,
            `Top 10, new name: ${x} crosses ${y} for № ${r}.`,
            `${x} moves into the ten, over ${y}. № ${r}.`,
          ]
        : [
            `${x} just crossed ${y}. № ${r} now.`,
            `${x} moves past ${y} — up to № ${r}.`,
            `${y} got crossed. ${x} sits at № ${r}.`,
            `${x} over ${y}. The board shifts: № ${r}.`,
          ];
  return bank[ev.seq % bank.length]!;
}
