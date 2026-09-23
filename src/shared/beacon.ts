/**
 * BEACON KINDS, one list for both ends (b1-bugs-02).
 *
 * The client's `reportBeacon(kind)` and the server's `/beacon` allowlist used
 * to keep separate lists; they drifted and the server refused frame-fault,
 * frame-wedged and webglcontextrestored, the reports the frame guard exists to
 * send. Both sides now read this tuple: the client derives its `BeaconKind`
 * type from it and the server builds its allowlist from it.
 */
export const BEACON_KINDS = [
  'error', 'rejection', 'frame-fault', 'frame-wedged',
  'webglcontextlost', 'webglcontextrestored', 'longload', 'fps-floor',
] as const;

export type BeaconKind = (typeof BEACON_KINDS)[number];
