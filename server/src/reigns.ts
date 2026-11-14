// REIGNS — who has held the crown, and for how long.
//
// The plays table is the whole record: every play carries the points it
// earned (bonuses included) and the server time it landed. Replaying it
// in order, under the board's own ordering (score, then finishes, then
// earliest claim), rebuilds every reign the board has ever had — judged
// on today's record, so a re-judged or removed play rewrites reign
// history exactly the way it rewrote the score. No points are minted
// here; a reign is just the record read back.

export interface ReignPlay {
  listenerId: number;
  points: number;
  finished: number; // 0 | 1
  playedAtMs: number;
}

export interface ReignStat {
  /** Total time at № 1 — closed reigns plus the open one — in ms. */
  champMs: number;
  /** How many separate reigns this listener has held. */
  reigns: number;
  /** Epoch ms the current reign began; 0 when not reigning. */
  reignSinceMs: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeReigns(
  plays: ReignPlay[], // pre-sorted by (playedAtMs, insertion order)
  createdAtById: Map<number, number>,
  nowMs: number,
): Map<number, ReignStat> {
  const totals = new Map<number, { score: number; finishes: number }>();
  const stats = new Map<number, ReignStat>();
  const stat = (id: number): ReignStat => {
    let s = stats.get(id);
    if (!s) {
      s = { champMs: 0, reigns: 0, reignSinceMs: 0 };
      stats.set(id, s);
    }
    return s;
  };
  // Strictly ahead under the board ordering: score, then finishes, then
  // the earlier claim wins a full tie.
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

  let leaderId = 0;
  let leaderSinceMs = 0;

  for (const p of plays) {
    const t = totals.get(p.listenerId) ?? { score: 0, finishes: 0 };
    t.score = round2(t.score + p.points);
    t.finishes += p.finished === 1 ? 1 : 0;
    totals.set(p.listenerId, t);
    // Points get you on the board; no points, no crown.
    if (t.score <= 0) continue;

    if (leaderId === 0) {
      leaderId = p.listenerId;
      leaderSinceMs = p.playedAtMs;
      stat(leaderId).reigns += 1;
      continue;
    }
    if (p.listenerId === leaderId) continue;
    const leader = totals.get(leaderId);
    if (leader && ahead(p.listenerId, t, leaderId, leader)) {
      stat(leaderId).champMs += p.playedAtMs - leaderSinceMs;
      leaderId = p.listenerId;
      leaderSinceMs = p.playedAtMs;
      stat(leaderId).reigns += 1;
    }
  }

  if (leaderId !== 0) {
    const cur = stat(leaderId);
    cur.champMs += Math.max(0, nowMs - leaderSinceMs);
    cur.reignSinceMs = leaderSinceMs;
  }
  return stats;
}
