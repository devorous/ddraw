/**
 * @fileoverview Per-room in-memory tape of replay preambles, keyed by commit seq.
 *
 * The stroke fingerprint log (`shared/StrokeFingerprint.js`) stores only the
 * bytes of *commit* messages (MU/FILL/SEL_COMMIT/…). A commit like MU is just a
 * marker — a brush stroke's actual geometry travels in the non-committed MM
 * stream, and its appearance depends on the user's tool state (tool/color/size),
 * which may have been set by a CT/CC/CS that predates the checkpoint. So commit
 * bytes alone cannot reconstruct a brush stroke for a *fresh joiner* who never
 * saw the live MM/tool-state chatter.
 *
 * This tape closes that gap. For each stroke it retains a **self-contained
 * preamble**: a snapshot of the user's latest tool-state frames (captured as
 * they flow) followed by the MD and every MM frame, all keyed by the seq the
 * server assigns to that stroke's commit. On join, replaying a tape bundle
 * (preamble frames) followed by the commit bytes (from the fingerprint log)
 * lets the joiner draw the stroke itself through the normal pipeline — no
 * rendered pixels, no new client draw code.
 *
 * A few non-stroke commits also need preambles: FILL/IMG_PASTE depend on the
 * user's current tool state, and selection commits depend on non-commit setup
 * frames such as SEL_LIFT/SEL_MOVE. Those lightweight dependencies are retained
 * here too, under the commit seq that consumes them.
 *
 * Bounding: checkpoint truncation (`truncateBefore`, mirrors the fingerprint
 * log) is the primary bound; a count cap is a backstop. Stored byte arrays must
 * be copies — the encoder reuses its output buffer between messages. Image-tool
 * payloads (brush/pattern/confetti bitmaps) are the one exception to "bundles
 * own their bytes": they are held once in a byte-budgeted store and referenced
 * by handle, so switching brushes in a loop cannot grow the tape without limit,
 * and one brush used by a thousand strokes is stored once. TapeFrameFilter (end
 * of this file) collapses the repeats again on the wire.
 */

/**
 * Tool-state message types whose latest per-user value is snapshotted into a
 * stroke's preamble. Populated from the T enum at construction so this module
 * stays decoupled from import order. These are the `C*` "change" messages.
 */
function buildToolStateSet(T) {
  return new Set([
    T.CT, T.CC, T.CS, T.CP, T.CSP, T.CSM, T.CHD, T.CBR,
    T.CL, T.CBM, T.CF, T.CTHN, T.CSIM, T.CPT,
    // Shape geometry is reconstructed from the drawer's draw mode, so a
    // rectangle/circle in the replayed tail needs it the same way it needs the
    // size or colour. Without it a joiner rebuilt every historical shape with
    // its own default and drew them at the wrong size.
    T.CSDM,
    // The selection MASK is sticky per-user drawing state, NOT selection setup.
    // It clips every subsequent brush/pen/eraser stroke (Board.
    // applySelectionMaskClipForStroke, bound at MD time) and it outlives the
    // Select tool — SelectTool.deactivate() deliberately hands a non-floating
    // mask over to the Board so the user can switch to the brush and draw
    // inside it.
    //
    // It used to live in buildSelectionStateSet, which files a frame under
    // _pendingSelection and only ever emits it in a SELECTION commit's
    // preamble. Brush strokes build their preamble from _toolState + MD + MM,
    // so the mask was never in it: every stroke drawn under a mask replayed
    // UNCLIPPED for anyone who joined or resynced afterwards, while live peers
    // showed it clipped. Silent, permanent divergence — and invisible unless
    // the stroke actually crossed the mask boundary.
    //
    // As tool state it is snapshotted into every stroke's MD preamble, pushed
    // into an already-open stroke on a mid-stroke toggle (see below), and
    // re-sent as latest-state at the end of the join serve. Keyed by `t`, so
    // only the newest mask per user is retained — which is the right
    // semantics, mk=false included.
    T.SEL_MASK,
    // Pattern MODE is a per-user boolean that decides whether fills/selection
    // fills use the pattern tile or the flat colour. Cheap, and meaningless
    // without the pattern payload below.
    T.CPM,
  ]);
}

/**
 * Tool-state types whose payload is an IMAGE (a GIMP brush, a pattern tile, a
 * confetti sprite sheet — base64 data URLs, up to MAX_BRUSH_DATA_LENGTH each).
 *
 * These are tool state in exactly the sense buildToolStateSet means: every
 * imageBrush/pattern/confetti stamp is drawn with whatever payload the drawer
 * last broadcast, so a stroke cannot be reconstructed without it. They were NOT
 * in the tape, so a joiner rebuilt EVERY historical image-brush stroke with the
 * drawer's *current* brush — the server only ever kept the latest one
 * (`user.imageBrush`, sent once by sendImageToolStateToClient at connect), and
 * the tail carried no brush frames at all. Someone who painted with five
 * different brushes got five brushes live and five copies of the last one after
 * a resync.
 *
 * They are held apart from the plain tool-state set only because of their SIZE:
 * frames are retained in a byte-budgeted store (see _retainImageFrame) and
 * bundles reference them indirectly, so a room cannot be made to hold an
 * unbounded pile of 12MB brush payloads by switching brushes in a loop.
 */
function buildImageStateSet(T) {
  return new Set([T.GMP, T.GPT, T.IMAGE_TOOL].filter(t => t !== undefined));
}

function buildSelectionStateSet(T) {
  // SEL_FLIP belongs here: a flip mutates the FLOATING selection and leaves it
  // live (the server's own clearActiveFloatingSelection list deliberately
  // excludes it), so it is setup for the eventual SEL_COMMIT exactly like
  // SEL_MOVE is. It is not a commit — it has no COMMIT_KIND entry, so it is
  // never sequenced or written to the strokeLog — which meant observe() dropped
  // it on the floor and a joiner replayed the commit with an UNFLIPPED image.
  // Pixel diffs missed this for a long time because it only shows up when the
  // selected content is asymmetric enough for the flip to change it.
  // These are appended in order (the list resets only on SEL_LIFT/SEL_PENDING),
  // so two flips replay as two flips and correctly cancel out.
  //
  // SEL_MASK is NOT here — it is tool state, see buildToolStateSet.
  return new Set([T.SEL_LIFT, T.SEL_MOVE, T.SEL_PENDING, T.SEL_FLIP]);
}

/**
 * Commit types that do NOT close an in-flight stroke. History and board-level
 * verbs are commits (they are sequenced and logged) but they own no geometry,
 * so they must not claim the pending MD/MM preamble: doing so filed a stroke's
 * geometry under the UNDO's seq and left the real MU with an empty preamble, so
 * every later joiner replayed the stroke *after* the undo and kept it forever.
 */
function buildNonStrokeCommitSet(T) {
  return new Set([
    T.UNDO, T.REDO, T.CLR,
    T.BOARD_SNAPSHOT_RESTORE, T.BOARD_SNAPSHOT_REGION_RESTORE,
    // Selection commits own no freehand geometry either — their preamble is the
    // SELECTION setup (_buildCommitPreamble), never the MD/MM stream. But the
    // Select tool still broadcasts MD/MM/MU like every other tool (App.js does
    // not gate mouse-down on tool), and a selection commit routinely fires
    // BETWEEN an MD and its MU: clicking outside a floating selection queues MD,
    // then SelectTool.onPointerDown calls commitSelection() -> SEL_COMMIT, and
    // only on release does MU arrive.
    //
    // Without this the `pend && pend.length > 0` branch below claimed that open
    // [toolState, MD] preamble for the SEL_COMMIT, took the early return, and so
    // (a) never built the selection preamble — the joiner replayed the commit
    // with no SEL_LIFT and no trailing SEL_MOVEs, i.e. the selection came back
    // at its previous position/scale — (b) shipped a phantom brush MD under the
    // commit's seq, and (c) skipped the _pendingSelection bookkeeping, leaking
    // those frames into the next commit's bundle.
    T.SEL_COMMIT, T.SEL_DELETE, T.SEL_STAMP, T.SEL_FILL, T.SEL_MERGE
  ].filter(t => t !== undefined));
}

const DEFAULT_CAP = 12_000; // backstop; ≥ the fingerprint log's 10k cap

/**
 * Total bytes of image-tool payloads (brush/pattern/confetti) a single room's
 * tape may retain. Reached only by switching between many DISTINCT images —
 * repeats of one image are a single retained frame referenced by every stroke
 * that used it. Over budget, the oldest frames are dropped (never the frame a
 * user is currently holding), and strokes referencing a dropped frame fall back
 * to the old behaviour: they replay with the drawer's current image.
 */
const DEFAULT_IMAGE_BUDGET_BYTES = 48 * 1024 * 1024;

export class StrokeTape {
  /**
   * @param {Object} T - The message-type enum (shared/MessageTypes.js).
   * @param {Object} [opts]
   * @param {number} [opts.cap] - Max bundles retained (oldest evicted).
   * @param {number} [opts.imageBudgetBytes] - Byte budget for retained image payloads.
   */
  constructor(T, opts = {}) {
    this.T = T;
    this.toolStateTypes = buildToolStateSet(T);
    this.imageStateTypes = buildImageStateSet(T);
    this.selectionStateTypes = buildSelectionStateSet(T);
    this.nonStrokeCommitTypes = buildNonStrokeCommitSet(T);
    this.cap = opts.cap ?? DEFAULT_CAP;
    this.imageBudget = opts.imageBudgetBytes ?? DEFAULT_IMAGE_BUDGET_BYTES;
    /**
     * Latest tool-state entry per user: userId -> Map<stateKey, entry>, where an
     * entry is either raw frame bytes or an {__imageRef} handle into
     * `_imageFrames`. Keyed by state key rather than by `t` because IMAGE_TOOL
     * carries three independent slots (imageBrush/pattern/confetti) under one
     * type — keying those by `t` would let the confetti sprite evict the brush.
     */
    this._toolState = new Map();
    /** In-flight stroke preamble per user: userId -> Array<Uint8Array|ref> */
    this._pending = new Map();
    /**
     * Arrival timestamps running parallel to `_pending` / `_bundles`, one per
     * frame. Purely for the history backfill (server/RoomHistory.js): the join
     * tail replays a preamble as fast as it can and does not care when the
     * frames happened, but a REPLAY does — without per-frame times every frame
     * of a stroke carries only the commit's timestamp, so the whole stroke
     * lands on one instant and pops into existence instead of drawing, with no
     * cursor motion and no preview.
     *
     * Kept as a side table rather than folded into the frame arrays so every
     * existing consumer (getBundle, getPendingBundles, getToolStateBundles,
     * TapeFrameFilter) keeps its `Uint8Array[]` shape untouched.
     * @type {Map<number, number[]>}
     */
    this._pendingTs = new Map();
    /** @type {Map<number, number[]>} Commit seq -> per-frame timestamps. */
    this._bundleTs = new Map();
    /** In-flight selection setup per user: userId -> Uint8Array[] */
    this._pendingSelection = new Map();
    /** Completed bundles: commitSeq -> Array<Uint8Array|ref> (preamble frames, ordered) */
    this._bundles = new Map();
    /** Byte-budgeted store of image-tool payload frames: id -> Uint8Array (oldest first). */
    this._imageFrames = new Map();
    this._imageBytes = 0;
    this._nextImageId = 1;
    /** Identity set of frames the join serve may collapse across bundles. */
    this._dedupableFrames = new WeakSet();
  }

  /**
   * State slot a tool-state frame occupies for its user. IMAGE_TOOL multiplexes
   * three slots on one type, so it needs the payload to tell them apart.
   * @private
   */
  _stateKey(t, payload) {
    if (t === this.T.IMAGE_TOOL) {
      const type = payload?.imageToolType || payload?.image_tool_type || payload?.k || '';
      return `it:${type}`;
    }
    return t;
  }

  /**
   * Retain an image payload frame under the byte budget and return a handle to
   * it. Bundles hold the handle, never the bytes, so eviction actually frees
   * memory instead of leaving the payload alive through a bundle reference.
   * @private
   * @returns {{__imageRef: number}}
   */
  _retainImageFrame(bytes) {
    // An explicit copy, not `.slice()`: in Node the encoder hands back a Buffer,
    // whose slice() is a VIEW onto the allocation it came from. These frames are
    // held for the life of the room's tape, so they must own their memory.
    const copy = new Uint8Array(bytes);
    const id = this._nextImageId++;
    this._imageFrames.set(id, copy);
    this._imageBytes += copy.byteLength;
    this._dedupableFrames.add(copy);
    this._evictImageFrames();
    return { __imageRef: id };
  }

  /** @private Drop oldest image frames until under budget, never a current one. */
  _evictImageFrames() {
    if (this._imageBytes <= this.imageBudget) return;
    const live = new Set();
    for (const st of this._toolState.values()) {
      for (const entry of st.values()) {
        if (entry && entry.__imageRef !== undefined) live.add(entry.__imageRef);
      }
    }
    for (const [id, bytes] of this._imageFrames) {
      if (this._imageBytes <= this.imageBudget) break;
      if (live.has(id)) continue;
      this._imageFrames.delete(id);
      this._imageBytes -= bytes.byteLength;
    }
  }

  /**
   * Resolve a stored preamble into sendable wire frames. Image handles whose
   * frame has been evicted are dropped — the stroke still replays, just with
   * whatever image the receiver last applied for that user.
   * @private
   * @returns {Uint8Array[]}
   */
  _resolveFrames(frames) {
    if (!frames || frames.length === 0) return [];
    let needsResolve = false;
    for (const f of frames) {
      if (f && f.__imageRef !== undefined) { needsResolve = true; break; }
    }
    if (!needsResolve) return frames;

    const out = [];
    for (const f of frames) {
      if (f && f.__imageRef !== undefined) {
        const bytes = this._imageFrames.get(f.__imageRef);
        if (bytes) out.push(bytes);
      } else {
        out.push(f);
      }
    }
    return out;
  }

  /**
   * Whether a resolved frame is one the join serve may skip when the receiver
   * already holds it (see TapeFrameFilter). True only for image payloads: they
   * ride in EVERY stroke's preamble and are the only frames big enough for the
   * repetition to matter.
   * @param {Uint8Array} frame
   * @returns {boolean}
   */
  isDedupableFrame(frame) {
    return this._dedupableFrames.has(frame);
  }

  /**
   * Observe one outgoing room message. Called from the broadcast chokepoint
   * after the seq is assigned and the message is encoded.
   *
   * @param {number} t - Message type (payload.t).
   * @param {number} userId - Originating session index (payload.u | 0).
   * @param {Uint8Array} bytes - Encoded wire bytes (will be copied if retained).
   * @param {number} seq - Server-assigned seq for this message.
   * @param {boolean} isCommit - Whether `t` is a commit type (isCommitType).
   * @param {Object} [payload] - The decoded payload, for types whose state slot
   *   cannot be derived from `t` alone (IMAGE_TOOL).
   */
  observe(t, userId, bytes, seq, isCommit, payload = null) {
    const T = this.T;
    const uid = userId | 0;

    // Track the most recent tool-state frame per user (a single copy each).
    const isImageState = this.imageStateTypes.has(t);
    if (isImageState || this.toolStateTypes.has(t)) {
      let st = this._toolState.get(uid);
      if (!st) { st = new Map(); this._toolState.set(uid, st); }
      const copy = isImageState ? this._retainImageFrame(bytes) : bytes.slice();
      st.set(this._stateKey(t, payload), copy);
      // If a stroke is already in flight, this change also belongs *inside* the
      // stroke's preamble so a joiner replays mid-stroke tool-state changes in
      // order (e.g. scrolling brush size while dragging a circle/rectangle).
      // The MD-time snapshot only captures state as it was at mousedown; without
      // this the stroke is reconstructed with the original size/color/etc.
      const pend = this._pending.get(uid);
      if (pend) { pend.push(copy); this._pendingTs.get(uid)?.push(Date.now()); }
      return;
    }

    if (this.selectionStateTypes.has(t)) {
      let sel = this._pendingSelection.get(uid);
      if (!sel || t === T.SEL_LIFT || t === T.SEL_PENDING) {
        sel = [];
        this._pendingSelection.set(uid, sel);
      }
      sel.push(bytes.slice());
      return;
    }

    if (t === T.MD) {
      // Start a fresh stroke: preamble = current tool-state snapshot, then MD.
      const preamble = [];
      const st = this._toolState.get(uid);
      if (st) for (const b of st.values()) preamble.push(b);
      preamble.push(bytes.slice());
      this._pending.set(uid, preamble);
      // The tool-state snapshot is replayed as an instant at mousedown — the
      // frames may be minutes old, but re-applying them takes no time and the
      // stroke starts here.
      this._pendingTs.set(uid, new Array(preamble.length).fill(Date.now()));
      return;
    }

    if (t === T.MM) {
      const pend = this._pending.get(uid);
      if (pend) { pend.push(bytes.slice()); this._pendingTs.get(uid)?.push(Date.now()); }
      return;
    }

    if (t === T.CANCEL) {
      this._pending.delete(uid);
      this._pendingTs.delete(uid);
      return;
    }

    if (t === T.SEL_CANCEL) {
      this._pendingSelection.delete(uid);
      return;
    }

    // A commit closes the in-flight stroke (if any), filing its geometry under
    // the commit seq. Some non-stroke commits still depend on user state or
    // transient setup frames, so they get a lightweight preamble too.
    if (isCommit) {
      // A history/board verb is sequenced like a commit but owns no geometry —
      // it must leave the in-flight stroke's preamble for that stroke's own MU.
      const pend = this.nonStrokeCommitTypes.has(t) ? null : this._pending.get(uid);
      if (pend && pend.length > 0) {
        this._bundles.set(seq, pend);
        this._bundleTs.set(seq, this._pendingTs.get(uid) || []);
        this._pending.delete(uid);
        this._pendingTs.delete(uid);
        this._enforceCap();
        return;
      }

      const bundle = this._buildCommitPreamble(uid, t);
      if (bundle.length > 0) {
        this._bundles.set(seq, bundle);
        // A fill/paste/selection preamble is setup that replays as one instant
        // at the commit — no geometry unfolds over time here.
        this._bundleTs.set(seq, new Array(bundle.length).fill(Date.now()));
        this._enforceCap();
      }

      if (this._endsSelection(t)) {
        this._pendingSelection.delete(uid);
      } else if (this._continuesSelection(t)) {
        // The float lives on, so KEEP the entry — but empty it. Emptying rather
        // than deleting is the whole trick:
        //
        //   delete  -> the next SEL_MOVE sees no entry and starts a fresh one,
        //              so every later stamp is served without its SEL_LIFT and
        //              rebuilds as nothing (the bug).
        //   re-emit -> carrying the lift in every stamp's bundle instead sends
        //              the same frame N times with the SAME seq, and
        //              SyncClient.replayBuffer dedups by (event, seq) keeping the
        //              LAST copy — which would apply the lift just before the
        //              final stamp and break all the earlier ones.
        //
        // Emptying gives each commit exactly the frames since the previous one,
        // so a full-tail replay reconstructs the real sequence:
        //   [lift, m1, m2] STAMP  [m3, m4] STAMP  [m5] COMMIT
        // The array stays truthy, so the SEL_MOVE branch appends to it instead
        // of resetting (only SEL_LIFT / SEL_PENDING start a new selection).
        this._pendingSelection.set(uid, []);
      }
    }
  }

  _toolStateSnapshot(uid) {
    const st = this._toolState.get(uid);
    return st ? Array.from(st.values()) : [];
  }

  _buildCommitPreamble(uid, t) {
    const T = this.T;
    const toolState = this._toolStateSnapshot(uid);
    const selection = this._pendingSelection.get(uid) || [];

    if (t === T.FILL || t === T.IMG_PASTE) {
      return [...toolState];
    }

    if ((this._endsSelection(t) || this._continuesSelection(t)) && selection.length > 0) {
      return [...toolState, ...selection];
    }

    return [];
  }

  /**
   * Commits that CLOSE the selection: the float is gone afterwards, so its
   * setup frames can be dropped.
   *
   * SEL_FLIP is NOT here: a flip transforms the floating selection in place and
   * the selection stays live until a later commit verb closes it.
   *
   * SEL_STAMP and SEL_FILL are NOT here either, for exactly the same reason —
   * see _continuesSelection. Treating them as terminal is what made "fill an
   * area, then move+stamp it around" vanish for anyone who synced afterwards.
   */
  _endsSelection(t) {
    const T = this.T;
    return t === T.SEL_COMMIT ||
      t === T.SEL_DELETE ||
      t === T.SEL_MERGE;
  }

  /**
   * Commits that KEEP the float alive, so more moves and more commits follow on
   * the SAME selection.
   *
   * `RemoteSelectionHandler.handleSelectionStamp` says it outright — "same as
   * commit but keep floating canvas active for further moves/stamps" — and
   * handleSelectionFill has a dedicated floating-fill branch. Both then open
   * with `if (!user.floatingCanvas || !user.selection) return;`, so a client
   * that never replayed the SEL_LIFT silently no-ops every one of them.
   *
   * Dropping the preamble on the first of these (the old behaviour) meant every
   * later stamp was served with only the moves since the previous commit and no
   * SEL_LIFT, leaving a joiner with no float to stamp — so a fill-then-stamp
   * sequence rebuilt as nothing at all, while live clients showed it perfectly.
   */
  _continuesSelection(t) {
    const T = this.T;
    return t === T.SEL_STAMP || t === T.SEL_FILL;
  }

  _enforceCap() {
    if (this._bundles.size > this.cap) {
      const oldest = this._bundles.keys().next().value;
      this._bundles.delete(oldest);
      this._bundleTs.delete(oldest);
    }
  }

  /**
   * Resolve a stored preamble into sendable frames AND their arrival times,
   * kept index-aligned. Needed because resolution can DROP frames (an image
   * whose payload has since been evicted), which would silently shift a plain
   * parallel timestamp array by one and mis-time the rest of the stroke.
   * @private
   * @param {Array<Uint8Array|{__imageRef: number}>} frames
   * @param {number[]} tsList
   * @returns {{frames: Uint8Array[], ts: number[]}}
   */
  _resolveWithTs(frames, tsList) {
    const outFrames = [];
    const outTs = [];
    if (!frames) return { frames: outFrames, ts: outTs };
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      if (f && f.__imageRef !== undefined) {
        const bytes = this._imageFrames.get(f.__imageRef);
        if (!bytes) continue;
        outFrames.push(bytes);
      } else {
        outFrames.push(f);
      }
      outTs.push(tsList?.[i]);
    }
    return { frames: outFrames, ts: outTs };
  }

  /**
   * Preamble frames for a commit together with their per-frame arrival times.
   * Used by the history backfill, which replays a stroke rather than rushing
   * it. Returns null when the seq has no bundle.
   * @param {number} seq
   * @returns {{frames: Uint8Array[], ts: number[]}|null}
   */
  getBundleWithTs(seq) {
    const frames = this._bundles.get(seq);
    if (!frames) return null;
    return this._resolveWithTs(frames, this._bundleTs.get(seq));
  }

  /**
   * Preamble frames for a commit, or null if none was needed for that seq.
   * @param {number} seq
   * @returns {Uint8Array[]|null}
   */
  getBundle(seq) {
    const frames = this._bundles.get(seq);
    return frames ? this._resolveFrames(frames) : null;
  }

  /**
   * In-flight (uncommitted) stroke preambles, one per user currently mid-stroke.
   * Each bundle is the same shape as a committed bundle (tool-state snapshot +
   * MD + the MM frames seen so far) but has no closing commit yet. A fresh
   * joiner replays these AFTER the committed tail so it re-begins each active
   * stroke with the correct tool state (incl. blend mode) and partial geometry;
   * the live MM/MU continuation then lands on that already-open stroke instead
   * of a lazily-created source-over one.
   * @returns {Array<{userId: number, frames: Uint8Array[]}>}
   */
  getPendingBundles() {
    const out = [];
    for (const [userId, frames] of this._pending) {
      if (frames && frames.length > 0) out.push({ userId, frames: this._resolveFrames(frames) });
    }
    return out;
  }

  /**
   * Latest tool-state frames per user (the running per-user snapshot). Sent at
   * the END of a join serve so the joiner leaves sync with every user's
   * CURRENT tool state. This closes the join-suppression hole: a tool-state
   * frame broadcast while the joiner's live feed was suppressed, for a stroke
   * that had not yet begun at the barrier, is in neither the committed tail
   * (no commit yet) nor a pending bundle (no MD yet) — without this resend the
   * joiner renders that user's next stroke with stale color/size/tool.
   * @returns {Array<{userId: number, frames: Uint8Array[]}>}
   */
  getToolStateBundles() {
    const out = [];
    for (const [userId, st] of this._toolState) {
      if (st.size > 0) out.push({ userId, frames: this._resolveFrames(Array.from(st.values())) });
    }
    return out;
  }

  /**
   * Drop bundles with seq < cutoffSeq. Mirrors StrokeFingerprintLog.truncateBefore
   * so the geometry tape and the commit log stay bounded together at checkpoints.
   * Keys are inserted in ascending seq order, so we can stop at the first kept key.
   *
   * Returns the dropped preambles keyed by seq, with image handles already
   * RESOLVED to bytes. Resolution has to happen here, at the moment of
   * retirement: bundles hold `{__imageRef}` handles into a byte-budgeted store
   * that keeps evicting after this point, so a caller archiving the raw handles
   * (server/RoomHistory.js) would end up holding references to brushes that no
   * longer exist and replay every historical stamp with the wrong image.
   *
   * @param {number} cutoffSeq
   * @returns {Map<number, {frames: Uint8Array[], ts: number[]}>} dropped
   *   preambles by commit seq, with per-frame arrival times
   */
  truncateBefore(cutoffSeq) {
    const dropped = new Map();
    for (const k of this._bundles.keys()) {
      if (k >= cutoffSeq) break;
      const frames = this._bundles.get(k);
      if (frames && frames.length > 0) {
        dropped.set(k, this._resolveWithTs(frames, this._bundleTs.get(k)));
      }
      this._bundles.delete(k);
      this._bundleTs.delete(k);
    }
    return dropped;
  }

  /**
   * Whether this user currently has an open stroke (an MD with no matching
   * commit yet). Used to tell a DRAWING move from a hover move: the former is
   * already retained in the user's pending preamble and will ship with the
   * stroke's commit, the latter belongs to nobody and is otherwise dropped.
   * @param {number} userId
   * @returns {boolean}
   */
  isMidStroke(userId) {
    const frames = this._pending.get(userId | 0);
    return !!frames && frames.length > 0;
  }

  /** Discard any in-flight (uncommitted) stroke geometry for a departed user. */
  dropUser(userId) {
    const uid = userId | 0;
    this._pending.delete(uid);
    this._pendingTs.delete(uid);
    this._toolState.delete(uid);
    this._pendingSelection.delete(uid);
    // Their image payloads are no longer pinned as "current", so they become
    // evictable — bundles that still reference them keep replaying until then.
    this._evictImageFrames();
  }

  /** Wipe everything (room reset). */
  clear() {
    this._toolState.clear();
    this._pending.clear();
    this._pendingTs.clear();
    this._pendingSelection.clear();
    this._bundles.clear();
    this._bundleTs.clear();
    this._imageFrames.clear();
    this._imageBytes = 0;
  }

  /** @returns {{bundles: number, pending: number, pendingSelection: number, trackedUsers: number, imageFrames: number, imageBytes: number}} */
  getSummary() {
    return {
      bundles: this._bundles.size,
      pending: this._pending.size,
      pendingSelection: this._pendingSelection.size,
      trackedUsers: this._toolState.size,
      imageFrames: this._imageFrames.size,
      imageBytes: this._imageBytes,
    };
  }
}

/**
 * Collapses repeated image-tool payloads across one serve (a join tail, an
 * in-flight bundle set, a parity resync batch).
 *
 * Every stroke's preamble carries a snapshot of its drawer's tool state, image
 * payloads included — that is the whole point, it is what makes a stroke
 * replayable with the brush it was actually drawn with. But the payloads are
 * base64 images: sending one per stroke would turn a 200-stroke tail into
 * hundreds of megabytes. They are also idempotent state setters, so a frame the
 * receiver is already holding can simply be skipped.
 *
 * Per user, the frames from the last preamble emitted are the receiver's
 * current image state (a preamble is always a COMPLETE snapshot of that user's
 * tool state). Skip anything still in that set; anything else is a real change
 * and goes out. Runs of one brush collapse to a single frame, and a switch back
 * to an earlier brush is a fresh broadcast with its own bytes, so it is sent
 * again rather than being wrongly deduped.
 */
export class TapeFrameFilter {
  /** @param {StrokeTape|null} tape */
  constructor(tape) {
    this.tape = tape;
    /** userId -> Set<Uint8Array> currently applied on the receiver */
    this._applied = new Map();
    this.skipped = 0;
  }

  /**
   * @param {number} userId - Author of the preamble.
   * @param {Uint8Array[]|null} frames - Resolved preamble frames.
   * @returns {Uint8Array[]} The frames that still need to be sent, in order.
   */
  filter(userId, frames) {
    if (!frames || frames.length === 0) return [];
    if (!this.tape?.isDedupableFrame) return frames;

    const uid = userId | 0;
    const applied = this._applied.get(uid);
    let next = null;
    const out = [];
    for (const frame of frames) {
      if (this.tape.isDedupableFrame(frame)) {
        if (!next) next = new Set();
        next.add(frame);
        if (applied?.has(frame)) { this.skipped++; continue; }
      }
      out.push(frame);
    }
    // Only a preamble that actually carried image state redefines what the
    // receiver holds; one without any (a user who has never used an image tool)
    // must not wipe the record and cause a re-send on the next stroke.
    if (next) this._applied.set(uid, next);
    return out;
  }
}
