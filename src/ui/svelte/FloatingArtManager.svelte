<script module>
  // Card details (author, title, thumbnail, hearts) by gallery id. Shared by every mount this
  // session, so remounting the wall (reconnect, board resize) doesn't fetch them again.
  const metaCache = new Map();
</script>

<script>
  import { tick } from 'svelte';
  import { appState } from '../../state.svelte.js';
  import { ClientIdentity } from '../../network/ClientIdentity.js';
  import {
    FloatingWallSim,
    clampToLeash,
    wipShelfLayout,
    WIP_SHELF,
    WALL_CARD_W,
    WALL_CARD_H,
    WALL_TICK_MS,
    WALL_THROW_MAX
  } from '../../../shared/floatingWallSim.js';
  import FloatingArt from './FloatingArt.svelte';

  /**
   * The room's floating art wall and works-in-progress shelf.
   *
   * The server computes the room's layout (server/floatingWall.js) and sends only ids and
   * positions; card details come in batches from /api/gallery/wall-meta for cards near the screen.
   * Dragging is local: this client runs its own FloatingWallSim seeded with the room's layout, so
   * neighbours shove aside and throws glide without the server. A local arrangement lasts until the
   * server moves those pieces or the user presses Reset layout.
   *
   * Slow mode (low power / mobile): no local sim, a dragged card just stays where it's dropped, and
   * cards glide without shadows. Shelf pieces are dragged back onto the board through `onWipPlace`.
   *
   * @type {{
   *   roomId: string,
   *   enabled: boolean,
   *   slowMode?: boolean,
   *   showDetachFlights?: boolean,
   *   isCanvasFlipped?: () => boolean,
   *   wsClient?: any,
   *   toBoardPoint?: (clientX: number, clientY: number) => { x: number, y: number },
   *   clientDeviceId?: string,
   *   apiBaseUrl?: string,
   *   onLike?: (item: any, deviceId: string) => Promise<any>,
   *   onComment?: (id: string) => void,
   *   onAuthorClick?: (username: string) => void,
   *   onWipPlace?: (item: { id: string, owner: string, w: number, h: number }, x: number, y: number) => Promise<boolean>,
   *   onToast?: (message: string, ms?: number, type?: string) => void,
   *   getBoardZoom?: () => number
   * }}
   */
  let {
    roomId,
    enabled = true,
    slowMode = false,
    showDetachFlights = true,
    isCanvasFlipped = null,
    wsClient = null,
    toBoardPoint = null,
    clientDeviceId = '',
    apiBaseUrl = '',
    onLike = null,
    onComment = null,
    onAuthorClick = null,
    onWipPlace = null,
    onToast = null,
    getBoardZoom = null
  } = $props();

  // Moves a node to <body>. Anything inside #boards stacks under the board canvas, so a ghost
  // dragged over the board would disappear behind it.
  function portal(node) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }

  const DRAG_START_PX = 5;
  // A fingertip wobbles more than a mouse before it means to drag
  const TOUCH_DRAG_START_PX = 10;
  const THROW_KEEP = 0.3;
  const THROW_SAMPLE_MS = 80;
  // A local step that moves a card further than a tick can is a swap or the settle cleanup
  const JUMP_PX = 70;
  const DELETE_CONFIRM_MS = 3000;
  // Hiding a piece from the wall (server checks the same)
  const ROLE_MOD = 4;
  const CLICK_SUPPRESS_MS = 350;
  const POINTER_CLICK_SUPPRESS_MS = 400;
  // The local sim's only holder
  const LOCAL_HOLDER = 'local';
  // Card details: ids per request, and how long requests from cards scrolling into view pool up
  const META_BATCH = 50;
  const META_FLUSH_MS = 40;
  // A detach flight waits this long for its shelf card before giving up
  const FLIGHT_WAIT_MS = 5000;
  const FLIGHT_LIFT_AT = 0.16;
  const FLIGHT_STEPS = 12;
  const LAND_MS = 420;
  // .wip-image padding (board px)
  const WIP_IMAGE_PAD = 8;

  const clientIdentity = new ClientIdentity();

  /**
   * `sx`/`sy` are the room's position; `x`/`y` are what's drawn, which differ while this user
   * drags or after they moved a piece (`local`). `item` is null until its details load.
   * @type {Array<{ id: string, group: number, item: any, x: number, y: number, sx: number, sy: number, active: boolean, jump: boolean, local: boolean }>}
   */
  let pieces = $state([]);
  /** id → the reactive piece in `pieces` */
  let pieceById = new Map();
  let likedIds = $state(new Set());
  let draggingId = $state(null);
  let boardWidth = $state(0);
  let boardHeight = $state(0);
  /** @type {Array<{ id: string, owner: string, w: number, h: number, canManage: boolean, claimed: boolean }>} */
  let wipItems = $state([]);
  let wipDrag = $state(null);
  let pendingDeleteId = $state(null);
  let pendingHideId = $state(null);
  let hideConfirmTimer = null;
  // Live, so a promotion or demotion shows or removes the hide buttons without a remount
  let canHide = $derived(Math.max(appState.selfRole || 0, appState.selfRoomRole || 0, appState.selfGlobalRole || 0) >= ROLE_MOD);
  let revision = -1;
  let drag = null;
  let suppressClickUntil = 0;
  let deleteConfirmTimer = null;
  let lastWipDeleteTapAt = 0;
  let lastResetTapAt = 0;
  let cardsElement = $state(null);
  // Detached art flying to the shelf: its card stays hidden until the flight lands, then bounces
  let arrivingIds = $state(new Set());
  let landedId = $state(null);
  let landedTimer = null;
  /** id → { ghost: HTMLImageElement, rect, ready: Promise, launching? }, waiting for the image and its shelf card */
  const pendingFlights = new Map();
  const flightElements = new Set();
  /** @type {FloatingWallSim|null} this user's own copy of the wall, awake only while they drag or throw */
  let localSim = null;
  let localTimer = null;
  const pendingMeta = new Set();
  const inflightMeta = new Set();
  let metaFlushTimer = null;

  let shelf = $derived(wipShelfLayout(wipItems.length, boardWidth, boardHeight));
  let hasLocalMoves = $derived(pieces.some(p => p.local));

  function send(payload) {
    wsClient?.sendFloatingWall?.(payload);
  }

  function handleWallMessage({ json, pos }) {
    let msg;
    try {
      msg = JSON.parse(json);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.a) {
      case 'state':
        applyState(msg, pos);
        break;
      case 'pos':
        if (msg.r === revision) applyPositions(pos);
        break;
      case 'likes':
        setPieceLikes(msg.id, msg.n);
        break;
      case 'wip':
        wipItems = Array.isArray(msg.items) ? msg.items : [];
        launchPendingFlights();
        break;
      case 'fly':
        // Someone else detached art: fly the stored shelf image from where it was on the board
        if (typeof msg.id === 'string') flyToShelf(msg.id, `${apiBaseUrl}/api/wip/${msg.id}`, msg);
        break;
    }
  }

  function applyState(msg, pos) {
    if (!Array.isArray(msg.ids)) return;
    revision = msg.r;
    boardWidth = msg.w || 0;
    boardHeight = msg.h || 0;
    const placedAt = new Map();
    for (let k = 0; k + 2 < pos.length; k += 3) placedAt.set(pos[k], [pos[k + 1], pos[k + 2]]);

    const previous = pieceById;
    pieces = msg.ids.map((id, index) => {
      const old = previous.get(id);
      const at = placedAt.get(index);
      const sx = at ? at[0] : (old?.sx ?? 0);
      const sy = at ? at[1] : (old?.sy ?? 0);
      const held = !!(drag?.moved && drag.id === id && old);
      // A local move survives a membership change unless the room's layout moved that piece meanwhile
      const keepLocal = !!old?.local && (!at || (at[0] === old.sx && at[1] === old.sy));
      return {
        id,
        group: Array.isArray(msg.g) ? msg.g[index] : index,
        item: metaCache.get(id) || null,
        x: held || keepLocal ? old.x : sx,
        y: held || keepLocal ? old.y : sy,
        sx,
        sy,
        active: !!at || !!old?.active,
        jump: false,
        local: keepLocal || held
      };
    });
    pieceById = new Map(pieces.map(p => [p.id, p]));
    syncLocalSim();

    if (drag) {
      drag.piece = pieceById.get(drag.id) || null;
      if (!drag.piece) cancelDrag();
    }
  }

  // A new layout from the room: everything it moved glides there, local arrangements included
  function applyPositions(pos) {
    let newlyPlaced = false;
    for (let k = 0; k + 2 < pos.length; k += 3) {
      const piece = pieces[pos[k]];
      if (!piece) continue;
      const x = pos[k + 1], y = pos[k + 2];
      piece.sx = x;
      piece.sy = y;
      // The dragging user trusts their own pointer for the piece they hold
      if (drag?.moved && drag.id === piece.id) continue;
      piece.local = false;
      piece.jump = !slowMode && piece.active;
      piece.x = x;
      piece.y = y;
      if (piece.active) {
        localSim?.place(piece.id, x, y);
      } else {
        piece.active = true;
        newlyPlaced = true;
      }
    }
    if (newlyPlaced) syncLocalSim();
  }

  // --- Local physics ---

  function syncLocalSim() {
    if (slowMode) return;
    if (!localSim) localSim = new FloatingWallSim({ boardWidth, boardHeight });
    localSim.setBoard(boardWidth, boardHeight);
    const active = pieces.filter(p => p.active);
    localSim.setPieces(
      active.map(p => ({ id: p.id, group: `g${p.group}`, likes: p.item?.likesCount || 0 })),
      new Map(active.map(p => [p.id, { x: p.x, y: p.y }]))
    );
    // The room's layout arrives settled; only this user's own drags should set the local wall moving
    if (!localTimer) localSim.freeze();
  }

  function runLocalSim() {
    if (!localTimer && localSim?.awake) localTimer = setInterval(stepLocalSim, WALL_TICK_MS);
  }

  function stopLocalSim() {
    clearInterval(localTimer);
    localTimer = null;
  }

  function stepLocalSim() {
    if (!localSim) return stopLocalSim();
    // Holding still is still holding: refresh the hold so the sim doesn't drop the piece
    if (drag?.held) localSim.dragTo(drag.id, LOCAL_HOLDER, drag.targetX, drag.targetY);
    const { moved } = localSim.step();
    for (const simPiece of moved) showLocalPosition(simPiece);
    if (!localSim.awake) stopLocalSim();
  }

  function showLocalPosition(simPiece) {
    const piece = pieceById.get(simPiece.id);
    if (!piece) return;
    piece.jump = Math.hypot(simPiece.x - piece.x, simPiece.y - piece.y) > JUMP_PX;
    piece.x = simPiece.x;
    piece.y = simPiece.y;
    piece.local = Math.abs(piece.x - piece.sx) > 0.5 || Math.abs(piece.y - piece.sy) > 0.5;
  }

  // Everything back where the room has it
  function resetLayout() {
    cancelDrag();
    stopLocalSim();
    for (const piece of pieces) {
      if (!piece.local) continue;
      piece.jump = true;
      piece.x = piece.sx;
      piece.y = piece.sy;
      piece.local = false;
      localSim?.place(piece.id, piece.sx, piece.sy);
    }
    localSim?.freeze();
  }

  function handleResetPointerUp(e) {
    if (e.pointerType === 'mouse') return;
    lastResetTapAt = performance.now();
    e.preventDefault();
    resetLayout();
  }

  function handleResetClick() {
    if (performance.now() - lastResetTapAt < POINTER_CLICK_SUPPRESS_MS) return;
    resetLayout();
  }

  // --- Card details ---

  function toMeta(entry) {
    return {
      id: entry.id,
      url: entry.url,
      thumbUrl: entry.thumbUrl || entry.url,
      author: entry.author,
      hasProfile: !!entry.authorHasProfile,
      title: entry.title || '',
      likesCount: entry.likesCount || 0,
      animatedUrl: entry.animatedUrl || null
    };
  }

  // Called by each card as it nears the screen; requests pool up and go out in batches
  function requestMeta(id) {
    if (!id || metaCache.has(id) || inflightMeta.has(id)) return;
    pendingMeta.add(id);
    if (!metaFlushTimer) metaFlushTimer = setTimeout(flushMeta, META_FLUSH_MS);
  }

  async function flushMeta() {
    metaFlushTimer = null;
    const ids = [...pendingMeta].slice(0, META_BATCH);
    for (const id of ids) {
      pendingMeta.delete(id);
      inflightMeta.add(id);
    }
    if (pendingMeta.size) metaFlushTimer = setTimeout(flushMeta, 0);
    if (!ids.length) return;
    try {
      const response = await fetch(`${apiBaseUrl}/api/gallery/wall-meta?ids=${ids.join(',')}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      for (const entry of Array.isArray(data?.items) ? data.items : []) {
        if (!entry?.id) continue;
        const meta = toMeta(entry);
        metaCache.set(meta.id, meta);
        const piece = pieceById.get(meta.id);
        if (piece) piece.item = meta;
        const simPiece = localSim?.byId.get(meta.id);
        if (simPiece) simPiece.likes = meta.likesCount;
      }
    } catch (err) {
      console.error('[FloatingArt] Card details fetch error:', err);
    } finally {
      for (const id of ids) inflightMeta.delete(id);
    }
  }

  function setPieceLikes(id, likesCount) {
    if (typeof likesCount !== 'number') return;
    const meta = metaCache.get(id);
    if (meta) metaCache.set(id, { ...meta, likesCount });
    const piece = pieceById.get(id);
    if (piece?.item) piece.item = { ...piece.item, likesCount };
    const simPiece = localSim?.byId.get(id);
    if (simPiece) simPiece.likes = likesCount;
  }

  function setLiked(id, liked) {
    const next = new Set(likedIds);
    if (liked) next.add(id);
    else next.delete(id);
    likedIds = next;
  }

  async function likeFloatingItem(item) {
    if (!item?.id || !onLike) return;

    const wasLiked = likedIds.has(item.id);
    const previousCount = pieceById.get(item.id)?.item?.likesCount ?? item.likesCount ?? 0;
    setLiked(item.id, !wasLiked);
    setPieceLikes(item.id, Math.max(0, previousCount + (wasLiked ? -1 : 1)));

    try {
      const data = await onLike(item, clientDeviceId || clientIdentity.deviceId || '');
      setLiked(item.id, !!data?.liked);
      setPieceLikes(item.id, data?.likesCount);
    } catch {
      setLiked(item.id, wasLiked);
      setPieceLikes(item.id, previousCount);
    }
  }

  // Mod+: first tap arms, second tap within 3 s hides it for the whole room
  async function hideFloatingItem(item) {
    if (!item?.id || !canHide) return;
    clearTimeout(hideConfirmTimer);
    if (pendingHideId !== item.id) {
      pendingHideId = item.id;
      hideConfirmTimer = setTimeout(() => { pendingHideId = null; }, DELETE_CONFIRM_MS);
      return;
    }
    pendingHideId = null;
    const result = await wsClient?.requestFloatingWall?.({ a: 'hide', id: item.id });
    if (result?.ok) {
      onToast?.('Hidden from the floating gallery. Unhide it in Room Settings → Floating Gallery.', 4000);
    } else {
      onToast?.(result?.error || 'Could not hide that piece', 3000, 'error');
    }
  }

  async function fetchLikedIds() {
    const token = localStorage.getItem('topDrawAuthToken');
    if (!token) return;
    try {
      const response = await fetch(`${apiBaseUrl}/api/gallery/liked-ids`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) return;
      const data = await response.json();
      likedIds = new Set(Array.isArray(data?.ids) ? data.ids : []);
    } catch (err) {
      console.error('[FloatingArt] Liked ids fetch error:', err);
    }
  }

  // A drag that ends over a card's image or name is not a tap. On touch the card's own pointerup
  // runs before the window's, so an in-progress drag counts too.
  function isClickSuppressed() {
    return !!drag?.moved || performance.now() < suppressClickUntil;
  }

  // --- Floating wall drag (local only) ---

  function handleCardPointerDown(piece, e) {
    if (drag || wipDrag || !toBoardPoint) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target?.closest?.('.like-btn, .art-author-link, .hide-btn')) return;
    e.stopPropagation();
    const point = toBoardPoint(e.clientX, e.clientY);
    drag = {
      id: piece.id,
      piece,
      pointerId: e.pointerId,
      threshold: e.pointerType === 'mouse' ? DRAG_START_PX : TOUCH_DRAG_START_PX,
      startX: e.clientX,
      startY: e.clientY,
      offsetX: point.x - piece.x,
      offsetY: point.y - piece.y,
      targetX: piece.x,
      targetY: piece.y,
      moved: false,
      held: false,
      samples: []
    };
    window.addEventListener('pointermove', handleWindowPointerMove);
    window.addEventListener('pointerup', handleWindowPointerUp);
    window.addEventListener('pointercancel', handleWindowPointerCancel);
    // A second finger is a pinch or pan for the board, not part of this drag
    window.addEventListener('pointerdown', handleExtraPointerDown, true);
  }

  function handleWindowPointerMove(e) {
    if (!drag?.piece || e.pointerId !== drag.pointerId) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < drag.threshold) return;
      drag.moved = true;
      draggingId = drag.id;
      if (localSim) {
        // The shelf may have changed since the sim last saw it
        localSim.setBoard(boardWidth, boardHeight);
        localSim.setObstacles(shelf.rect ? [shelf.rect] : []);
        drag.held = localSim.grab(drag.id, LOCAL_HOLDER);
      }
    }
    e.preventDefault();

    const point = toBoardPoint(e.clientX, e.clientY);
    drag.targetX = point.x - drag.offsetX;
    drag.targetY = point.y - drag.offsetY;
    drag.piece.jump = false;
    drag.piece.local = true;

    if (!drag.held) {
      // Slow mode: no physics, just the leash
      const clamped = clampToLeash(pieces, drag.piece, drag.targetX, drag.targetY);
      drag.piece.x = clamped.x;
      drag.piece.y = clamped.y;
      return;
    }

    localSim.dragTo(drag.id, LOCAL_HOLDER, drag.targetX, drag.targetY);
    const simPiece = localSim.byId.get(drag.id);
    drag.piece.x = simPiece.x;
    drag.piece.y = simPiece.y;
    runLocalSim();

    const now = performance.now();
    // Sample the piece, not the pointer, so straining against the leash doesn't store up a throw
    drag.samples.push({ t: now, x: simPiece.x, y: simPiece.y });
    while (drag.samples.length > 2 && now - drag.samples[0].t > THROW_SAMPLE_MS) drag.samples.shift();
  }

  function removeDragListeners() {
    window.removeEventListener('pointermove', handleWindowPointerMove);
    window.removeEventListener('pointerup', handleWindowPointerUp);
    window.removeEventListener('pointercancel', handleWindowPointerCancel);
    window.removeEventListener('pointerdown', handleExtraPointerDown, true);
  }

  function handleExtraPointerDown(e) {
    if (drag && e.pointerId !== drag.pointerId) cancelDrag();
  }

  function handleWindowPointerCancel(e) {
    if (drag && e.pointerId === drag.pointerId) cancelDrag();
  }

  function handleWindowPointerUp(e) {
    if (drag && e.pointerId !== drag.pointerId) return;
    removeDragListeners();
    if (!drag) return;
    if (drag.moved) {
      if (drag.held && localSim) {
        let vx = 0, vy = 0;
        const first = drag.samples[0], last = drag.samples[drag.samples.length - 1];
        // A pause before release throws nothing
        if (first && last && last.t > first.t && performance.now() - last.t < 50) {
          vx = (last.x - first.x) / (last.t - first.t) * WALL_TICK_MS * THROW_KEEP;
          vy = (last.y - first.y) / (last.t - first.t) * WALL_TICK_MS * THROW_KEEP;
          const speed = Math.hypot(vx, vy);
          if (speed > WALL_THROW_MAX) {
            vx *= WALL_THROW_MAX / speed;
            vy *= WALL_THROW_MAX / speed;
          }
        }
        localSim.drop(drag.id, LOCAL_HOLDER, vx, vy);
        runLocalSim();
      }
      suppressClickUntil = performance.now() + CLICK_SUPPRESS_MS;
    }
    drag = null;
    draggingId = null;
  }

  function cancelDrag() {
    removeDragListeners();
    if (drag?.moved) {
      if (drag.held && localSim) {
        localSim.drop(drag.id, LOCAL_HOLDER, 0, 0);
        runLocalSim();
      }
      suppressClickUntil = performance.now() + CLICK_SUPPRESS_MS;
    }
    drag = null;
    draggingId = null;
  }

  // --- Works-in-progress shelf ---

  function handleWipPointerDown(item, e) {
    if (!item.canManage || item.claimed || !toBoardPoint || !onWipPlace || wipDrag || drag) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target?.closest?.('.wip-delete')) return;
    e.stopPropagation();
    e.preventDefault();
    const point = toBoardPoint(e.clientX, e.clientY);
    wipDrag = {
      item,
      pointerId: e.pointerId,
      threshold: e.pointerType === 'mouse' ? DRAG_START_PX : TOUCH_DRAG_START_PX,
      startX: e.clientX,
      startY: e.clientY,
      clientX: e.clientX,
      clientY: e.clientY,
      x: point.x,
      y: point.y,
      moved: false
    };
    window.addEventListener('pointermove', handleWipPointerMove);
    window.addEventListener('pointerup', handleWipPointerUp);
    window.addEventListener('pointercancel', handleWipPointerCancel);
    window.addEventListener('pointerdown', handleWipExtraPointerDown, true);
  }

  function handleWipPointerMove(e) {
    if (!wipDrag || e.pointerId !== wipDrag.pointerId) return;
    if (!wipDrag.moved && Math.hypot(e.clientX - wipDrag.startX, e.clientY - wipDrag.startY) < wipDrag.threshold) return;
    e.preventDefault();
    const point = toBoardPoint(e.clientX, e.clientY);
    wipDrag = { ...wipDrag, clientX: e.clientX, clientY: e.clientY, x: point.x, y: point.y, moved: true };
  }

  function removeWipListeners() {
    window.removeEventListener('pointermove', handleWipPointerMove);
    window.removeEventListener('pointerup', handleWipPointerUp);
    window.removeEventListener('pointercancel', handleWipPointerCancel);
    window.removeEventListener('pointerdown', handleWipExtraPointerDown, true);
  }

  function handleWipExtraPointerDown(e) {
    if (wipDrag && e.pointerId !== wipDrag.pointerId) cancelWipDrag();
  }

  function handleWipPointerCancel(e) {
    if (wipDrag && e.pointerId === wipDrag.pointerId) cancelWipDrag();
  }

  async function handleWipPointerUp(e) {
    if (wipDrag && e.pointerId !== wipDrag.pointerId) return;
    removeWipListeners();
    const dropped = wipDrag;
    wipDrag = null;
    if (!dropped?.moved) return;
    const onBoard = dropped.x >= 0 && dropped.y >= 0 && dropped.x <= boardWidth && dropped.y <= boardHeight;
    if (!onBoard) return;
    await onWipPlace(dropped.item, dropped.x, dropped.y);
  }

  function cancelWipDrag() {
    removeWipListeners();
    wipDrag = null;
  }

  async function handleWipDelete(item) {
    clearTimeout(deleteConfirmTimer);
    if (pendingDeleteId !== item.id) {
      pendingDeleteId = item.id;
      deleteConfirmTimer = setTimeout(() => { pendingDeleteId = null; }, DELETE_CONFIRM_MS);
      return;
    }
    pendingDeleteId = null;
    const result = await wsClient?.requestFloatingWall?.({ a: 'wipDelete', id: item.id });
    if (!result?.ok) onToast?.(result?.error || 'Could not delete that piece', 3000, 'error');
  }

  // Board touches are preventDefault()ed by TouchHandler, so a tap never becomes a click: act on
  // pointerup for touch and pen, and ignore the click that some browsers still send
  function handleWipDeletePointerUp(item, e) {
    if (e.pointerType === 'mouse') return;
    lastWipDeleteTapAt = performance.now();
    e.preventDefault();
    handleWipDelete(item);
  }

  function handleWipDeleteClick(item) {
    if (performance.now() - lastWipDeleteTapAt < POINTER_CLICK_SUPPRESS_MS) return;
    handleWipDelete(item);
  }

  // --- Detach flight ---

  function setArriving(id, arriving) {
    const next = new Set(arrivingIds);
    if (arriving) next.add(id);
    else next.delete(id);
    arrivingIds = next;
  }

  // Screen rect of a board-px rect, measured through the mount so zoom, pan, rotation and flip all apply
  function measureBoardRect({ x, y, w, h }) {
    const probe = document.createElement('div');
    Object.assign(probe.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: `${w}px`,
      height: `${h}px`,
      transform: `translate(${x}px, ${y}px)`,
      visibility: 'hidden',
      pointerEvents: 'none'
    });
    cardsElement.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    probe.remove();
    return rect;
  }

  // Board px → this mount's space, which is counter-flipped when the canvas is
  function toMountRect({ x, y, w, h }) {
    return isCanvasFlipped?.() ? { x: boardWidth - x - w, y, w, h } : { x, y, w, h };
  }

  /**
   * A copy of just-detached art lifts off the board and arcs into its new shelf card. Called by
   * SelectTool for the detacher (with the image as a data URL) and on a server `fly` for everyone
   * else (with the shelf image URL). `rect` is the board px rect it was cut from.
   */
  export function flyToShelf(id, src, rect) {
    if (!showDetachFlights || !id || !src || !rect || !cardsElement || pendingFlights.has(id)) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const ghost = new Image();
    ghost.src = src;
    // Other clients have to fetch the image: fly once it's decoded, not as an empty box
    const ready = typeof ghost.decode === 'function' ? ghost.decode().catch(() => {}) : Promise.resolve();
    pendingFlights.set(id, { ghost, rect, ready });
    setArriving(id, true);
    // The shelf update might never show this piece (deleted meanwhile, a reconnect): don't hide its card forever
    setTimeout(() => {
      if (pendingFlights.delete(id)) setArriving(id, false);
    }, FLIGHT_WAIT_MS);
    launchPendingFlights();
  }

  // The detach reply usually beats the shelf update, so a flight may have to wait for its card
  async function launchPendingFlights() {
    if (!pendingFlights.size) return;
    await tick();
    for (const [id, flight] of pendingFlights) {
      if (flight.launching) continue;
      const target = cardsElement?.querySelector(`[data-wip-id="${CSS.escape(id)}"] .wip-image`);
      if (!target) continue;
      flight.launching = true;
      flight.ready.then(() => {
        // Timed out or unmounted while the image loaded
        if (pendingFlights.get(id) !== flight || !cardsElement) return;
        pendingFlights.delete(id);
        launchFlight(id, flight, target);
      });
    }
  }

  function launchFlight(id, { ghost, rect }, target) {
    const land = () => {
      setArriving(id, false);
      landedId = id;
      clearTimeout(landedTimer);
      landedTimer = setTimeout(() => {
        if (landedId === id) landedId = null;
      }, LAND_MS);
    };

    // Measured at launch, so a pan or zoom while the image loaded doesn't throw it off
    const from = measureBoardRect(toMountRect(rect));
    if (typeof ghost.animate !== 'function' || !ghost.naturalWidth || from.width < 1 || from.height < 1) {
      land();
      return;
    }

    // Land where the shelf shows the art: inside the image padding, fitted to the art's shape
    const box = target.getBoundingClientRect();
    const pad = WIP_IMAGE_PAD * (box.width / (target.offsetWidth || box.width));
    const innerW = Math.max(1, box.width - pad * 2);
    const innerH = Math.max(1, box.height - pad * 2);
    const aspect = from.width / from.height;
    const toW = Math.min(innerW, innerH * aspect);
    const endScale = toW / from.width;
    const dx = box.left + pad + (innerW - toW) / 2 - from.left;
    const dy = box.top + pad + (innerH - toW / aspect) / 2 - from.top;

    // Lift, then toss along a curve that peaks above the higher end of the trip
    const liftY = -10;
    const liftScale = 1.04;
    const distance = Math.hypot(dx, dy);
    const cx = dx / 2;
    const cy = Math.min(liftY, dy) - Math.min(220, distance * 0.35);
    const keyframes = [
      { offset: 0, transform: 'translate(0px, 0px) scale(1)' },
      { offset: FLIGHT_LIFT_AT, transform: `translate(0px, ${liftY}px) scale(${liftScale})` }
    ];
    for (let i = 1; i <= FLIGHT_STEPS; i++) {
      const t = i / FLIGHT_STEPS, u = 1 - t;
      const x = 2 * u * t * cx + t * t * dx;
      const y = u * u * liftY + 2 * u * t * cy + t * t * dy;
      const scale = liftScale + (endScale - liftScale) * t * t;
      keyframes.push({
        offset: FLIGHT_LIFT_AT + (1 - FLIGHT_LIFT_AT) * t,
        transform: `translate(${x}px, ${y}px) scale(${scale})`
      });
    }

    ghost.alt = '';
    ghost.draggable = false;
    Object.assign(ghost.style, {
      position: 'fixed',
      left: `${from.left}px`,
      top: `${from.top}px`,
      width: `${from.width}px`,
      height: `${from.height}px`,
      margin: '0',
      transformOrigin: '0 0',
      pointerEvents: 'none',
      zIndex: '10000',
      filter: 'drop-shadow(0 12px 18px rgba(0, 0, 0, 0.45))',
      willChange: 'transform'
    });
    // Portalled: inside #boards it would pass under the board canvas
    document.body.appendChild(ghost);
    flightElements.add(ghost);

    const animation = ghost.animate(keyframes, {
      duration: Math.max(600, Math.min(1100, 450 + distance * 0.35)),
      easing: 'cubic-bezier(0.45, 0, 0.25, 1)',
      fill: 'forwards'
    });
    const finish = () => {
      if (!flightElements.delete(ghost)) return;
      ghost.remove();
      land();
    };
    animation.onfinish = finish;
    animation.oncancel = finish;
  }

  // Kept for App.handleFloatingArtUpdate: the wall now learns about new art from the server
  export function addItem() {}

  export function updateItem(item) {
    if (item?.id) setPieceLikes(item.id, item.likesCount);
  }

  $effect(() => {
    if (!enabled || !wsClient || !roomId) return;
    wsClient.on('floating_wall', handleWallMessage);
    send(slowMode ? { a: 'hello', slow: 1 } : { a: 'hello' });
    fetchLikedIds();
    return () => {
      wsClient.on('floating_wall', () => {});
      cancelDrag();
      cancelWipDrag();
      stopLocalSim();
      localSim = null;
      // Stop the server sending wall traffic this client no longer shows
      send({ a: 'bye' });
      clearTimeout(deleteConfirmTimer);
      clearTimeout(hideConfirmTimer);
      clearTimeout(landedTimer);
      clearTimeout(metaFlushTimer);
      metaFlushTimer = null;
      pendingMeta.clear();
      pendingFlights.clear();
      for (const ghost of flightElements) ghost.remove();
      flightElements.clear();
    };
  });
</script>

{#if enabled}
  <div class="floating-art-container">
    <div class="floating-art-cards" bind:this={cardsElement}>
      {#each pieces as piece (piece.id)}
        {#if piece.active}
          <FloatingArt
            item={piece.item || { id: piece.id }}
            loaded={!!piece.item}
            onNeedMeta={requestMeta}
            x={piece.x - WALL_CARD_W / 2}
            y={piece.y - WALL_CARD_H / 2}
            liked={likedIds.has(piece.id)}
            likesCount={piece.item?.likesCount || 0}
            dragging={draggingId === piece.id}
            jump={piece.jump}
            slow={slowMode}
            onPointerDown={(e) => handleCardPointerDown(piece, e)}
            {isClickSuppressed}
            onLike={likeFloatingItem}
            {onComment}
            {onAuthorClick}
            {canHide}
            hideConfirm={pendingHideId === piece.id}
            onHide={hideFloatingItem}
          />
        {/if}
      {/each}

      {#if hasLocalMoves && boardWidth}
        <!-- Only this user sees their arrangement; this puts the room's back -->
        <button
          class="wall-reset"
          style="transform: translate({boardWidth / 2}px, -32px) translateX(-50%);"
          title="Put the pieces you moved back where the room has them. Only you see your arrangement."
          onpointerdown={(e) => e.stopPropagation()}
          onclick={handleResetClick}
          onpointerup={handleResetPointerUp}
        >Reset layout</button>
      {/if}

      {#if wipItems.length}
        <div class="wip-label" style="transform: translate({(shelf.rect.l + shelf.rect.r) / 2}px, {shelf.rect.t - 24}px) translateX(-50%);">Works in progress</div>
        {#each wipItems as item, i (item.id)}
          {@const slot = shelf.slot(i)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="wip-card"
            class:manageable={item.canManage && !item.claimed}
            class:claimed={item.claimed}
            class:lifted={wipDrag?.moved && wipDrag.item.id === item.id}
            class:arriving={arrivingIds.has(item.id)}
            class:landed={landedId === item.id}
            data-wip-id={item.id}
            style="transform: translate({slot.x}px, {slot.y}px); width: {WIP_SHELF.CARD_W}px; height: {WIP_SHELF.CARD_H}px;"
            title={item.claimed ? 'Someone is placing this piece' : item.canManage ? 'Drag onto the board to put it back' : `Work in progress by ${item.owner}`}
            onpointerdown={(e) => handleWipPointerDown(item, e)}
          >
            <div class="wip-image">
              <img src={`${apiBaseUrl}/api/wip/${item.id}`} alt={`Work in progress by ${item.owner}`} loading="lazy" decoding="async" draggable="false" />
            </div>
            <div class="wip-footer">
              <span class="wip-owner">{item.owner}</span>
              {#if item.canManage && !item.claimed}
                <button
                  class="wip-delete"
                  class:confirm={pendingDeleteId === item.id}
                  title={pendingDeleteId === item.id ? 'Tap again to delete permanently' : 'Delete this piece'}
                  onclick={() => handleWipDeleteClick(item)}
                  onpointerup={(e) => handleWipDeletePointerUp(item, e)}
                >{pendingDeleteId === item.id ? 'Delete?' : '×'}</button>
              {/if}
            </div>
          </div>
        {/each}
      {/if}

      {#if wipDrag?.moved}
        {@const zoom = getBoardZoom?.() || 1}
        <!-- Screen-space and portalled, at the size it will be pasted -->
        <div
          use:portal
          class="wip-ghost"
          style="left: {wipDrag.clientX}px; top: {wipDrag.clientY}px; width: {wipDrag.item.w * zoom}px; height: {wipDrag.item.h * zoom}px;"
        >
          <img src={`${apiBaseUrl}/api/wip/${wipDrag.item.id}`} alt="" draggable="false" />
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .floating-art-container {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    overflow: visible;
    contain: layout style;
  }

  .floating-art-cards {
    position: relative;
    width: 100%;
    height: 100%;
    z-index: 4;
    pointer-events: none;
  }

  .wall-reset {
    position: absolute;
    left: 0;
    top: 0;
    padding: 3px 10px;
    border: 1px solid var(--color-border, #555);
    border-radius: 999px;
    background: var(--color-bg-secondary, #222);
    color: var(--color-text-secondary, #aaa);
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
    pointer-events: auto;
    touch-action: none;
    z-index: 5;
  }

  .wall-reset:hover,
  .wall-reset:focus-visible {
    color: var(--color-text-primary, #fff);
    border-color: var(--color-accent, #00d4aa);
  }

  .wip-label {
    position: absolute;
    left: 0;
    top: 0;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--color-text-secondary, #aaa);
    white-space: nowrap;
    pointer-events: none;
  }

  .wip-card {
    position: absolute;
    left: 0;
    top: 0;
    display: flex;
    flex-direction: column;
    background: var(--color-bg-secondary, #222);
    border: 1px dashed var(--color-border, #555);
    border-radius: 8px;
    overflow: hidden;
    pointer-events: auto;
    user-select: none;
    -webkit-touch-callout: none;
    touch-action: none;
    z-index: 4;
    /* The row re-centres when a piece joins or leaves: slide rather than jump */
    transition: transform 250ms ease;
  }

  /* Held back until the detach flight lands in it */
  .wip-card.arriving {
    opacity: 0;
    transition: none;
  }

  /* `scale` composes with the positioning transform instead of replacing it */
  .wip-card.landed {
    animation: wipLand 420ms cubic-bezier(0.2, 0.8, 0.3, 1.2);
  }

  @keyframes wipLand {
    0% {
      scale: 0.92;
      box-shadow: 0 0 0 3px var(--color-accent, #00d4aa);
    }
    55% {
      scale: 1.05;
    }
    100% {
      scale: 1;
      box-shadow: 0 0 0 0 transparent;
    }
  }

  .wip-card.manageable {
    cursor: grab;
  }

  .wip-card.claimed,
  .wip-card.lifted {
    opacity: 0.45;
  }

  .wip-image {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 8px;
    /* Light checkerboard, same palette as the layer preview, so dark and faint strokes stay readable */
    background-color: #f3f1ec;
    background-image:
      linear-gradient(45deg, #ddd9d0 25%, transparent 25%, transparent 75%, #ddd9d0 75%),
      linear-gradient(45deg, #ddd9d0 25%, transparent 25%, transparent 75%, #ddd9d0 75%);
    background-size: 16px 16px;
    background-position: 0 0, 8px 8px;
  }

  .wip-image img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    display: block;
  }

  .wip-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    height: 34px;
    padding: 0 8px 0 10px;
  }

  .wip-owner {
    font-size: 11px;
    font-weight: 500;
    color: var(--color-text-secondary, #aaa);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .wip-delete {
    flex-shrink: 0;
    min-width: 26px;
    min-height: 24px;
    border: none;
    border-radius: 4px;
    padding: 2px 7px;
    font-size: 13px;
    line-height: 1.2;
    cursor: pointer;
    background: var(--color-bg-tertiary, #1a1a1a);
    color: var(--color-text-secondary, #aaa);
  }

  .wip-delete:hover,
  .wip-delete.confirm {
    background: #b3261e;
    color: #fff;
  }

  .wip-ghost {
    position: fixed;
    transform: translate(-50%, -50%);
    opacity: 0.75;
    outline: 2px dashed var(--color-accent, #00d4aa);
    pointer-events: none;
    z-index: 10000;
  }

  .wip-ghost img {
    width: 100%;
    height: 100%;
    display: block;
  }
</style>
