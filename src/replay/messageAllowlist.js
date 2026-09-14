/**
 * @fileoverview Allowlist of message types that belong on the replay tape.
 *
 * Only mutating-action messages are recorded — status pings, presence ticks,
 * auth/mod/admin RPC, sync handshake traffic, etc. are excluded both to keep
 * the tape small and to avoid replaying messages that have no
 * RemoteUserHandler behaviour.
 *
 * Any message not in this set is silently dropped by Recorder.
 */
import { T } from '../../shared/MessageTypes.js';

/** @type {Set<number>} */
export const REPLAY_MESSAGE_ALLOWLIST = new Set([
  // Drawing core
  T.MD, T.MU, T.MM,
  T.CT, T.CC, T.CS, T.CP, T.CSP, T.CSM, T.CTHN, T.CSIM, T.CPT,

  // Tool/layer/pattern/blend state
  T.CL, T.CBM, T.CBR, T.CN, T.CF, T.GPT, T.GMP, T.CPM, T.CSDM, T.CHD,

  // Selection
  T.SEL_LIFT, T.SEL_MOVE, T.SEL_COMMIT, T.SEL_CANCEL, T.SEL_DELETE,
  T.SEL_FILL, T.SEL_STAMP, T.SEL_TO_BRUSH, T.SEL_FLIP, T.SEL_PENDING,
  T.SEL_MASK, T.SEL_MERGE,

  // Misc actions
  T.IMG_PASTE, T.FILL, T.TEXT_APPLY, T.TEXT_REMOVE,
  T.OBSCURE_REGION, T.GLITCH_RESULT,

  // History
  T.UNDO, T.REDO,

  // Room/board state
  T.SETTINGS, T.MIRROR_REGION, T.MIR, T.CLR, T.KP, T.PAN, T.CANCEL,

  // Board snapshot restore ("undo to here" / moderator restore) and its region
  // variant ("undo region to here"). Recorded so the replay re-applies the
  // reverted state as a timeline event instead of leaving the tape inconsistent
  // — keeps history before AND after the undo point (region restore no longer
  // resets the rolling tape; it lands as a delta and replays like everything else).
  T.BOARD_SNAPSHOT_RESTORE, T.BOARD_SNAPSHOT_REGION_RESTORE,

  // Chat (visible in replay)
  T.MSG,
]);

/** @param {{ t: number } | null | undefined} msg */
export function shouldRecord(msg) {
  return !!msg && REPLAY_MESSAGE_ALLOWLIST.has(msg.t);
}
