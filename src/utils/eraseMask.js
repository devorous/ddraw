/**
 * @fileoverview Hardened erase masks for selection clear/cut/move.
 *
 * A selection erase is a `destination-out` stroke: the shape is painted white
 * into the stroke canvas and that canvas' ALPHA is what gets subtracted at
 * composite time. Canvas antialiases every non-pixel-aligned edge, so an edge
 * pixel covered `a` of the way through is painted at alpha `a` — and
 * destination-out then leaves `a·(1−a)` of the original colour behind. At the
 * worst (a = 0.5) a quarter of the pixel survives.
 *
 * On its own that is invisible, but Fill paints the SAME antialiased shape, so
 * filling a selection and clearing it leaves a faint outline of the fill
 * colour tracing the selection. Cut and move leave the same rim.
 *
 * The fix is to erase a hardened mask: any pixel the shape touched at all goes
 * to full alpha before it is used as the erase source, so the erase removes
 * exactly the pixels the matching fill could have painted. Hardening is done by
 * compositing the mask onto itself — each pass takes alpha `a` to `a·(2−a)`,
 * which converges on 1 for every non-zero coverage and leaves untouched pixels
 * at 0. That keeps it a handful of GPU blits with no `getImageData` readback of
 * a potentially board-sized region.
 */

/**
 * Passes of self-compositing. Alpha per pass: a → a·(2−a). Ordinary antialiased
 * edges (a ≈ 0.2–0.8) saturate in about five; 1/255, the faintest coverage an
 * 8-bit backing store can even hold, needs eleven. Twelve covers everything
 * with headroom and is still only twelve blits of the selection.
 */
const HARDEN_PASSES = 12;

/**
 * Paints an erase shape into `targetCtx` with every touched pixel forced to
 * full alpha.
 *
 * The shape is drawn into a scratch mask the size of `dirty` — which also
 * clips it, matching the crop `commitUserStroke` applies to the stroke's dirty
 * rect — hardened, then blitted into the target in one go.
 *
 * @param {CanvasRenderingContext2D} targetCtx - Erase stroke canvas, in board coordinates.
 * @param {{x:number,y:number,width:number,height:number}} dirty - Board-space
 *   area the erase covers, including any mirrored copies.
 * @param {(ctx: CanvasRenderingContext2D) => void} paint - Draws the shape(s) in
 *   BOARD coordinates. The ctx it receives is pre-translated, so callers use the
 *   same coordinates they would on the target.
 * @param {{x:number,y:number}} [targetOrigin] - `targetCtx`'s canvas's own
 *   board-absolute origin, when it's a windowed (non-full-board) active-stroke
 *   canvas — see `windowed_canvas_needs_ctx_translate` memory. Omitted (default)
 *   for a full-board target, matching the identity-origin behavior this always had.
 * @returns {boolean} false when `dirty` is empty and nothing was painted.
 */
export function paintHardenedEraseMask(targetCtx, dirty, paint, targetOrigin = null) {
  if (!targetCtx || !dirty || typeof paint !== 'function') return false;

  const x0 = Math.floor(dirty.x);
  const y0 = Math.floor(dirty.y);
  const width = Math.ceil(dirty.x + dirty.width) - x0;
  const height = Math.ceil(dirty.y + dirty.height) - y0;
  if (!(width > 0) || !(height > 0)) return false;

  const mask = document.createElement('canvas');
  mask.width = width;
  mask.height = height;
  const maskCtx = mask.getContext('2d');

  // Board space → mask space. Mirror transforms are applied with ctx.transform
  // (relative), so they compose with this translate rather than replacing it.
  maskCtx.translate(-x0, -y0);
  maskCtx.fillStyle = 'white';
  paint(maskCtx);
  maskCtx.setTransform(1, 0, 0, 1, 0, 0);

  for (let i = 0; i < HARDEN_PASSES; i++) maskCtx.drawImage(mask, 0, 0);

  const tox = targetOrigin?.x ?? 0;
  const toy = targetOrigin?.y ?? 0;
  targetCtx.save();
  targetCtx.setTransform(1, 0, 0, 1, 0, 0);
  targetCtx.globalAlpha = 1;
  targetCtx.globalCompositeOperation = 'source-over';
  targetCtx.drawImage(mask, x0 - tox, y0 - toy);
  targetCtx.restore();
  return true;
}

/**
 * Whether an erase shape can produce antialiased (partially covered) pixels and
 * therefore needs {@link paintHardenedEraseMask}. An axis-aligned rectangle on
 * integer bounds is pixel-exact and erases cleanly on its own.
 *
 * @param {Array<{x:number,y:number}>|null} lassoPath
 * @param {Array<Object>} [mirrorTargets] - From `Board.getSelectionMirrorTargets`;
 *   mirror matrices rotate and scale, so any copy can land off the pixel grid.
 * @param {{x:number,y:number,width:number,height:number}|null} [rect] - The
 *   rectangle being erased, when the caller has not already snapped it to integers.
 * @returns {boolean}
 */
export function needsHardenedEraseMask(lassoPath, mirrorTargets = [], rect = null) {
  if (lassoPath && lassoPath.length >= 3) return true;
  if (mirrorTargets && mirrorTargets.length > 0) return true;
  if (rect && !(
    Number.isInteger(rect.x) && Number.isInteger(rect.y) &&
    Number.isInteger(rect.width) && Number.isInteger(rect.height)
  )) return true;
  return false;
}
