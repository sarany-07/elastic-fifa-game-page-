/**
 * Penalty Shootout — vanilla JS + Canvas
 * Modular, beginner-friendly architecture.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOTAL_SHOTS = 5;
const SHOT_DURATION_MS = 680;
const RESULT_PAUSE_MS = 1200;
const COUNTDOWN_START = 3;
const FORM_UNLOCK_SECONDS = 15;
const SCORE_API_URL =
  "https://script.google.com/macros/s/AKfycbx_zT625-dxctB9R8VjGCch0_Z3dBQBjF14i0_K7PIptV3LKKTMIQ0JTGSIJL6FWwnfpg/exec";
const DASHBOARD_URL =
  "https://marketingcampaign.online/Elastic/FIFA_Assessment_Landing_Page/V4/#gameSection";
const PLAY_AGAIN_FORM_URL = "https://events.elastic.co/aroundtheworld";

/** Medium difficulty — reads aim well, punishes repeats hard */
const KEEPER = {
  HAND_SIZE: 0.064,
  IDLE_LEAN_X: 0.36,
  IDLE_LEAN_Y: 0.08,
  IDLE_EASE: 0.11,
  DIVE_EASE: 0.19,
  DIVE_EASE_CHASE: 0.22,
  AIM_READ: 0.84,
  AIM_READ_Y: 0.72,
  /** Normalized aim distance = "same direction" */
  REPEAT_DIST: 0.13,
  SAVE_TOUCH: { corner: 1.0, side: 1.08, center: 1.14 },
  /** Glove width as fraction of goal width */
  GLOVE_SCALE: 0.16,
  GLOVE_NATIVE_W: 164,
};

/**
 * Net scoring table from user sketch (rows: top->bottom, cols: left->right)
 * Right side mirrors left side.
 */
const SCORE_GRID = [
  [50, 30, 10, 30, 50],
  [47, 28, 8, 28, 47],
  [45, 25, 5, 25, 45],
  [50, 30, 10, 30, 50],
];

/** Goal mouth on assets/bg-stadium.png (between posts, inside net) */
const GOAL_ON_BG = {
  x0: 0.288,
  x1: 0.702,
  y0: 0.292,
  y1: 0.642,
};

/** Scoring/aim inset from posts — minimal at top */
const GOAL_AIM_INSET = {
  side: 0.015,
  top: 0.005,
  bottom: 0.025,
};

/** Scoring zone point values */
const POINTS = {
  CORNER: 50,
  SIDE: 30,
  CENTER: 10,
  MISS: 0,
};

/** Player cards unlocked by final score (highest matching tier wins) */
const WIN_CARDS = [
  {
    id: "striker",
    minScore: 700,
    rating: 100,
    role: "Engineering Leader",
    position: "Striker",
    tagline: "The driver of results",
    image: "cards/Fifa cards_Leader copy.jpg",
    roleTop: true,
  },
  {
    id: "playmaker",
    minScore: 595,
    rating: 95,
    role: "SRE Leader",
    position: "Playmaker",
    tagline: "Full of observability of the field",
    image: "cards/Fifa cards_SRE Leader copy.jpg",
    roleTop: false,
  },
  {
    id: "goalkeeper",
    minScore: 490,
    rating: 90,
    role: "CTO/CEO",
    position: "Goalkeeper",
    tagline: "Sees the field before others do",
    image: "cards/Fifa cards_CTO-CEO copy.jpg",
    roleTop: true,
  },
  {
    id: "defender",
    minScore: 385,
    rating: 85,
    role: "CISO & Security Leader",
    position: "Defender",
    tagline: "Keeps the organization secure from threats",
    image: "cards/Fifa cards_CISO Security Leader copy.jpg",
    roleTop: false,
  },
  {
    id: "midfielder",
    minScore: 280,
    rating: 80,
    role: "Developer",
    position: "Midfielder",
    tagline: "The creator, builder and distributor",
    image: "cards/Fifa cards_Developer copy.jpg",
    roleTop: true,
  },
];

function getWinCard(score) {
  for (const card of WIN_CARDS) {
    if (score >= card.minScore) return card;
  }
  return null;
}

function getMedalTier(score) {
  if (score >= 700) return "gold";
  if (score >= 385) return "silver";
  return "bronze";
}

function getCurrentRankName(score) {
  const card = getWinCard(score);
  return card ? card.position : "Rookie Player";
}

function getNextUnlock(score) {
  const tiers = [...WIN_CARDS].sort((a, b) => a.minScore - b.minScore);
  for (const card of tiers) {
    if (score < card.minScore) {
      return { card, needed: card.minScore - score };
    }
  }
  return null;
}

function getProgressToNext(score) {
  const next = getNextUnlock(score);
  if (!next) return { pct: 100, current: score, next: 100 };
  const prevMin =
    [...WIN_CARDS]
      .filter((c) => c.minScore < next.card.minScore)
      .sort((a, b) => b.minScore - a.minScore)[0]?.minScore ?? 0;
  const range = next.card.minScore - prevMin;
  const pct = Math.min(100, Math.max(0, ((score - prevMin) / range) * 100));
  return { pct, current: score, next: next.card.minScore };
}

// ---------------------------------------------------------------------------
// AudioManager — stadium applause (Mixkit, free license)
// https://mixkit.co/free-sound-effects/applause/
// ---------------------------------------------------------------------------

const AUDIO_ASSETS = {
  applauseGoal: "assets/applause-goal.mp3?v=1",
  applauseEnd: "assets/applause-end.mp3?v=1",
};

class AudioManager {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.buffers = {};
    this.ready = false;
    this.unlocked = false;
    this.masterVol = 0.3;
    this._masterGain = null;
    this._loadPromise = null;
  }

  _out(ctx) {
    if (!this._masterGain) {
      this._masterGain = ctx.createGain();
      this._masterGain.gain.value = this.masterVol;
      this._masterGain.connect(ctx.destination);
    }
    return this._masterGain;
  }

  _ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    return this.ctx;
  }

  async _loadBuffers() {
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = (async () => {
      const ctx = this._ensureContext();
      if (!ctx) return;
      for (const [key, url] of Object.entries(AUDIO_ASSETS)) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to load ${url}`);
        const ab = await res.arrayBuffer();
        this.buffers[key] = await ctx.decodeAudioData(ab);
      }
      this.ready = true;
    })();
    return this._loadPromise;
  }

  async unlock() {
    if (!this.enabled) return false;
    try {
      const ctx = this._ensureContext();
      if (!ctx) return false;
      await this._loadBuffers();
      if (ctx.state === "suspended") await ctx.resume();
      this.unlocked = true;
      return true;
    } catch {
      return false;
    }
  }

  _playBuffer(key, gainValue) {
    if (!this.enabled || !this.unlocked || !this.ready) return;
    const ctx = this._ensureContext();
    const buffer = this.buffers[key];
    if (!ctx || !buffer) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = gainValue;
    source.connect(gain);
    gain.connect(this._out(ctx));
    source.start(0);
  }

  /** No looping background — applause only on goals */
  startCrowdAmbience() {}
  stopCrowdAmbience() {}

  playKick() {
    this.unlock();
  }

  playGoal() {
    if (!this.enabled) return;
    this._playBuffer("applauseGoal", 0.42);
  }

  playMiss() {}

  /** Stadium applause when match ends */
  playCrowdCheer() {
    if (!this.enabled) return;
    this._playBuffer("applauseEnd", 0.38);
  }
}

// ---------------------------------------------------------------------------
// InputManager — mouse, touch, keyboard
// ---------------------------------------------------------------------------

function isMobileLayout() {
  return window.matchMedia("(max-width: 768px), (pointer: coarse)").matches;
}

function isPhonePortrait() {
  if (!isMobileLayout()) return false;
  const w = window.visualViewport?.width ?? window.innerWidth;
  const h = window.visualViewport?.height ?? window.innerHeight;
  return h > w;
}

class InputManager {
  constructor(canvas, aimSurface, shootBtn = null) {
    this.canvas = canvas;
    this.aimSurface = aimSurface || canvas;
    this.shootBtn = shootBtn;
    this.isMobile = isMobileLayout();
    this.aimX = 0.5;
    this.aimY = 0.35;
    this.pointerX = 0.5;
    this.pointerY = 0.35;
    this.shootPressed = false;
    this._aimActive = false;
    this._bound = {};

    this.setMobileMode(this.isMobile);
    this._bindEvents();
  }

  setMobileMode(mobile) {
    this.isMobile = mobile;
    document.body.classList.toggle("is-mobile", mobile);
  }

  _canvasPos(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return { x: this.pointerX, y: this.pointerY };
    }
    return {
      x: (clientX - rect.left) / rect.width,
      y: (clientY - rect.top) / rect.height,
    };
  }

  _updateAim(clientX, clientY) {
    const p = this._canvasPos(clientX, clientY);
    this.pointerX = Math.max(0, Math.min(1, p.x));
    this.pointerY = Math.max(0, Math.min(1, p.y));
  }

  _queueShoot() {
    this.shootPressed = true;
  }

  _bindEvents() {
    const surface = this.aimSurface;

    const onPointerDown = (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (this.shootBtn?.contains(e.target)) return;
      this._aimActive = true;
      surface.setPointerCapture?.(e.pointerId);
      this._updateAim(e.clientX, e.clientY);
      if (!this.isMobile && e.pointerType === "mouse") {
        e.preventDefault();
        this._queueShoot();
      }
      if (e.pointerType === "touch") e.preventDefault();
    };

    const onPointerMove = (e) => {
      if (this.isMobile) {
        if (!this._aimActive) return;
      } else if (e.pointerType !== "mouse" && !this._aimActive) {
        return;
      }
      this._updateAim(e.clientX, e.clientY);
      if (e.pointerType === "touch") e.preventDefault();
    };

    const onPointerUp = (e) => {
      if (!this._aimActive) return;
      this._aimActive = false;
      surface.releasePointerCapture?.(e.pointerId);
      this._updateAim(e.clientX, e.clientY);
    };

    const onPointerCancel = () => {
      this._aimActive = false;
    };

    const onMouseMove = (e) => {
      if (!this.isMobile) this._updateAim(e.clientX, e.clientY);
    };

    const onTouchStart = (e) => {
      if (!this.isMobile || !e.touches?.[0]) return;
      if (this.shootBtn?.contains(e.target)) return;
      const t = e.touches[0];
      e.preventDefault();
      this._aimActive = true;
      this._updateAim(t.clientX, t.clientY);
    };

    const onTouchMove = (e) => {
      if (!this.isMobile || !this._aimActive || !e.changedTouches?.[0]) return;
      e.preventDefault();
      this._updateAim(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
    };

    const onTouchEnd = (e) => {
      if (!this.isMobile || !this._aimActive) return;
      const t = e.changedTouches?.[0];
      if (t) this._updateAim(t.clientX, t.clientY);
      this._aimActive = false;
    };

    const onKey = (e) => {
      if (e.code === "Space") {
        e.preventDefault();
        if (e.type === "keydown") this._queueShoot();
      }
    };

    const onShootBtn = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._queueShoot();
    };

    surface.addEventListener("pointerdown", onPointerDown, { passive: false });
    surface.addEventListener("pointermove", onPointerMove, { passive: false });
    surface.addEventListener("pointerup", onPointerUp);
    surface.addEventListener("pointercancel", onPointerCancel);
    surface.addEventListener("touchstart", onTouchStart, { passive: false });
    surface.addEventListener("touchmove", onTouchMove, { passive: false });
    surface.addEventListener("touchend", onTouchEnd, { passive: false });
    surface.addEventListener("mousemove", onMouseMove);
    window.addEventListener("keydown", onKey);

    if (this.shootBtn) {
      this.shootBtn.addEventListener("click", onShootBtn);
    }

    this._bound = {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onTouchStart,
      onTouchMove,
      onTouchEnd,
      onMouseMove,
      onKey,
      onShootBtn,
    };
  }

  consumeShoot() {
    if (this.shootPressed) {
      this.shootPressed = false;
      return true;
    }
    return false;
  }

  destroy() {
    const b = this._bound;
    const surface = this.aimSurface;
    surface.removeEventListener("pointerdown", b.onPointerDown);
    surface.removeEventListener("pointermove", b.onPointerMove);
    surface.removeEventListener("pointerup", b.onPointerUp);
    surface.removeEventListener("pointercancel", b.onPointerCancel);
    surface.removeEventListener("touchstart", b.onTouchStart);
    surface.removeEventListener("touchmove", b.onTouchMove);
    surface.removeEventListener("touchend", b.onTouchEnd);
    surface.removeEventListener("mousemove", b.onMouseMove);
    window.removeEventListener("keydown", b.onKey);
    if (this.shootBtn) {
      this.shootBtn.removeEventListener("click", b.onShootBtn);
    }
  }
}

// ---------------------------------------------------------------------------
// Layout — responsive goal & field geometry from canvas size
// ---------------------------------------------------------------------------

class Layout {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.update(w, h);
  }

  update(w, h) {
    this.w = w;
    this.h = h;
    this._applyFallbackGoal();
  }

  /** Procedural fallback when stadium image is unavailable */
  _applyFallbackGoal() {
    const { w, h } = this;
    this.goalW = w * 0.39;
    this.goalH = h * 0.343;
    this.goalX = (w - this.goalW) / 2;
    this.goalY = h * 0.302;
    this._applySharedSpots();
  }

  /**
   * Match goal bounds to bg-stadium.png (cover-scaled on canvas).
   * Without this, aim stops at ~53% screen while the art net goes to ~65%.
   */
  syncGoalToBackground(img, w, h) {
    if (!img?.complete || !img.naturalWidth) return;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const scale = Math.max(w / iw, h / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    const dx = (w - dw) / 2;
    const dy = (h - dh) / 2;
    const g = GOAL_ON_BG;
    this.goalX = dx + g.x0 * dw;
    this.goalY = dy + g.y0 * dh;
    this.goalW = (g.x1 - g.x0) * dw;
    this.goalH = (g.y1 - g.y0) * dh;
    this._applySharedSpots();
  }

  _applySharedSpots() {
    this.ballStartX = this.w * 0.5;
    this.ballStartY = this.h * 0.83;
    this.ballRadius = Math.min(this.w, this.h) * 0.055;
    this.keeperMinX = this.goalX + this.goalW * 0.12;
    this.keeperMaxX = this.goalX + this.goalW * 0.88;
    this.keeperY = this.goalY + this.goalH * 0.52;
    this.handRadius = this.goalW * KEEPER.HAND_SIZE;
  }

  keeperGloveW() {
    return Math.round(this.goalW * KEEPER.GLOVE_SCALE);
  }

  goalInnerRect() {
    const side = this.goalW * GOAL_AIM_INSET.side;
    const top = this.goalH * GOAL_AIM_INSET.top;
    const bottom = this.goalH * GOAL_AIM_INSET.bottom;
    return {
      left: this.goalX + side,
      right: this.goalX + this.goalW - side,
      top: this.goalY + top,
      bottom: this.goalY + this.goalH - bottom,
    };
  }

  /** True when a point is inside the scoring net (not stadium walls) */
  isInScoringZone(gx, gy) {
    const { left, right, top, bottom } = this.goalInnerRect();
    return gx >= left && gx <= right && gy >= top && gy <= bottom;
  }

  /** Map normalized aim (0–1) to pixel position inside the net */
  aimToGoal(aimX, aimY) {
    const clamped = this.clampAim(aimX, aimY);
    return {
      x: this.goalX + clamped.aimX * this.goalW,
      y: this.goalY + clamped.aimY * this.goalH,
    };
  }

  clampAim(aimX, aimY) {
    const side = GOAL_AIM_INSET.side;
    const top = GOAL_AIM_INSET.top;
    const bottom = GOAL_AIM_INSET.bottom;
    return {
      aimX: Math.max(side, Math.min(1 - side, aimX)),
      aimY: Math.max(top, Math.min(1 - bottom, aimY)),
    };
  }

  /**
   * Map pointer → net aim (0–1). Direct mapping + clamp keeps corners stable
   * when the cursor is outside the net (ray-cast was snapping to +30 side zones).
   */
  screenToAim(px, py) {
    const { goalX, goalY, goalW, goalH } = this;
    return this.clampAim((px - goalX) / goalW, (py - goalY) / goalH);
  }

  /** Keep shot end point inside the goal mouth (looser at bottom for low net zones) */
  clampToGoal(x, y, inset = 10) {
    const side = typeof inset === "number" ? inset : inset.side ?? 8;
    const top = typeof inset === "number" ? inset : inset.top ?? 8;
    const bottom = typeof inset === "number" ? Math.max(3, inset - 6) : inset.bottom ?? 3;
    return {
      x: Math.max(this.goalX + side, Math.min(this.goalX + this.goalW - side, x)),
      y: Math.max(this.goalY + top, Math.min(this.goalY + this.goalH - bottom, y)),
    };
  }

  /**
   * Classify shot by score grid (user-provided net representation).
   */
  scoreZone(gx, gy) {
    const { goalX, goalY, goalW, goalH } = this;

    if (!this.isInScoringZone(gx, gy)) {
      return { points: POINTS.MISS, label: "Miss!", zone: "miss" };
    }

    const relX = (gx - goalX) / goalW;
    const relY = (gy - goalY) / goalH;

    const cols = SCORE_GRID[0].length;
    const rows = SCORE_GRID.length;
    const col = Math.max(0, Math.min(cols - 1, Math.floor(relX * cols)));
    const row = Math.max(0, Math.min(rows - 1, Math.floor(relY * rows)));

    const points = SCORE_GRID[row][col];

    let zone = "side";
    if (col === 2) zone = "center";
    else if ((col === 0 || col === 4) && (row === 0 || row === rows - 1)) zone = "corner";

    let cornerId;
    if (col === 0) cornerId = row === 0 ? "TL" : row === rows - 1 ? "BL" : undefined;
    else if (col === 4) cornerId = row === 0 ? "TR" : row === rows - 1 ? "BR" : undefined;

    return {
      points,
      label: `+${points} Goal!`,
      zone,
      row,
      col,
      cornerId,
    };
  }
}

// ---------------------------------------------------------------------------
// Ball
// ---------------------------------------------------------------------------

class Ball {
  constructor(layout) {
    this.layout = layout;
    this.reset();
    this.floatPhase = 0;
  }

  reset() {
    const L = this.layout;
    this.x = L.ballStartX;
    this.y = L.ballStartY;
    this.scale = 1;
    this.rotation = 0;
    this.shooting = false;
    this.progress = 0;
    this.targetX = L.ballStartX;
    this.targetY = L.goalY + L.goalH * 0.5;
  }

  startShot(targetX, targetY, accuracy = 1) {
    this.shooting = true;
    this.progress = 0;
    this.startX = this.x;
    this.startY = this.y;
    const L = this.layout;
    const spread = (1 - accuracy) * L.goalW * 0.028;
    const clamped = L.clampToGoal(
      targetX + (Math.random() - 0.5) * spread,
      targetY + (Math.random() - 0.5) * spread * 0.45,
      { side: 4, top: 4, bottom: 2 }
    );
    this.targetX = clamped.x;
    this.targetY = clamped.y;
  }

  update(dt, idle) {
    if (this.shooting) {
      this.progress += dt / SHOT_DURATION_MS;
      const t = Math.min(1, this.progress);
      const ease = 1 - Math.pow(1 - t, 3);
      this.x = this.startX + (this.targetX - this.startX) * ease;
      this.y = this.startY + (this.targetY - this.startY) * ease;
      this.scale = 1 - ease * 0.45;
      this.rotation += dt * 0.012;
      return t >= 1;
    }

    if (idle) {
      this.floatPhase += dt * 0.003;
      const L = this.layout;
      this.x = L.ballStartX;
      this.y = L.ballStartY + Math.sin(this.floatPhase) * 6;
      this.scale = 1;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// KeeperAI — reads patterns; never sees the true ball path on dive
// ---------------------------------------------------------------------------

class KeeperAI {
  constructor() {
    this.history = [];
    this.hotZone = null;
    this.hotCount = 0;
    this.lastAimX = 0.5;
    this.lastAimY = 0.35;
  }

  reset() {
    this.history = [];
    this.hotZone = null;
    this.hotCount = 0;
    this.lastAimX = 0.5;
    this.lastAimY = 0.35;
  }

  /** How many past shots aimed near this spot (0 = new direction) */
  countSimilar(aimX, aimY) {
    return this.history.filter(
      (s) => Math.hypot(aimX - s.aimX, aimY - s.aimY) < KEEPER.REPEAT_DIST
    ).length;
  }

  /** Shot bucket for learning (TL/TR corners, sides, center) */
  _zoneKey(aimX, aimY) {
    if (aimY < 0.34 && aimX < 0.26) return "TL";
    if (aimY < 0.34 && aimX > 0.74) return "TR";
    if (aimY > 0.72 && aimX < 0.26) return "BL";
    if (aimY > 0.72 && aimX > 0.74) return "BR";
    if (aimX < 0.32) return "L";
    if (aimX > 0.68) return "R";
    return "C";
  }

  _zoneCenter(key) {
    const spots = {
      TL: { x: 0.11, y: 0.1 },
      TR: { x: 0.89, y: 0.1 },
      L: { x: 0.14, y: 0.38 },
      R: { x: 0.86, y: 0.38 },
      C: { x: 0.5, y: 0.42 },
    };
    return spots[key] || spots.C;
  }

  record(aimX, aimY) {
    const key = this._zoneKey(aimX, aimY);
    this.history.push({ aimX, aimY, key });
    if (this.history.length > 6) this.history.shift();

    const counts = {};
    for (const s of this.history) counts[s.key] = (counts[s.key] || 0) + 1;
    let best = null;
    let n = 0;
    for (const [k, c] of Object.entries(counts)) {
      if (c > n) {
        n = c;
        best = k;
      }
    }
    this.hotZone = n >= 2 ? best : null;
    this.hotCount = n;
    this.lastAimX = aimX;
    this.lastAimY = aimY;
  }

  /** Idle lean — shifts toward your last shot & repeated direction */
  idleBias(aimX, aimY) {
    let bx = aimX;
    let by = aimY;
    const similar = this.countSimilar(aimX, aimY);

    if (this.history.length > 0) {
      const camp = Math.min(0.7, 0.28 + similar * 0.22);
      bx = bx * (1 - camp) + this.lastAimX * camp;
      by = by * (1 - camp) + this.lastAimY * camp;
    }

    if (this.hotZone) {
      const hot = this._zoneCenter(this.hotZone);
      const w = Math.min(0.6, 0.22 + this.hotCount * 0.14);
      bx = bx * (1 - w) + hot.x * w;
      by = by * (1 - w) + hot.y * w;
    }
    return { bx, by };
  }

  /**
   * Dive plan — repeated direction = keeper jumps straight to your target.
   */
  planDive(aimX, aimY) {
    const actualKey = this._zoneKey(aimX, aimY);
    const similar = this.countSimilar(aimX, aimY);
    const repeatShot = similar >= 1;

    if (repeatShot) {
      return {
        predX: aimX,
        predY: aimY,
        reach: Math.min(1.05, 0.96 + similar * 0.04),
        readGood: true,
        repeatRead: true,
        chaseBall: true,
        misread: false,
        actualKey,
        similar,
      };
    }

    let predX = 0.5 + (aimX - 0.5) * KEEPER.AIM_READ;
    let predY = 0.55 + (aimY - 0.55) * KEEPER.AIM_READ_Y;

    if (this.hotZone && this.hotCount >= 2) {
      const hot = this._zoneCenter(this.hotZone);
      const cheat = Math.min(0.75, 0.35 + this.hotCount * 0.12);
      predX = predX * (1 - cheat) + hot.x * cheat;
      predY = predY * (1 - cheat) + hot.y * cheat;
    }

    predX += (Math.random() - 0.5) * 0.06;
    predY += (Math.random() - 0.5) * 0.05;

    let misread = false;
    if (Math.random() < 0.1) {
      predX = predX < 0.5 ? 0.76 + Math.random() * 0.12 : 0.1 + Math.random() * 0.12;
      predY = 0.52 + Math.random() * 0.18;
      misread = true;
    }

    predX = Math.max(0.06, Math.min(0.94, predX));
    predY = Math.max(0.06, Math.min(0.94, predY));

    const readErr = Math.hypot(predX - aimX, predY - aimY);
    const readThresh = aimY < 0.3 ? 0.11 : 0.14;
    const readGood = readErr < readThresh && !misread;

    let reach = 0.52;
    if (readGood) {
      reach =
        actualKey === "TL" || actualKey === "TR"
          ? 0.68
          : actualKey === "BL" || actualKey === "BR"
            ? 0.82
            : 0.78;
    } else if (readErr < 0.28) reach = 0.66;
    else reach = 0.42;

    return {
      predX,
      predY,
      reach,
      readGood,
      repeatRead: false,
      chaseBall: false,
      misread,
      actualKey,
      similar: 0,
    };
  }

  getPromptHint() {
    if (this.history.length >= 1) {
      return isMobileLayout()
        ? "Mix your aim — keeper reads repeats"
        : "Try a different angle — keeper reads repeats";
    }
    return isMobileLayout()
      ? "Touch the goal to aim, then tap SHOOT"
      : "Aim and press SPACE to shoot";
  }

  getMobileHint() {
    if (this.history.length >= 1) {
      return "Mix your spots — keeper reads repeats";
    }
    return "Touch & drag on the goal to aim";
  }
}

// ---------------------------------------------------------------------------
// Goalkeeper — dives toward AI guess, not the ball
// ---------------------------------------------------------------------------

class Goalkeeper {
  constructor(layout) {
    this.layout = layout;
    this.displayX = 0;
    this.displayY = 0;
    this.targetX = 0;
    this.targetY = 0;
    this.leadTargetX = 0;
    this.leadTargetY = 0;
    this.diveReach = 0.6;
    this.readGood = false;
    this.repeatRead = false;
    this.chaseBall = false;
    this.strengthFactor = 1.0;
    this.diving = false;
    this.reset();
  }

  reset() {
    const L = this.layout;
    const cx = L.goalX + L.goalW * 0.5;
    this.targetX = cx;
    this.targetY = L.keeperY;
    this.displayX = cx;
    this.displayY = L.keeperY;
    this.diving = false;
  }

  anticipate(aimX, aimY, ai) {
    const L = this.layout;
    const cx = L.goalX + L.goalW * 0.5;
    const { bx, by } = ai.idleBias(aimX, aimY);
    this.targetX = cx + (bx - 0.5) * L.goalW * KEEPER.IDLE_LEAN_X;
    this.targetY = L.keeperY + (by - 0.5) * L.goalH * KEEPER.IDLE_LEAN_Y;
  }

  /**
   * Dive toward guess — on repeat shots, gloves chase the real ball target.
   */
  commitDive(plan, layout, ballX, ballY) {
    const L = layout;
    const midX = this.displayX;
    const midY = this.displayY;

    this.readGood = plan.readGood || plan.repeatRead;
    this.repeatRead = plan.repeatRead;
    this.chaseBall = plan.chaseBall;
    const reach = Math.max(0.4, Math.min(1.08, plan.reach * this.strengthFactor));
    this.diveReach = reach;

    let targetX;
    let targetY;

    if (plan.chaseBall && ballX != null && ballY != null) {
      targetX = ballX;
      targetY = ballY;
    } else {
      const guess = L.aimToGoal(plan.predX, plan.predY);
      const dx = guess.x - midX;
      const dy = guess.y - midY;
      let vert = reach;
      if (plan.predY < 0.3) vert *= 0.66;
      else if (plan.predY > 0.72) vert *= 0.94;
      targetX = midX + dx * reach;
      targetY = midY + dy * vert;
    }

    this.leadTargetX = Math.max(L.keeperMinX, Math.min(L.keeperMaxX, targetX));
    if (plan.chaseBall) {
      this.leadTargetY = Math.max(
        L.goalY + L.goalH * 0.06,
        Math.min(L.goalY + L.goalH * 0.94, targetY)
      );
    } else if (plan.predY > 0.68) {
      this.leadTargetY = Math.max(
        L.goalY + L.goalH * 0.48,
        Math.min(L.goalY + L.goalH * 0.94, targetY)
      );
    } else if (plan.predY < 0.3) {
      this.leadTargetY = Math.max(
        L.goalY + L.goalH * 0.08,
        Math.min(L.goalY + L.goalH * 0.42, targetY)
      );
    } else {
      this.leadTargetY = Math.max(
        L.goalY + L.goalH * 0.1,
        Math.min(L.goalY + L.goalH * 0.58, targetY)
      );
    }
    this.diving = true;
  }

  update(dt, diving) {
    const ease = diving
      ? this.chaseBall
        ? KEEPER.DIVE_EASE_CHASE
        : this.readGood
          ? KEEPER.DIVE_EASE * 1.1
          : KEEPER.DIVE_EASE
      : KEEPER.IDLE_EASE;
    const t = 1 - Math.pow(1 - ease, dt / 16);
    const destX = diving ? this.leadTargetX : this.targetX;
    const destY = diving ? this.leadTargetY : this.targetY;
    this.displayX += (destX - this.displayX) * t;
    this.displayY += (destY - this.displayY) * t;
  }

  /**
   * Ellipse hitbox on gloves. progress gates mid-flight crossings so top-corner
   * shots are not saved while the ball passes through the keeper on the way up.
   */
  blocks(ballX, ballY, zone, progress = 1) {
    const L = this.layout;
    const relY = (ballY - L.goalY) / L.goalH;
    const relX = (ballX - L.goalX) / L.goalW;
    const chasing = this.chaseBall || this.repeatRead;

    if (!chasing && progress < 0.54) return false;

    if (!chasing && relY < 0.2 && (relX < 0.16 || relX > 0.84)) return false;

    const gloveW = Math.min(L.keeperGloveW(), KEEPER.GLOVE_NATIVE_W);
    const gloveH = gloveW * 0.65;
    let reachX = gloveW * 0.43 + L.ballRadius * 0.42;
    let reachY = gloveH * 0.43 + L.ballRadius * 0.42;
    const touch = KEEPER.SAVE_TOUCH[zone] ?? KEEPER.SAVE_TOUCH.center;
    reachX *= touch;
    reachY *= touch;

    if (relY < 0.3) {
      reachY *= relX < 0.22 || relX > 0.78 ? 0.52 : 0.66;
    } else if (relY > 0.68) {
      reachY *= chasing ? 1.04 : 1.08;
      reachX *= 1.03;
    }

    if (chasing) {
      reachX *= 1.08;
      reachY *= 1.08;
    }

    const dx = ballX - this.displayX;
    const dy = ballY - this.displayY;
    const hit = (dx * dx) / (reachX * reachX) + (dy * dy) / (reachY * reachY);
    return hit < 1;
  }
}

// ---------------------------------------------------------------------------
// Renderer — all Canvas drawing
// ---------------------------------------------------------------------------

class Renderer {
  constructor(ctx, layout) {
    this.ctx = ctx;
    this.layout = layout;
    this.dpr = 1;
    this.goalGlow = 0;
    this.netShake = 0;
    this.netShakeDecay = 0.92;
    const v = "8";
    this.bgPlay = new Image();
    this.bgPlay.src = `assets/bg-stadium.png?v=${v}`;
    this.bgPlay.onload = () => {
      if (this.onBackgroundReady) this.onBackgroundReady();
    };
    this.spriteGloves = new Image();
    this.spriteGloves.src = `assets/gloves.png?v=${v}`;
    this.spriteGlovesBlur = new Image();
    this.spriteGlovesBlur.src = `assets/gloves-blur.png?v=${v}`;
    this.spriteBall = new Image();
    this.spriteBall.src = `assets/ball.png?v=${v}`;
  }

  triggerGoalEffect() {
    this.goalGlow = 1;
    this.netShake = 14;
  }

  triggerMissEffect() {
    this.netShake = 5;
  }

  updateEffects(dt) {
    if (this.goalGlow > 0) this.goalGlow = Math.max(0, this.goalGlow - dt * 0.0015);
    if (this.netShake > 0.5) this.netShake *= this.netShakeDecay;
    else this.netShake = 0;
  }

  clear(w, h) {
    this.ctx.clearRect(0, 0, w, h);
  }

  /** Snap to physical pixels for sharper sprites */
  _snap(v) {
    const d = this.dpr || 1;
    return Math.round(v * d) / d;
  }

  _setSmoothing(ctx, enabled = true) {
    ctx.imageSmoothingEnabled = enabled;
    if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = "high";
  }

  _drawImageSmooth(img, x, y, w, h) {
    const { ctx } = this;
    const sx = this._snap(x);
    const sy = this._snap(y);
    const sw = this._snap(w);
    const sh = this._snap(h);
    ctx.save();
    this._setSmoothing(ctx, true);
    ctx.drawImage(img, sx, sy, sw, sh);
    ctx.restore();
  }

  _drawBackgroundCover(img, L) {
    if (!img || !img.complete || img.naturalWidth === 0) return false;
    const { ctx } = this;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const scale = Math.max(L.w / iw, L.h / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    const dx = (L.w - dw) / 2;
    const dy = (L.h - dh) / 2;
    ctx.save();
    this._setSmoothing(ctx, true);
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.restore();
    return true;
  }

  drawScene(time, state) {
    const L = this.layout;
    if (this._drawBackgroundCover(this.bgPlay, L)) return true;
    this._drawSky(L, time);
    this._drawCrowd(L);
    this._drawCelebrationRays(L);
    this._drawAdBoard(L);
    this._drawField(L);
    this._drawGoal(L);
    this._drawNet(L);
    return true;
  }

  _drawSky(L, time) {
    const { ctx, w, h } = { ctx: this.ctx, w: L.w, h: L.h };
    const grad = ctx.createLinearGradient(0, 0, 0, h * 0.55);
    grad.addColorStop(0, "#1f97ff");
    grad.addColorStop(1, "#61c2ff");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h * 0.55);

    // Sparkles
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    const seeds = [0.12, 0.28, 0.45, 0.62, 0.78, 0.9];
    seeds.forEach((s, i) => {
      const x = w * s;
      const y = h * (0.08 + (i % 3) * 0.06) + Math.sin(time * 0.002 + i) * 4;
      this._drawStar(x, y, 5 + (i % 2) * 2);
    });

    // Reference-like edge clouds
    this._drawCloud(w * 0.02, h * 0.13, w * 0.2);
    this._drawCloud(w * 0.92, h * 0.11, w * 0.18);
    this._drawCloud(w * 0.84, h * 0.28, w * 0.15);
    this._drawCloud(w * 0.16, h * 0.28, w * 0.12);
  }

  _drawStar(x, y, r) {
    const { ctx } = this;
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      ctx.rotate(Math.PI / 4);
      ctx.moveTo(0, -r);
      ctx.lineTo(0, -r * 0.3);
    }
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  _drawCloud(x, y, size) {
    const { ctx } = this;
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.beginPath();
    ctx.arc(x, y, size * 0.28, 0, Math.PI * 2);
    ctx.arc(x + size * 0.3, y - size * 0.08, size * 0.36, 0, Math.PI * 2);
    ctx.arc(x + size * 0.62, y, size * 0.27, 0, Math.PI * 2);
    ctx.arc(x + size * 0.15, y + size * 0.18, size * 0.18, 0, Math.PI * 2);
    ctx.arc(x + size * 0.5, y + size * 0.16, size * 0.2, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawCrowd(L) {
    const { ctx } = this;
    const y0 = L.h * 0.16;
    const y1 = L.goalY + 2;
    ctx.fillStyle = "#1671d2";
    ctx.fillRect(0, y0, L.w, y1 - y0);

    // Bokeh crowd dots
    for (let i = 0; i < 170; i++) {
      const x = (i * 83 + 29) % L.w;
      const y = y0 + ((i * 47) % (y1 - y0 - 8));
      const r = 5 + (i % 3);
      ctx.fillStyle = `rgba(${120 + (i % 50)}, ${190 + (i % 45)}, 255, ${0.18 + (i % 3) * 0.12})`;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawCelebrationRays(L) {
    if (this.goalGlow < 0.08) return;
    const { ctx } = this;
    const alpha = Math.min(0.85, this.goalGlow * 0.95);
    const cx = L.w * 0.5;
    const cy = L.goalY + L.goalH * 0.55;
    const rays = [
      { angle: -1.15, color: "#ffde59", width: 36 },
      { angle: -0.9, color: "#ff8359", width: 28 },
      { angle: -0.65, color: "#38d7e8", width: 32 },
      { angle: -0.4, color: "#f9a9ff", width: 24 },
      { angle: 0.4, color: "#f9a9ff", width: 24 },
      { angle: 0.65, color: "#38d7e8", width: 32 },
      { angle: 0.9, color: "#ff8359", width: 28 },
      { angle: 1.15, color: "#ffde59", width: 36 },
    ];

    ctx.save();
    ctx.globalAlpha = alpha;
    rays.forEach((ray) => {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ray.angle);
      ctx.fillStyle = ray.color;
      ctx.beginPath();
      ctx.moveTo(-ray.width / 2, 0);
      ctx.lineTo(ray.width / 2, 0);
      ctx.lineTo(ray.width * 0.35, -L.h * 0.65);
      ctx.lineTo(-ray.width * 0.35, -L.h * 0.65);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    });
    ctx.restore();
  }

  _drawAdBoard(L) {
    const { ctx } = this;
    const y = L.goalY + L.goalH * 0.52;
    const h = L.h * 0.09;
    ctx.fillStyle = "#145fc7";
    ctx.beginPath();
    ctx.moveTo(0, y + h);
    ctx.lineTo(0, y + h * 0.24);
    ctx.quadraticCurveTo(L.w * 0.5, y - h * 0.2, L.w, y + h * 0.24);
    ctx.lineTo(L.w, y + h);
    ctx.closePath();
    ctx.fill();

    // Accent circles
    ctx.fillStyle = "#4ce6c2";
    [0.15, 0.85].forEach((fx) => {
      ctx.beginPath();
      ctx.arc(L.w * fx, y + h * 0.55, 8, 0, Math.PI * 2);
      ctx.fill();
    });

    // Logo-like text blocks to mimic reference boards.
    const drawLogo = (x, y0) => {
      const colors = ["#ffd54d", "#4dd0e1", "#7e57c2", "#66bb6a", "#ef5350", "#42a5f5"];
      const r = Math.max(3, L.w * 0.007);
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI * 2 * i) / 6;
        ctx.fillStyle = colors[i];
        ctx.beginPath();
        ctx.arc(x + Math.cos(a) * r * 1.6, y0 + Math.sin(a) * r * 1.6, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(x, y0, r * 0.85, 0, Math.PI * 2);
      ctx.fill();
    };

    const drawBoardText = (x, align = "left") => {
      ctx.save();
      ctx.textAlign = align;
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#f4f9ff";
      ctx.font = `700 ${Math.max(14, L.w * 0.015)}px "Segoe UI", sans-serif`;
      ctx.fillText("elastic", x, y + h * 0.58);
      ctx.font = `400 ${Math.max(8, L.w * 0.008)}px "Segoe UI", sans-serif`;
      ctx.fillStyle = "rgba(244,249,255,0.95)";
      ctx.fillText("The Search", align === "left" ? x + L.w * 0.09 : x - L.w * 0.09, y + h * 0.51);
      ctx.fillText("AI Company", align === "left" ? x + L.w * 0.09 : x - L.w * 0.09, y + h * 0.66);
      ctx.restore();
    };
    drawLogo(L.w * 0.17, y + h * 0.58);
    drawLogo(L.w * 0.83, y + h * 0.58);
    drawBoardText(L.w * 0.2, "left");
    drawBoardText(L.w * 0.8, "right");
  }

  _drawField(L) {
    const { ctx } = this;
    const grad = ctx.createLinearGradient(0, L.goalY, 0, L.h);
    grad.addColorStop(0, "#95da2f");
    grad.addColorStop(1, "#8fd82d");
    ctx.fillStyle = grad;
    ctx.fillRect(0, L.goalY - 5, L.w, L.h - L.goalY + 5);

    // Penalty line
    const lineY = L.ballStartY - L.ballRadius * 1.5;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(L.w * 0.12, lineY);
    ctx.lineTo(L.w * 0.88, lineY);
    ctx.stroke();

    // Perspective lines
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(0, L.h);
    ctx.lineTo(L.goalX, L.goalY + L.goalH);
    ctx.moveTo(L.w, L.h);
    ctx.lineTo(L.goalX + L.goalW, L.goalY + L.goalH);
    ctx.stroke();

    // Center lane line (faint, like reference)
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.moveTo(L.w * 0.58, L.h);
    ctx.lineTo(L.w * 0.52, L.goalY + L.goalH + 4);
    ctx.stroke();
  }

  _drawGoal(L) {
    const { ctx } = this;
    const { goalX, goalY, goalW, goalH } = L;

    if (this.goalGlow > 0) {
      ctx.save();
      ctx.shadowColor = `rgba(255, 230, 100, ${this.goalGlow})`;
      ctx.shadowBlur = 30 + this.goalGlow * 40;
      ctx.fillStyle = `rgba(255, 240, 150, ${this.goalGlow * 0.25})`;
      ctx.fillRect(goalX - 10, goalY - 10, goalW + 20, goalH + 20);
      ctx.restore();
    }

    // Posts
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 6.5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(goalX, goalY + goalH);
    ctx.lineTo(goalX, goalY);
    ctx.lineTo(goalX + goalW, goalY);
    ctx.lineTo(goalX + goalW, goalY + goalH);
    ctx.stroke();
  }

  _drawNet(L) {
    const { ctx } = this;
    const { goalX, goalY, goalW, goalH } = L;
    const shake = Math.sin(Date.now() * 0.04) * this.netShake;

    // Goal interior background
    ctx.fillStyle = "rgba(200, 230, 255, 0.22)";
    ctx.fillRect(goalX, goalY, goalW, goalH);

    ctx.save();
    ctx.strokeStyle = "rgba(160, 215, 255, 0.52)";
    ctx.lineWidth = 1;
    const cols = 18;
    const rows = 10;
    for (let c = 0; c <= cols; c++) {
      const x = goalX + (goalW * c) / cols + shake * 0.1 * (c % 2);
      ctx.beginPath();
      ctx.moveTo(x, goalY);
      ctx.lineTo(x + shake * 0.05, goalY + goalH);
      ctx.stroke();
    }
    for (let r = 0; r <= rows; r++) {
      const y = goalY + (goalH * r) / rows;
      ctx.beginPath();
      ctx.moveTo(goalX, y);
      ctx.lineTo(goalX + goalW, y + shake * 0.08 * (r % 2));
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Goalkeeper gloves sprite (hi-res transparent PNG) */
  drawKeeperHands(keeper) {
    const img = this.spriteGloves;
    if (!img.complete || img.naturalWidth === 0) return;

    const L = this.layout;
    const cx = keeper.displayX;
    const cy = keeper.displayY;
    const w = Math.min(L.keeperGloveW(), img.naturalWidth, KEEPER.GLOVE_NATIVE_W);
    const h = Math.round(w * (img.naturalHeight / img.naturalWidth));

    const { ctx } = this;
    const sx = this._snap(cx - w / 2);
    const sy = this._snap(cy - h / 2);
    ctx.save();
    ctx.imageSmoothingEnabled = w >= img.naturalWidth;
    if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, sx, sy, w, h);
    ctx.restore();
  }

  /** Football sprite */
  drawBall(ball) {
    const img = this.spriteBall;
    const { ctx } = this;
    const L = this.layout;
    const size = L.ballRadius * 2.2 * ball.scale;
    const bx = this._snap(ball.x);
    const by = this._snap(ball.y);

    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.16)";
    ctx.beginPath();
    ctx.ellipse(
      bx,
      by + size * 0.42,
      size * 0.55,
      size * 0.16,
      0,
      0,
      Math.PI * 2
    );
    ctx.fill();
    ctx.restore();

    if (img.complete && img.naturalWidth > 0) {
      ctx.save();
      this._setSmoothing(ctx, true);
      ctx.translate(bx, by);
      ctx.rotate(ball.rotation);
      const hs = this._snap(size);
      ctx.drawImage(img, -hs / 2, -hs / 2, hs, hs);
      ctx.restore();
    }
  }

  /** Shows exact shot target while aiming */
  drawAimMarker(aimX, aimY) {
    const L = this.layout;
    const clamped = L.clampAim(aimX, aimY);
    const p = L.aimToGoal(clamped.aimX, clamped.aimY);
    const preview = L.scoreZone(p.x, p.y);
    const { ctx } = this;

    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.45)";
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(L.ballStartX, L.ballStartY);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "rgba(255, 230, 80, 0.95)";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.lineWidth = 2;
    const markerR = Math.max(9, L.w * (isMobileLayout() ? 0.016 : 0.011));
    ctx.beginPath();
    ctx.arc(p.x, p.y, markerR, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    if (preview.points > 0) {
      const fontSize = Math.max(13, L.w * 0.028);
      ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.strokeStyle = "rgba(0,0,0,0.45)";
      ctx.lineWidth = 3;
      const label = `+${preview.points}`;
      ctx.strokeText(label, p.x, p.y - 16);
      ctx.fillText(label, p.x, p.y - 16);
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// UI — DOM score, chances, prompts
// ---------------------------------------------------------------------------

class UI {
  constructor() {
    this.scoreCardEl = document.getElementById("score-card");
    this.scoreEl = document.getElementById("score-display");
    this.promptEl = document.getElementById("prompt");
    this.promptText = document.getElementById("prompt-text");
    this.feedbackEl = document.getElementById("shot-feedback");
    this.chancesEl = document.getElementById("chances");
    this.countdownEl = document.getElementById("countdown");
    this.countdownNum = document.getElementById("countdown-num");
    this.shootBtn = document.getElementById("shoot-btn");
    this.mobileBar = document.getElementById("mobile-bar");
    this.mobileHint = document.getElementById("mobile-hint");
    this.gameOverEl = document.getElementById("game-over");
    this.resultsPanelEl = document.getElementById("results-panel");
    this.confettiLayer = document.getElementById("confetti-layer");
    this.finalScoreEl = document.getElementById("final-score");
    this.featuredCardSlotEl = document.getElementById("featured-card-slot");
    this.restartBtn = document.getElementById("restart-btn");
    this.dashboardBtn = document.getElementById("dashboard-btn");
    this.videoBreakEl = document.getElementById("video-break");
    this.rewardVideoEl = document.getElementById("reward-video");
    this.videoCountdownEl = document.getElementById("video-countdown");
    this.continueBtn = document.getElementById("continue-btn");
    this.uiOverlayEl = document.getElementById("ui-overlay");
    this.videoTimer = null;

    this._buildChanceDots();
  }

  _buildChanceDots() {
    this.chancesEl.innerHTML = "";
    this.dots = [];
    for (let i = 0; i < TOTAL_SHOTS; i++) {
      const dot = document.createElement("span");
      dot.className = "chance-dot";
      dot.setAttribute("aria-hidden", "true");
      this.chancesEl.appendChild(dot);
      this.dots.push(dot);
    }
  }

  setScore(score) {
    this.scoreEl.textContent = `0 - ${score}`;
    this.scoreEl.classList.remove("pop");
    void this.scoreEl.offsetWidth;
    this.scoreEl.classList.add("pop");
  }

  setGoalCelebration(on) {
    this.scoreCardEl.classList.toggle("celebrate", on);
  }

  updateChances(shotIndex) {
    this.dots.forEach((dot, i) => {
      dot.classList.remove("current", "used");
      if (i < shotIndex) dot.classList.add("used");
      else if (i === shotIndex) dot.classList.add("current");
    });
  }

  showPrompt(text, mobileHint = "") {
    if (isMobileLayout()) {
      if (this.mobileHint) {
        this.mobileHint.textContent = mobileHint || text;
      }
      if (this.mobileBar) {
        this.mobileBar.classList.remove("hidden");
        this.mobileBar.setAttribute("aria-hidden", "false");
      }
      this.promptEl.classList.add("hidden");
      return;
    }
    this.promptText.textContent = text;
    this.promptEl.classList.remove("hidden");
  }

  hidePrompt() {
    this.promptEl.classList.add("hidden");
    if (this.mobileBar) {
      this.mobileBar.classList.add("hidden");
      this.mobileBar.setAttribute("aria-hidden", "true");
    }
  }

  showFeedback(text, isGoal) {
    this.feedbackEl.textContent = text;
    this.feedbackEl.style.color = isGoal ? "#fff59d" : "#ffcdd2";
    this.feedbackEl.classList.remove("hidden", "show");
    void this.feedbackEl.offsetWidth;
    this.feedbackEl.classList.add("show");
    setTimeout(() => this.feedbackEl.classList.add("hidden"), 900);
  }

  showCountdown(n) {
    this.countdownNum.textContent = String(n);
    this.countdownEl.classList.remove("hidden");
    void this.countdownEl.offsetWidth;
  }

  hideCountdown() {
    this.countdownEl.classList.add("hidden");
  }

  _launchConfetti() {
    this.confettiLayer.innerHTML = "";
    const colors = ["#2ecc71", "#27ae60", "#f1c40f", "#fff", "#3498db", "#e74c3c"];
    for (let i = 0; i < 70; i++) {
      const p = document.createElement("div");
      p.className = "confetti-piece";
      p.style.left = `${Math.random() * 100}%`;
      p.style.background = colors[i % colors.length];
      p.style.animationDuration = `${2 + Math.random() * 2}s`;
      p.style.animationDelay = `${Math.random() * 0.8}s`;
      p.style.width = `${6 + Math.random() * 6}px`;
      p.style.height = `${10 + Math.random() * 8}px`;
      this.confettiLayer.appendChild(p);
    }
    setTimeout(() => {
      this.confettiLayer.innerHTML = "";
    }, 4500);
  }

  _showRewardCard(score) {
    const unlocked = getWinCard(score);
    this.featuredCardSlotEl.innerHTML = "";

    if (unlocked) {
      const featured = document.createElement("img");
      featured.className = "reward-card-image";
      featured.src = unlocked.image;
      featured.alt = `${unlocked.role} card`;
      featured.loading = "eager";
      this.featuredCardSlotEl.appendChild(featured);
      return;
    }

    const placeholder = document.createElement("p");
    placeholder.className = "featured-empty";
    placeholder.textContent =
      "Score 280 or more to reveal your player card";
    this.featuredCardSlotEl.appendChild(placeholder);
  }

  showGameOver(score, _stats, playCheer) {
    this.hidePrompt();
    this.uiOverlayEl.classList.add("hidden");
    this.gameOverEl.classList.remove("hidden");
    this.resultsPanelEl.classList.remove("hidden");
    this.hideVideoBreak();
    if (playCheer) playCheer();

    this.finalScoreEl.textContent = String(score);
    this._showRewardCard(score);

    if (score >= 280) {
      setTimeout(() => this._launchConfetti(), 400);
    }
  }

  hideGameOver() {
    this.confettiLayer.innerHTML = "";
    this.hideVideoBreak();
    this.gameOverEl.classList.add("hidden");
    this.uiOverlayEl.classList.remove("hidden");
  }

  showVideoBreak() {
    this.confettiLayer.innerHTML = "";
    this.resultsPanelEl.classList.add("hidden");
    this.videoBreakEl.classList.remove("hidden");
    this.continueBtn.classList.add("hidden");
    this.continueBtn.disabled = false;
    this.rewardVideoEl.src = "";

    window.open(PLAY_AGAIN_FORM_URL, "_blank", "noopener,noreferrer");

    let secondsLeft = FORM_UNLOCK_SECONDS;
    const updateCountdown = () => {
      this.videoCountdownEl.innerHTML =
        `Please fill the form. Play Again unlocks in <strong>${secondsLeft}</strong>s`;
    };

    updateCountdown();

    clearInterval(this.videoTimer);
    this.videoTimer = setInterval(() => {
      secondsLeft--;
      if (secondsLeft <= 0) {
        clearInterval(this.videoTimer);
        this.videoTimer = null;
        this.videoCountdownEl.textContent = "Thank you. You can play again with the same score.";
        this.continueBtn.classList.remove("hidden");
        this.continueBtn.focus();
        return;
      }
      updateCountdown();
    }, 1000);
  }

  hideVideoBreak() {
    clearInterval(this.videoTimer);
    this.videoTimer = null;
    this.rewardVideoEl.src = "";
    this.videoBreakEl.classList.add("hidden");
    this.continueBtn.classList.add("hidden");
  }
}

// ---------------------------------------------------------------------------
// Game — main loop & state machine
// ---------------------------------------------------------------------------

const GameState = {
  SIGNUP: "signup",
  COUNTDOWN: "countdown",
  READY: "ready",
  SHOOTING: "shooting",
  RESULT: "result",
  GAME_OVER: "game_over",
};

class Game {
  constructor() {
    this.canvas = document.getElementById("game-canvas");
    this.ctx = this.canvas.getContext("2d");
    this.gameWrapper = document.getElementById("game-wrapper");
    this.gameStage = document.getElementById("game-stage");
    this.rotateNotice = document.getElementById("rotate-notice");
    this.audio = new AudioManager();
    this.audio._loadBuffers().catch(() => {});
    this.input = new InputManager(
      this.canvas,
      this.gameStage,
      document.getElementById("shoot-btn")
    );
    this.ui = new UI();
    this.signupModal = document.getElementById("signup-modal");
    this.signupForm = document.getElementById("signup-form");
    this.playerNameInput = document.getElementById("player-name");
    this.signupButton = this.signupForm.querySelector(".signup-submit");
    this.signupButtonAnimation = document.getElementById("signup-button-animation");

    this.layout = new Layout(800, 600);
    this.renderer = new Renderer(this.ctx, this.layout);
    this.ball = new Ball(this.layout);
    this.keeper = new Goalkeeper(this.layout);
    this.keeperAI = new KeeperAI();
    this.lastAimX = 0.5;
    this.lastAimY = 0.35;

    this.keeperStrength = 1.12;
    this.cornerRepeatCount = { TL: 0, TR: 0 };

    this.state = GameState.SIGNUP;
    this.userDetails = null;
    this.score = 0;
    this.shotIndex = 0;
    this.countdownValue = COUNTDOWN_START;
    this.countdownTimer = 0;
    this.resultTimer = 0;
    this.lastResult = null;
    this.lastTime = 0;
    this.running = true;
    this.ballCaught = false;
    this.videoCount = 0;
    this._resetMatchStats();

    this.ui.setScore(0);
    this.renderer.onBackgroundReady = () => this._syncGoalBounds();
    this._resize();
    requestAnimationFrame(() => this._resize());
    setTimeout(() => this._resize(), 150);
    this._onViewportChange = () => {
      this._updateLandscapeLock();
      requestAnimationFrame(() => this._resize());
    };
    this._updateLandscapeLock();
    window.addEventListener("resize", this._onViewportChange);
    window.addEventListener("orientationchange", this._onViewportChange);
    window.visualViewport?.addEventListener("resize", this._onViewportChange);
    window.visualViewport?.addEventListener("scroll", this._onViewportChange);
    this.ui.restartBtn.addEventListener("click", () => this._startVideoBreak());
    this.ui.dashboardBtn.addEventListener("click", () => this.viewDashboard());
    this.ui.continueBtn.addEventListener("click", () => this.continueGame());
    this.signupForm.addEventListener("submit", (event) => this._submitSignup(event));
    this._bindCrowdAudio();
    this._bindScrollLock();
    this._initSignupButton();

    requestAnimationFrame((t) => this._loop(t));
    requestAnimationFrame(() => this.playerNameInput.focus());
  }

  _initSignupButton() {
    if (!window.lottie || !this.signupButtonAnimation) return;

    const animation = window.lottie.loadAnimation({
      container: this.signupButtonAnimation,
      renderer: "svg",
      loop: true,
      autoplay: true,
      path: "assets/Start button.json",
    });

    animation.addEventListener("DOMLoaded", () => {
      this.signupButton.classList.add("lottie-ready");
    });
  }

  _submitSignup(event) {
    event.preventDefault();
    if (!this.signupForm.reportValidity()) return;

    const formData = new FormData(this.signupForm);
    this.userDetails = {
      name: String(formData.get("name")).trim(),
      email: String(formData.get("email")).trim(),
      username: String(formData.get("username")).trim(),
    };

    try {
      localStorage.setItem("penaltyPlayer", JSON.stringify(this.userDetails));
    } catch {
      // The game can still start when browser storage is unavailable.
    }

    this.signupModal.classList.add("hidden");
    this.state = GameState.COUNTDOWN;
    this.countdownValue = COUNTDOWN_START;
    this.countdownTimer = 0;
    this.lastTime = 0;
    this.input.shootPressed = false;
    this._updateLandscapeLock();
    this._startCrowdIfNeeded();
  }

  _bindScrollLock() {
    const block = (e) => {
      if (!e.target.closest(".modal, .results-modal, .signup-card")) e.preventDefault();
    };
    document.addEventListener("touchmove", block, { passive: false });
    window.addEventListener("scroll", () => window.scrollTo(0, 0), { passive: true });
  }

  _updateLandscapeLock() {
    const locked = isPhonePortrait();
    document.body.classList.toggle("needs-landscape", locked);
    if (this.rotateNotice) {
      this.rotateNotice.classList.toggle("hidden", !locked);
      this.rotateNotice.setAttribute("aria-hidden", locked ? "false" : "true");
    }
  }

  async _tryLockLandscape() {
    if (!isMobileLayout()) return;
    try {
      await screen.orientation?.lock?.("landscape-primary");
    } catch {
      try {
        await screen.orientation?.lock?.("landscape");
      } catch {
        /* Browser may block without installed PWA / fullscreen */
      }
    }
  }

  /** Browsers block audio until the player interacts */
  _bindCrowdAudio() {
    let didUnlock = false;
    const unlock = () => {
      if (!didUnlock) {
        didUnlock = true;
        this._tryLockLandscape();
      }
      this._startCrowdIfNeeded();
    };
    ["pointerdown", "touchstart", "click", "keydown"].forEach((ev) => {
      document.addEventListener(ev, unlock, { passive: true });
    });
    this._unlockAudio = unlock;
  }

  async _startCrowdIfNeeded() {
    await this.audio.unlock();
    this.audio.startCrowdAmbience();
  }

  _syncGoalBounds() {
    const w = this.layout.w || window.innerWidth;
    const h = this.layout.h || window.innerHeight;
    this.layout.syncGoalToBackground(this.renderer.bgPlay, w, h);
    this.ball.layout = this.layout;
    this.keeper.layout = this.layout;
    this.renderer.layout = this.layout;
  }

  _syncAppViewport() {
    const vv = window.visualViewport;
    const w = Math.floor(vv?.width ?? window.innerWidth);
    const h = Math.floor(vv?.height ?? window.innerHeight);
    const root = document.documentElement;
    root.style.setProperty("--app-w", `${w}px`);
    root.style.setProperty("--app-h", `${h}px`);
    if (window.scrollY !== 0 || window.scrollX !== 0) {
      window.scrollTo(0, 0);
    }
    return { w, h };
  }

  _stageSize() {
    this._syncAppViewport();
    const stage = this.gameStage || this.gameWrapper;
    const rect = stage.getBoundingClientRect();
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);
    if (w > 0 && h > 0) return { w, h };
    const vv = window.visualViewport;
    return {
      w: Math.floor(vv?.width ?? window.innerWidth),
      h: Math.floor(vv?.height ?? window.innerHeight),
    };
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const mobile = isMobileLayout();
    this.input.setMobileMode(mobile);
    const { w, h } = this._stageSize();
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.renderer.dpr = dpr;
    this.layout.update(w, h);
    this.layout.syncGoalToBackground(this.renderer.bgPlay, w, h);
    this.ball.layout = this.layout;
    this.keeper.layout = this.layout;
    this.renderer.layout = this.layout;
    const L = this.layout;
    this.input.pointerX = (L.goalX + L.goalW * 0.5) / L.w;
    this.input.pointerY = (L.goalY + L.goalH * 0.38) / L.h;
    this._syncAimFromPointer();
    if (this.state === GameState.READY || this.state === GameState.COUNTDOWN) {
      this.ball.reset();
      this.keeper.reset();
    }
  }

  _resetMatchStats() {
    this.matchStats = {
      shotsTaken: 0,
      goals: 0,
      bestShot: null,
    };
  }

  _recordShotResult(result) {
    this.matchStats.shotsTaken++;
    if (result.points > 0) {
      this.matchStats.goals++;
      if (
        !this.matchStats.bestShot ||
        result.points > this.matchStats.bestShot.points
      ) {
        this.matchStats.bestShot = {
          points: result.points,
          label: result.label,
        };
      }
    }
  }

  _enterGameOver() {
    this.state = GameState.GAME_OVER;
    this.gameWrapper.classList.add("game-ended");
    this.audio.stopCrowdAmbience(0.5);
    this._saveScore();
    const L = this.layout;
    const dpr = this.renderer.dpr || 1;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.fillStyle = "#0c2340";
    this.ctx.fillRect(0, 0, L.w, L.h);
    this.ui.showGameOver(this.score, this.matchStats, () =>
      this.audio.playCrowdCheer()
    );
  }

  async _saveScore() {
    if (!this.userDetails) return;

    const payload = new URLSearchParams({
      name: this.userDetails.name,
      email: this.userDetails.email,
      username: this.userDetails.username,
      score: String(this.score),
      videoCount: String(this.videoCount),
    });

    try {
      await fetch(SCORE_API_URL, {
        method: "POST",
        mode: "no-cors",
        body: payload,
        keepalive: true,
      });
    } catch (error) {
      console.warn("Could not save score to Google Sheets.", error);
    }
  }

  async viewDashboard() {
    this.ui.dashboardBtn.disabled = true;
    this.ui.dashboardBtn.textContent = "Saving...";

    await Promise.race([
      this._saveScore(),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);

    window.location.assign(DASHBOARD_URL);
  }

  _startVideoBreak() {
    if (this.videoCount === 0) {
      this.ui.showVideoBreak();
      return;
    }

    this.continueGame(true);
  }

  continueGame(force = false) {
    if (!force && this.ui.continueBtn.disabled) return;
    this.ui.continueBtn.disabled = true;
    this.videoCount++;
    this.audio._ensureContext();
    this.audio.stopCrowdAmbience(0.3);
    this.gameWrapper.classList.remove("game-ended");
    this.ui.hideGameOver();
    this._resetMatchStats();
    this.shotIndex = 0;
    this.ui.setScore(this.score);
    this.ui.updateChances(0);
    this.state = GameState.COUNTDOWN;
    this.countdownValue = COUNTDOWN_START;
    this.countdownTimer = 0;
    this.lastTime = 0;
    this.input.shootPressed = false;
    this.ball.reset();
    this.keeper.reset();
    this.keeperAI.reset();
    this.keeperStrength = 1.12;
    this.cornerRepeatCount = { TL: 0, TR: 0 };
    this.renderer.goalGlow = 0;
    this.renderer.netShake = 0;
  }

  _loop(timestamp) {
    if (!this.running) return;
    const dt = this.lastTime ? timestamp - this.lastTime : 16;
    this.lastTime = timestamp;

    this._update(dt, timestamp);
    this._draw(timestamp);
    requestAnimationFrame((t) => this._loop(t));
  }

  _update(dt, time) {
    this.renderer.updateEffects(dt);
    this.ui.setGoalCelebration(this.renderer.goalGlow > 0.2);

    switch (this.state) {
      case GameState.COUNTDOWN:
        this._updateCountdown(dt);
        break;
      case GameState.READY:
        this._updateReady(dt);
        break;
      case GameState.SHOOTING:
        this._updateShooting(dt);
        break;
      case GameState.RESULT:
        this._updateResult(dt);
        break;
      default:
        break;
    }
  }

  _updateCountdown(dt) {
    this.countdownTimer += dt;
    if (this.countdownTimer >= 900) {
      this.countdownTimer = 0;
      this.countdownValue--;
      if (this.countdownValue > 0) {
        this.ui.showCountdown(this.countdownValue);
      } else {
        this.ui.hideCountdown();
        this.state = GameState.READY;
        this.input.shootPressed = false;
        this._startCrowdIfNeeded();
        this.ui.showPrompt(
          this.keeperAI.getPromptHint(),
          this.keeperAI.getMobileHint()
        );
        this.ui.updateChances(0);
      }
    } else if (this.countdownValue === COUNTDOWN_START && this.countdownTimer < 50) {
      this.ui.showCountdown(this.countdownValue);
    }
  }

  _syncAimFromPointer() {
    const L = this.layout;
    const px = this.input.pointerX * L.w;
    const py = this.input.pointerY * L.h;
    const aim = L.screenToAim(px, py);
    this.input.aimX = aim.aimX;
    this.input.aimY = aim.aimY;
  }

  _updateReady(dt) {
    if (isPhonePortrait()) return;

    this._syncAimFromPointer();
    this.keeper.anticipate(this.input.aimX, this.input.aimY, this.keeperAI);
    this.keeper.update(dt, false);
    this.ball.update(dt, true);

    if (this.input.consumeShoot()) {
      this._shoot();
    }
  }

  /** Small spread; repeats penalized more than first-time corners */
  _shotAccuracy(aimX, aimY) {
    const similar = this.keeperAI.countSimilar(aimX, aimY);
    const isCorner =
      (aimY < 0.28 || aimY > 0.72) && (aimX < 0.22 || aimX > 0.78);
    const isSide = !isCorner && (aimX < 0.32 || aimX > 0.68);
    const isTop = aimY < 0.3;
    let acc = isCorner ? 0.9 : isSide ? 0.93 : 0.95;
    if (isTop) acc = Math.min(0.96, acc + 0.02);
    acc += Math.random() * 0.015;
    if (similar >= 1) acc *= 0.74;
    if (similar >= 2) acc *= 0.85;
    return Math.max(0.66, acc);
  }

  _cornerPoints(cornerId) {
    const n = this.cornerRepeatCount[cornerId] || 0;
    const pts = CORNER_REPEAT_POINTS[Math.min(n, CORNER_REPEAT_POINTS.length - 1)];
    return pts;
  }

  async _shoot() {
    this.ui.hidePrompt();
    await this._startCrowdIfNeeded();
    this.audio.playKick();
    this.state = GameState.SHOOTING;
    this.ballCaught = false;

    this.lastAimX = this.input.aimX;
    this.lastAimY = this.input.aimY;

    const target = this.layout.aimToGoal(this.lastAimX, this.lastAimY);
    const clamped = this.layout.clampToGoal(target.x, target.y, {
      side: 4,
      top: 4,
      bottom: 2,
    });

    const accuracy = this._shotAccuracy(this.lastAimX, this.lastAimY);
    this.ball.startShot(clamped.x, clamped.y, accuracy);

    const ballEndX = this.ball.targetX;
    const ballEndY = this.ball.targetY;

    this.lastPlan = this.keeperAI.planDive(this.lastAimX, this.lastAimY);
    this.keeper.strengthFactor = this.keeperStrength;
    this.keeper.commitDive(
      this.lastPlan,
      this.layout,
      this.lastPlan.chaseBall ? ballEndX : null,
      this.lastPlan.chaseBall ? ballEndY : null
    );
    this.pendingZone = this.layout.scoreZone(ballEndX, ballEndY).zone;
  }

  _updateShooting(dt) {
    this.keeper.update(dt, true);
    const done = this.ball.update(dt, false);

    const zone =
      this.pendingZone ||
      this.layout.scoreZone(this.ball.x, this.ball.y).zone;

    if (this.keeper.blocks(this.ball.x, this.ball.y, zone, this.ball.progress)) {
      this.ballCaught = true;
      this.ball.shooting = false;
      this.ball.x = this.keeper.displayX;
      this.ball.y = this.keeper.displayY;
      this._resolveShot(true);
      return;
    }

    if (done) {
      this._resolveShot(false);
    }
  }

  _isSave() {
    if (this.ballCaught) return true;
    const { x, y } = this.ball;
    const zones = ["corner", "side", "center"];
    return zones.some((z) => this.keeper.blocks(x, y, z, 1));
  }

  _resolveShot(savedInFlight = false) {
    const scoreX = this.ball.targetX;
    const scoreY = this.ball.targetY;

    if (savedInFlight || this._isSave()) {
      let readMsg = "Saved!";
      if (this.lastPlan?.repeatRead) readMsg = "Keeper was waiting!";
      else if (this.keeper.readGood) readMsg = "Great save!";
      this.keeperAI.record(this.lastAimX, this.lastAimY);
      const saveResult = { points: POINTS.MISS, label: readMsg, zone: "save" };
      this.lastResult = saveResult;
      this._recordShotResult(saveResult);
      this.ui.setScore(this.score);
      this.ui.hidePrompt();
      this.audio.playMiss();
      this.renderer.triggerMissEffect();
      this.ui.showFeedback(readMsg, false);
      this.shotIndex++;
      this.state = GameState.RESULT;
      this.resultTimer = 0;
      this.keeperStrength = Math.max(1.05, this.keeperStrength - 0.012);
      return;
    }

    let result = this.layout.scoreZone(scoreX, scoreY);

    this.keeperAI.record(this.lastAimX, this.lastAimY);

    if (result.points > 0) {
      this.keeperStrength = Math.min(1.18, this.keeperStrength + 0.028);
    } else {
      this.keeperStrength = Math.max(1.05, this.keeperStrength - 0.012);
    }

    this.lastResult = result;
    this.score += result.points;
    this._recordShotResult(result);
    this.ui.setScore(this.score);

    this.ui.hidePrompt();
    if (result.points > 0) {
      this.audio.playGoal();
      this.renderer.triggerGoalEffect();
      this.ui.showFeedback(result.label, true);
    } else {
      this.audio.playMiss();
      this.renderer.triggerMissEffect();
      this.ui.showFeedback(result.label, false);
    }

    this.shotIndex++;
    this.state = GameState.RESULT;
    this.resultTimer = 0;
  }

  _updateResult(dt) {
    this.resultTimer += dt;
    if (this.resultTimer >= RESULT_PAUSE_MS) {
      if (this.shotIndex >= TOTAL_SHOTS) {
        this._enterGameOver();
      } else {
        this._nextShot();
      }
    }
  }

  _nextShot() {
    this.state = GameState.READY;
    this.input.shootPressed = false;
    this.pendingZone = null;
    this.ball.reset();
    this.keeper.reset();
    this.keeper.diving = false;
    this.ui.hidePrompt();

    if (this.keeperAI.history.length > 0) {
      const last = this.keeperAI.history[this.keeperAI.history.length - 1];
      const L = this.layout;
      const cx = L.goalX + L.goalW * 0.5;
      const campX = last.aimX;
      const campY = last.aimY;
      this.keeper.targetX = cx + (campX - 0.5) * L.goalW * 0.42;
      this.keeper.targetY = L.keeperY + (campY - 0.4) * L.goalH * 0.35;
      this.keeper.displayX = this.keeper.targetX;
      this.keeper.displayY = this.keeper.targetY;
    }

    this.ui.updateChances(this.shotIndex);
    // Show aim hint only after shot feedback has finished
    setTimeout(() => {
      if (this.state === GameState.READY) {
        this.ui.showPrompt(
          this.keeperAI.getPromptHint(),
          this.keeperAI.getMobileHint()
        );
      }
    }, 950);
  }

  _draw(time) {
    if (this.state === GameState.GAME_OVER) return;

    const L = this.layout;
    this.renderer.clear(L.w, L.h);
    this.renderer.drawScene(time, this.state);
    this.renderer.drawKeeperHands(this.keeper);
    this.renderer.drawBall(this.ball);
    if (this.state === GameState.READY) {
      this.renderer.drawAimMarker(this.input.aimX, this.input.aimY);
    }
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

window.addEventListener("DOMContentLoaded", () => {
  new Game();
});
