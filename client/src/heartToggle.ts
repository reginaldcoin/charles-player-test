/**
 * The heart toggle state machine, framework-free so it can be driven
 * directly in a test. The bug it exists to kill: the heart used to
 * render only the server's saved state, so a tap showed nothing until
 * the toggle POST and the road refetch both landed. That dead window
 * invited a second tap, and the second tap — arriving after the first
 * save — read as an un-heart. Liking a song took three taps.
 *
 * The shape now: a tap is optimistic. The display flips the moment
 * the tap lands, before the network moves. While a save for a track
 * is in flight, further taps on that track are dropped: the pending
 * intent wins, and a late tap can never flip the state back. When the
 * save settles, the override clears and the display reconciles with
 * the server's answer — on success that is the fresh saved state; on
 * failure the same clear rolls the display back to the truth, so the
 * heart never claims a save that did not happen.
 */

export type HeartArgs = { trackTitle: string; project: string };

/** Performs the save. Must resolve only once the caller's source of
 *  truth (the road query) reflects the server's answer, and reject on
 *  any failure, including an ok:false response. */
export type HeartSend = (args: HeartArgs) => Promise<void>;

const keyOf = (a: HeartArgs) => `${a.trackTitle}\n${a.project}`;

export function createHeartToggleCore(send: HeartSend, notify: () => void) {
  const overrides = new Map<string, boolean>();
  const inFlight = new Set<string>();
  return {
    /** What the listener sees: the pending intent while a save is in
     *  flight for this track, else the saved truth. */
    display(saved: boolean, args: HeartArgs): boolean {
      return overrides.get(keyOf(args)) ?? saved;
    },
    isPending(args: HeartArgs): boolean {
      return inFlight.has(keyOf(args));
    },
    /** One tap. Flips the display immediately; a tap that arrives
     *  while this track's save is in flight is dropped whole. */
    toggle(args: HeartArgs, saved: boolean): void {
      const key = keyOf(args);
      if (inFlight.has(key)) return;
      inFlight.add(key);
      overrides.set(key, !saved);
      notify();
      const settle = () => {
        inFlight.delete(key);
        overrides.delete(key);
        notify();
      };
      send(args).then(settle, settle);
    },
  };
}

export type HeartToggleCore = ReturnType<typeof createHeartToggleCore>;
