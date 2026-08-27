/**
 * The naval theater: ocean, sky, boards, hulls, ordnance, and the camera rig.
 *
 * Ported from the original design's single-file scene. Deliberately free of React
 * and of any game rules — it renders what it is told and reports pointer intent,
 * so the same scene serves the online match (1v1 and 2v2) and the solo drill.
 * Three.js is a bundled dependency here rather than a CDN import.
 *
 * Board vocabulary: up to four slots, always viewer-relative — `you` (bottom
 * left), `ally` (bottom right, 2v2 only), `foeA` / `foeB` (top row). `you` and
 * `ally` show real hulls; `foeA` / `foeB` stay fogged until a hull sinks. A 1v1
 * or solo match only ever uses `you` and `foeA`, laid out exactly as the
 * original two-board table.
 */

import * as THREE from 'three';
import { BOARD, SHIP_DEFS, cellsFor, type Orient, type Placement, type ShipKey } from './rules';

export type Slot = 'you' | 'ally' | 'foeA' | 'foeB';
export const ALL_SLOTS: readonly Slot[] = ['you', 'ally', 'foeA', 'foeB'];

export type SlotSpec = {
  slot: Slot;
  name: string;
  team: 'red' | 'blue' | null;
  relation: 'self' | 'ally' | 'foe';
  /** Hulls hidden until sunk; the enemy fog blanket stays up. */
  fogged: boolean;
  eliminated: boolean;
};

export type BoardHit = { slot: Slot; idx: number };

export type ScenePhase = 'deploy' | 'battle' | 'over';

export type GhostSpec = {
  key: ShipKey;
  orient: Orient;
  /** Cells already taken by your other ships. */
  occupied: number[];
} | null;

export type SceneOptions = {
  canvas: HTMLCanvasElement;
  waveHeight?: number;
  fireColor?: string;
  onHover?: (hit: BoardHit | null) => void;
  onPick?: (hit: BoardHit) => void;
  onFatal?: (message: string) => void;
};

const TEAM_COLOR: Record<'red' | 'blue', number> = { red: 0xf05a3d, blue: 0x42c1d3 };

type ShipVisual = {
  key: ShipKey;
  mesh: THREE.Group;
  anim: AnimSpec[];
  bobPhase: number;
  baseY: number;
  placement: Placement | null;
  sunk: boolean;
  floating: boolean;
};

type AnimSpec = { o: THREE.Object3D; k: 'spin' | 'sweep'; s: number; ph?: number };

type BoardRig = {
  slot: Slot;
  grp: THREE.Group;
  pick: THREE.Mesh;
  pegW: THREE.InstancedMesh;
  pegR: THREE.InstancedMesh;
  ships: THREE.Group;
  col: THREE.Mesh;
  ret: THREE.Mesh;
  blanket: THREE.Mesh;
  rail: THREE.MeshStandardMaterial;
  plate: THREE.Mesh;
  plateMat: THREE.MeshBasicMaterial;
  basePos: THREE.Vector3;
  phase: number;
};

type Pose = { x: number; z: number; yaw: number };

const POSE_2: Partial<Record<Slot, Pose>> = {
  you: { x: -6.55, z: 0, yaw: -0.3 },
  foeA: { x: 6.55, z: 0, yaw: 0.3 },
};

const POSE_4: Partial<Record<Slot, Pose>> = {
  you: { x: -6.6, z: 7.0, yaw: -0.22 },
  ally: { x: 6.6, z: 7.0, yaw: 0.22 },
  foeA: { x: -6.6, z: -7.0, yaw: -0.14 },
  foeB: { x: 6.6, z: -7.0, yaw: 0.14 },
};

/** Camera defaults per table size — a wider table needs a higher, further-back eye. */
const CAM_2 = { ph: 0.36, rad: 30, radMobile: 38 };
const CAM_4 = { ph: 0.56, rad: 34, radMobile: 44 };

type Particle = {
  i: number;
  t: number;
  ttl: number;
  p: THREE.Vector3;
  v: THREE.Vector3;
  grav: number;
  drag: number;
  s0: number;
  s1: number;
  c0: THREE.Color;
  c1: THREE.Color;
  a0: number;
  a1: number;
  wind: number;
};

type Field = {
  pts: THREE.Points;
  free: number[];
  live: Particle[];
  cap: number;
  n: number;
  dirty: boolean;
};

type Tween = { t: number; d: number; fn: (u: number) => void; done?: () => void };

type Sfx = 'cannon' | 'whistle' | 'splash' | 'boom' | 'sink' | 'gull' | 'click';

const HORIZON_HEX = '#f1b477';

export class SeaBattleScene {
  private readonly canvas: HTMLCanvasElement;
  private readonly onHover?: (hit: BoardHit | null) => void;
  private readonly onPick?: (hit: BoardHit) => void;

  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private sunDir!: THREE.Vector3;
  private clock = new THREE.Clock();
  private raf = 0;
  private idleTimer = 0;
  private scheduled: 'raf' | 'idle' | null = null;
  private highRateUntil = 0;
  private lastFrameAt = 0;
  private t = 0;
  private amp: number;
  private fire: THREE.Color;
  private fireHex: string;

  private tex: Record<string, THREE.Texture> = {};
  private materials: Record<string, THREE.MeshStandardMaterial> = {};
  private ocean!: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private sky!: THREE.Mesh;
  private boards = new Map<Slot, BoardRig>();
  private visuals = new Map<Slot, Map<ShipKey, ShipVisual>>();
  private slotMeta = new Map<Slot, SlotSpec>();
  private rosterLength = 2;
  private actingSlot: Slot | null = null;

  private fieldAdd!: Field;
  private fieldNorm!: Field;
  private rings: THREE.Mesh[] = [];
  private balls: THREE.Mesh[] = [];
  private glows: THREE.Sprite[] = [];
  private cols: THREE.Mesh[] = [];
  private shells: THREE.Mesh[] = [];
  private slicks: THREE.Mesh[] = [];
  private tweens: Tween[] = [];
  private clouds: { sp: THREE.Sprite; v: number }[] = [];
  private gulls: {
    grp: THREE.Group;
    wl: THREE.Mesh;
    wr: THREE.Mesh;
    r: number;
    h: number;
    a: number;
    v: number;
    f: number;
  }[] = [];

  private cam = { th: -0.16, ph: 0.36, rad: 30, tth: -0.16, tph: 0.36, trad: 30, shake: 0, push: 0 };
  private target = new THREE.Vector3(0, 0.9, 0);
  private mobile = false;
  private sized = false;

  private ray = new THREE.Raycaster();
  private hover: BoardHit | null = null;
  private pickable: Slot[] = [];
  private pickMeshes: THREE.Mesh[] = [];
  private meshToSlot = new Map<THREE.Object3D, Slot>();
  private drag: { cx: number; cy: number; th: number; ph: number } | null = null;
  private pointers = new Map<number, { x: number; y: number; cx: number; cy: number }>();
  private pinch: { d: number; rad: number } | null = null;
  private moved = 0;
  private resizeObserver: ResizeObserver | null = null;

  private phase: ScenePhase = 'deploy';
  private interactive = false;
  private ghost: GhostSpec = null;
  private ghostValid = false;
  private ghostCells: number[] | null = null;

  private muted = true;
  private ac: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private gullTimer: ReturnType<typeof setInterval> | null = null;

  private disposed = false;
  private readonly scratchWorld = new THREE.Vector3();
  private readonly scratchCamera = new THREE.Vector3();
  private readonly scratchColor = new THREE.Color();
  private readonly onVisibilityChange = (): void => {
    if (document.hidden) {
      this.stopLoop();
    } else {
      this.clock.getDelta();
      this.lastFrameAt = performance.now();
      this.startLoop();
    }
  };

  constructor(opts: SceneOptions) {
    this.canvas = opts.canvas;
    this.onHover = opts.onHover;
    this.onPick = opts.onPick;
    this.amp = opts.waveHeight ?? 1;
    this.fireHex = opts.fireColor ?? '#ff8b3d';
    this.fire = new THREE.Color(this.fireHex);

    this.initRenderer();
    this.makeTextures();
    this.buildSky();
    this.buildOcean();
    this.buildFields();
    this.ensureBoard('you');
    this.ensureBoard('foeA');
    this.layoutBoards();
    this.buildAmbient();
    this.buildPools();
    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas.parentElement ?? this.canvas);
    this.bind();
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.startLoop();
  }

  /* ------------------------------------------------------------- lifecycle ---- */

  private initRenderer(): void {
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.22;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(new THREE.Color(HORIZON_HEX), 60, 300);
    this.camera = new THREE.PerspectiveCamera(46, 1, 0.1, 1200);
    this.sunDir = new THREE.Vector3().setFromSphericalCoords(
      1,
      Math.PI / 2 - 0.145,
      Math.PI - 0.62,
    );

    const sun = new THREE.DirectionalLight(0xffc078, 3.7);
    sun.position.copy(this.sunDir).multiplyScalar(110);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -28;
    sc.right = 28;
    sc.top = 24;
    sc.bottom = -24;
    sc.near = 60;
    sc.far = 150;
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun);
    this.scene.add(new THREE.HemisphereLight(0xffe1ae, 0x1d6072, 0.82));
    const fill = new THREE.DirectionalLight(0x8bd5e5, 0.9);
    fill.position.set(-8, -3, 10);
    this.scene.add(fill);
  }

  private startLoop(): void {
    if (this.disposed || document.hidden || this.scheduled) return;
    this.lastFrameAt = performance.now();
    this.scheduleNext();
  }

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.idleTimer) window.clearTimeout(this.idleTimer);
    this.raf = 0;
    this.idleTimer = 0;
    this.scheduled = null;
  }

  private wake(highRateMs = 350): void {
    this.highRateUntil = Math.max(this.highRateUntil, performance.now() + highRateMs);
    if (this.scheduled === 'idle') {
      this.stopLoop();
      this.startLoop();
    } else if (!this.scheduled) {
      this.startLoop();
    }
  }

  private highRate(now: number): boolean {
    const c = this.cam;
    const cameraMoving = Math.abs(c.tth - c.th) > 0.0005 || Math.abs(c.tph - c.ph) > 0.0005 || Math.abs(c.trad - c.rad) > 0.01;
    return now < this.highRateUntil || cameraMoving || this.drag !== null || this.pinch !== null || this.tweens.length > 0 || this.fieldAdd.live.length > 0 || this.fieldNorm.live.length > 0;
  }

  private scheduleNext(): void {
    if (this.disposed || document.hidden || this.scheduled) return;
    if (this.highRate(performance.now())) {
      this.scheduled = 'raf';
      this.raf = requestAnimationFrame(this.loop);
    } else {
      this.scheduled = 'idle';
      this.idleTimer = window.setTimeout(() => {
        this.scheduled = null;
        this.idleTimer = 0;
        this.loop(performance.now());
      }, 1000 / 30);
    }
  }

  private loop = (now: number): void => {
    if (this.disposed || document.hidden) return;
    this.scheduled = null;
    this.raf = 0;
    const dt = Math.min(0.05, Math.max(0, (now - this.lastFrameAt) / 1000));
    this.lastFrameAt = now;
    this.frame(dt);
    this.scheduleNext();
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopLoop();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.resizeObserver?.disconnect();
    window.removeEventListener('keydown', this.onKeyDown);
    if (this.gullTimer) clearInterval(this.gullTimer);
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      const m = mesh.material;
      if (m) {
        (Array.isArray(m) ? m : [m]).forEach((x) => {
          Object.values(x).forEach((v) => {
            if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
          });
          x.dispose();
        });
      }
    });
    Object.values(this.tex).forEach((t) => t.dispose());
    this.renderer.dispose();
    void this.ac?.close();
    this.ac = null;
  }

  private resize(): void {
    const el = this.renderer.domElement;
    const w = el.clientWidth || window.innerWidth;
    const h = el.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.mobile = w < 760;
    this.camera.aspect = w / h;
    this.camera.fov = this.mobile ? 56 : 44;
    this.camera.updateProjectionMatrix();
    if (!this.sized) {
      this.sized = true;
      this.applyCamDefaults();
    }
    (this.fieldAdd.pts.material as THREE.ShaderMaterial).uniforms.uScale.value = h;
    (this.fieldNorm.pts.material as THREE.ShaderMaterial).uniforms.uScale.value = h;
  }

  isMobile(): boolean {
    return this.mobile;
  }

  hoverTarget(): BoardHit | null {
    return this.hover;
  }

  setWaveHeight(amp: number): void {
    if (this.amp === amp) return;
    this.amp = amp;
    this.ocean.material.uniforms.uAmp.value = amp;
  }

  setFireColor(hex: string): void {
    if (this.fireHex === hex) return;
    this.fireHex = hex;
    this.fire = new THREE.Color(hex);
  }

  /* ---------------------------------------------------------------- textures ---- */

  private cv(w: number, h: number): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  private makeTextures(): void {
    let c = this.cv(128, 128);
    let x = c.getContext('2d')!;
    let gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.35, 'rgba(255,255,255,.55)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = gr;
    x.fillRect(0, 0, 128, 128);
    this.tex.soft = new THREE.CanvasTexture(c);

    c = this.cv(256, 256);
    x = c.getContext('2d')!;
    for (let i = 0; i < 26; i++) {
      const px = 40 + Math.random() * 176;
      const py = 70 + Math.random() * 116;
      const r = 20 + Math.random() * 52;
      gr = x.createRadialGradient(px, py, 0, px, py, r);
      gr.addColorStop(0, 'rgba(255,244,228,.42)');
      gr.addColorStop(1, 'rgba(255,244,228,0)');
      x.fillStyle = gr;
      x.beginPath();
      x.arc(px, py, r, 0, 7);
      x.fill();
    }
    this.tex.cloud = new THREE.CanvasTexture(c);

    c = this.cv(16, 128);
    x = c.getContext('2d')!;
    const lg = x.createLinearGradient(0, 0, 0, 128);
    lg.addColorStop(0, 'rgba(255,255,255,0)');
    lg.addColorStop(0.45, 'rgba(236,246,248,.85)');
    lg.addColorStop(1, 'rgba(210,236,240,.25)');
    x.fillStyle = lg;
    x.fillRect(0, 0, 16, 128);
    this.tex.col = new THREE.CanvasTexture(c);

    this.tex.steel = this.panelTex('#8eabb0', { rust: 0.7, lines: 26 });
    this.tex.steelDark = this.panelTex('#58737a', { rust: 0.4, lines: 18 });
    this.tex.hullRed = this.panelTex('#a84f3c', { rust: 1.1, lines: 10 });
    this.tex.deck = this.deckTex();
    this.tex.flight = this.flightTex();
    this.tex.labelsA = this.labelTex('ABCDEFGHIJ'.split(''));
    this.tex.labelsN = this.labelTex('1 2 3 4 5 6 7 8 9 10'.split(' '));
  }

  private panelTex(base: string, o: { rust?: number; lines?: number }): THREE.Texture {
    const S = 512;
    const c = this.cv(S, S);
    const x = c.getContext('2d')!;
    x.fillStyle = base;
    x.fillRect(0, 0, S, S);
    for (let i = 0; i < 9000; i++) {
      x.fillStyle = `rgba(0,0,0,${Math.random() * 0.05})`;
      x.fillRect(Math.random() * S, Math.random() * S, 2, 2);
    }
    x.strokeStyle = 'rgba(0,0,0,.22)';
    x.lineWidth = 2;
    const n = o.lines ?? 20;
    for (let i = 1; i < n; i++) {
      const y = (i / n) * S;
      x.beginPath();
      x.moveTo(0, y);
      x.lineTo(S, y);
      x.stroke();
    }
    for (let i = 1; i < 8; i++) {
      const px = (i / 8) * S;
      x.beginPath();
      x.moveTo(px, 0);
      x.lineTo(px, S);
      x.stroke();
    }
    x.fillStyle = 'rgba(255,255,255,.07)';
    for (let i = 1; i < n; i++) x.fillRect(0, (i / n) * S + 2, S, 1);
    x.fillStyle = 'rgba(0,0,0,.16)';
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 40; j++) {
        x.beginPath();
        x.arc((i / 8) * S + 6, (j / 40) * S + 5, 1.6, 0, 7);
        x.fill();
      }
    }
    const rust = o.rust ?? 0;
    for (let i = 0; i < 90 * rust; i++) {
      const px = Math.random() * S;
      const h = 40 + Math.random() * 150;
      const w = 2 + Math.random() * 9;
      const g2 = x.createLinearGradient(0, S, 0, S - h);
      g2.addColorStop(0, `rgba(122,54,28,${0.28 + Math.random() * 0.3})`);
      g2.addColorStop(1, 'rgba(122,54,28,0)');
      x.fillStyle = g2;
      x.fillRect(px, S - h, w, h);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  }

  private deckTex(): THREE.Texture {
    const S = 512;
    const c = this.cv(S, S);
    const x = c.getContext('2d')!;
    x.fillStyle = '#9c9078';
    x.fillRect(0, 0, S, S);
    for (let i = 0; i < 64; i++) {
      x.fillStyle = i % 2 ? 'rgba(0,0,0,.06)' : 'rgba(255,255,255,.05)';
      x.fillRect(0, i * 8, S, 8);
    }
    for (let i = 0; i < 6000; i++) {
      x.fillStyle = `rgba(0,0,0,${Math.random() * 0.06})`;
      x.fillRect(Math.random() * S, Math.random() * S, 3, 2);
    }
    x.strokeStyle = 'rgba(240,232,214,.5)';
    x.lineWidth = 4;
    x.beginPath();
    x.moveTo(S * 0.06, S / 2);
    x.lineTo(S * 0.94, S / 2);
    x.stroke();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  }

  private flightTex(): THREE.Texture {
    const W = 1024;
    const H = 256;
    const c = this.cv(W, H);
    const x = c.getContext('2d')!;
    x.fillStyle = '#3d4348';
    x.fillRect(0, 0, W, H);
    for (let i = 0; i < 12000; i++) {
      x.fillStyle = `rgba(255,255,255,${Math.random() * 0.035})`;
      x.fillRect(Math.random() * W, Math.random() * H, 2, 2);
    }
    x.strokeStyle = 'rgba(244,236,216,.85)';
    x.lineWidth = 7;
    x.setLineDash([34, 26]);
    x.beginPath();
    x.moveTo(W * 0.06, H * 0.44);
    x.lineTo(W * 0.95, H * 0.44);
    x.stroke();
    x.setLineDash([]);
    x.lineWidth = 5;
    x.strokeStyle = 'rgba(244,236,216,.6)';
    x.beginPath();
    x.moveTo(W * 0.1, H * 0.86);
    x.lineTo(W * 0.72, H * 0.2);
    x.stroke();
    x.strokeStyle = 'rgba(230,120,50,.75)';
    x.lineWidth = 6;
    x.beginPath();
    x.moveTo(W * 0.02, H * 0.06);
    x.lineTo(W * 0.02, H * 0.94);
    x.stroke();
    x.fillStyle = 'rgba(244,236,216,.9)';
    x.font = '600 92px Azeret Mono, monospace';
    x.save();
    x.translate(W * 0.955, H * 0.5);
    x.rotate(-Math.PI / 2);
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText('07', 0, 0);
    x.restore();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  private labelTex(arr: string[]): THREE.Texture {
    const n = arr.length;
    const S = 128;
    const c = this.cv(S * n, S);
    const x = c.getContext('2d')!;
    x.clearRect(0, 0, S * n, S);
    x.fillStyle = '#f0e3c8';
    x.font = '400 58px Azeret Mono, monospace';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    arr.forEach((ch, i) => x.fillText(ch, i * S + S / 2, S / 2 + 4));
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /* ------------------------------------------------------------- sky/ocean ---- */

  private buildSky(): void {
    const m = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTop: { value: new THREE.Color('#58a6c1') },
        uHoriz: { value: new THREE.Color('#ffc27d') },
        uSunCol: { value: new THREE.Color('#ffe0a8') },
        uSun: { value: this.sunDir.clone() },
      },
      vertexShader:
        'varying vec3 vD; void main(){ vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: [
        'uniform vec3 uTop,uHoriz,uSunCol,uSun; varying vec3 vD;',
        'void main(){ vec3 d=normalize(vD); float y=clamp(d.y,0.0,1.0);',
        ' vec3 c=mix(uHoriz,uTop,pow(y,0.5));',
        ' float s=max(dot(d,normalize(uSun)),0.0);',
        ' c+=uSunCol*pow(s,320.0)*6.0; c+=uSunCol*pow(s,14.0)*0.42; c+=uSunCol*pow(s,3.0)*0.1;',
        ' gl_FragColor=vec4(c,1.0); }',
      ].join('\n'),
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(520, 32, 24), m);
    this.scene.add(this.sky);
  }

  private buildOcean(): void {
    const geo = new THREE.PlaneGeometry(700, 700, 240, 240);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uAmp: { value: this.amp },
        uSun: { value: this.sunDir.clone() },
        uCam: { value: new THREE.Vector3() },
        uDeep: { value: new THREE.Color('#15556a') },
        uShallow: { value: new THREE.Color('#299d99') },
        uHorizon: { value: new THREE.Color(HORIZON_HEX) },
        uSunCol: { value: new THREE.Color('#ffdb9c') },
        uFogDens: { value: 0.0085 },
      },
      vertexShader: [
        'uniform float uTime, uAmp; varying vec3 vW; varying vec3 vN; varying float vH;',
        'float hgt(vec2 p, float t){',
        ' float h = sin(dot(p,vec2(0.94,0.34))*0.35 + t*0.75)*0.55;',
        ' h += sin(dot(p,vec2(-0.42,0.91))*0.62 + t*1.15)*0.30;',
        ' h += sin(dot(p,vec2(0.60,-0.80))*1.35 + t*1.90)*0.12;',
        ' h += sin(dot(p,vec2(0.18,0.98))*2.90 + t*2.70)*0.05;',
        ' return h; }',
        'void main(){',
        ' vec2 p = position.xz; float t = uTime;',
        ' float h = hgt(p,t)*uAmp;',
        ' float e = 0.6;',
        ' float hx = hgt(p+vec2(e,0.0),t)*uAmp;',
        ' float hz = hgt(p+vec2(0.0,e),t)*uAmp;',
        ' vec3 n = normalize(vec3(-(hx-h)/e, 1.0, -(hz-h)/e));',
        ' vec2 sq = p - n.xz * uAmp * 0.35;',
        ' vec3 wp = vec3(sq.x, h, sq.y);',
        ' vW = wp; vN = n; vH = h/max(uAmp,0.001);',
        ' gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(wp,1.0); }',
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uSun,uDeep,uShallow,uHorizon,uSunCol,uCam; uniform float uTime,uFogDens;',
        'varying vec3 vW; varying vec3 vN; varying float vH;',
        'float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }',
        'float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);',
        ' float a=hash(i), b=hash(i+vec2(1.0,0.0)), c=hash(i+vec2(0.0,1.0)), d=hash(i+vec2(1.0,1.0));',
        ' return mix(mix(a,b,f.x),mix(c,d,f.x),f.y); }',
        'float fbm(vec2 p){ float s=0.0,a=0.5; for(int i=0;i<4;i++){ s+=a*vn(p); p*=2.03; a*=0.5; } return s; }',
        'void main(){',
        ' vec3 V = normalize(uCam - vW);',
        ' vec2 flow = vec2(uTime*0.09, uTime*0.05);',
        ' float n1 = fbm(vW.xz*1.1 + flow);',
        ' float n2 = fbm(vW.xz*1.1 + flow + vec2(0.27,0.19));',
        ' vec3 N = normalize(normalize(vN) + vec3((n1-n2)*0.4, 0.0, (n2-n1)*0.4));',
        ' float fres = pow(1.0 - max(dot(N,V),0.0), 4.0);',
        ' vec3 L = normalize(uSun); vec3 H = normalize(L+V);',
        ' float spec = pow(max(dot(N,H),0.0), 420.0)*4.0;',
        ' float glint = pow(max(dot(N,H),0.0), 34.0)*0.22;',
        ' float sd = pow(max(dot(reflect(-V,N), L), 0.0), 5.0);',
        ' vec3 refl = mix(vec3(0.26,0.44,0.52), uHorizon, clamp(sd*1.2, 0.0, 1.0));',
        ' vec3 base = mix(uDeep, uShallow, clamp(vH*0.5+0.55, 0.0, 1.0));',
        ' vec3 col = base + refl*fres*0.62;',
        ' col += uSunCol*(spec+glint);',
        ' float foam = smoothstep(0.62,1.0,vH) * smoothstep(0.38,0.72, fbm(vW.xz*2.4 + flow*2.2));',
        ' col = mix(col, vec3(0.94,0.92,0.87), foam*0.5);',
        ' float d = length(vW.xz - uCam.xz);',
        ' float fg = 1.0 - exp(-pow(d*uFogDens, 2.0));',
        ' col = mix(col, uHorizon, clamp(fg,0.0,1.0));',
        ' gl_FragColor = vec4(col, 1.0); }',
      ].join('\n'),
    });
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    this.scene.add(m);
    this.ocean = m;
  }

  private waveH(x: number, z: number, t: number): number {
    return (
      (Math.sin((0.94 * x + 0.34 * z) * 0.35 + t * 0.75) * 0.55 +
        Math.sin((-0.42 * x + 0.91 * z) * 0.62 + t * 1.15) * 0.3 +
        Math.sin((0.6 * x - 0.8 * z) * 1.35 + t * 1.9) * 0.12) *
      this.amp
    );
  }

  /* ---------------------------------------------------------------- boards ---- */

  private mat(name: string): THREE.MeshStandardMaterial {
    if (this.materials[name]) return this.materials[name];
    const T = this.tex;
    const defs: Record<string, THREE.MeshStandardMaterialParameters> = {
      steel: {
        map: T.steel, color: 0xd5e5e4, emissive: 0x24464a, emissiveIntensity: 0.18,
        roughness: 0.62, metalness: 0.55,
      },
      dark: {
        map: T.steelDark, color: 0xbcd3d3, emissive: 0x1d454d, emissiveIntensity: 0.24,
        roughness: 0.5, metalness: 0.7,
      },
      red: {
        map: T.hullRed, color: 0xef9578, emissive: 0x5d1d13, emissiveIntensity: 0.2,
        roughness: 0.8, metalness: 0.25,
      },
      deck: {
        map: T.deck, color: 0xe6d6ae, emissive: 0x4b391e, emissiveIntensity: 0.12,
        roughness: 0.85, metalness: 0.08,
      },
      flight: {
        map: T.flight, color: 0xd2e0e0, emissive: 0x29494e, emissiveIntensity: 0.14,
        roughness: 0.9, metalness: 0.1,
      },
      brass: { color: 0xf0bc62, roughness: 0.34, metalness: 0.92 },
      cream: { color: 0xffedc8, emissive: 0x5b4728, emissiveIntensity: 0.1, roughness: 0.66, metalness: 0.15 },
      glass: {
        color: 0x327a87,
        roughness: 0.18,
        metalness: 0.2,
        transparent: true,
        opacity: 0.34,
        side: THREE.DoubleSide,
      },
      black: { color: 0x46666b, emissive: 0x173842, emissiveIntensity: 0.18, roughness: 0.55, metalness: 0.4 },
    };
    this.materials[name] = new THREE.MeshStandardMaterial(defs[name]);
    return this.materials[name];
  }

  private mk(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    p?: [number, number, number],
    r?: [number, number, number],
    s?: [number, number, number],
  ): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    if (p) m.position.set(p[0], p[1], p[2]);
    if (r) m.rotation.set(r[0], r[1], r[2]);
    if (s) m.scale.set(s[0], s[1], s[2]);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  /** Builds a board rig if it doesn't already exist. Idempotent. */
  private ensureBoard(slot: Slot): BoardRig {
    const existing = this.boards.get(slot);
    if (existing) return existing;
    const rig = this.buildBoard(slot);
    this.boards.set(slot, rig);
    this.visuals.set(slot, new Map());
    this.buildFleetMeshesFor(slot, rig);
    return rig;
  }

  /** Positions every built board per the pose table matching the current roster size. */
  private layoutBoards(): void {
    const pose = this.rosterLength >= 4 ? POSE_4 : POSE_2;
    this.boards.forEach((rig, slot) => {
      const p = pose[slot];
      if (!p) {
        rig.grp.visible = false;
        return;
      }
      rig.grp.visible = true;
      rig.basePos.set(p.x, 0.52, p.z);
      rig.grp.position.copy(rig.basePos);
      rig.grp.rotation.y = p.yaw;
    });
  }

  private applyCamDefaults(): void {
    const c = this.rosterLength >= 4 ? CAM_4 : CAM_2;
    this.cam.tph = c.ph;
    this.cam.ph = c.ph;
    this.cam.trad = this.mobile ? c.radMobile : c.rad;
  }

  /**
   * Declares the roster for this match: which slots exist, their team, relation
   * to the viewer, and fog state. Builds any newly-needed boards, repositions the
   * whole table for the roster size, and refreshes rails/nameplates/fog.
   */
  setRoster(specs: SlotSpec[]): void {
    const sizeChanged = specs.length !== this.rosterLength || !this.sized;
    this.rosterLength = specs.length;
    this.slotMeta.clear();
    specs.forEach((s) => {
      this.slotMeta.set(s.slot, s);
      this.ensureBoard(s.slot);
    });
    this.layoutBoards();
    if (sizeChanged) this.applyCamDefaults();
    this.slotMeta.forEach((spec, slot) => {
      const rig = this.boards.get(slot);
      if (rig) this.applySlotMeta(rig, spec);
    });
  }

  private applySlotMeta(rig: BoardRig, spec: SlotSpec): void {
    const hex = spec.team ? TEAM_COLOR[spec.team] : 0x8c9296;
    rig.rail.color.set(hex);
    rig.rail.emissive.set(hex);
    rig.rail.emissiveIntensity = spec.eliminated ? 0 : spec.relation === 'self' ? 0.75 : 0.4;
    rig.blanket.visible = spec.fogged && !spec.eliminated;
    rig.plateMat.map = this.plateTex(spec);
    rig.plateMat.map.colorSpace = THREE.SRGBColorSpace;
    rig.plateMat.needsUpdate = true;
    rig.grp.position.y = spec.eliminated ? rig.basePos.y - 0.22 : rig.basePos.y;
  }

  private plateTex(spec: SlotSpec): THREE.CanvasTexture {
    const W = 512;
    const H = 160;
    const c = this.cv(W, H);
    const x = c.getContext('2d')!;
    const hex = spec.team ? TEAM_COLOR[spec.team] : 0x8c9296;
    const teamCss = `#${hex.toString(16).padStart(6, '0')}`;
    x.fillStyle = 'rgba(12,47,61,.7)';
    x.fillRect(0, 0, W, H);
    x.strokeStyle = teamCss;
    x.lineWidth = 4;
    x.strokeRect(2, 2, W - 4, H - 4);
    x.fillStyle = spec.eliminated ? 'rgba(242,228,201,.4)' : '#f2e4c9';
    x.font = '400 44px Azeret Mono, monospace';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(spec.name.toUpperCase(), W / 2, H * 0.4);
    x.fillStyle = teamCss;
    x.font = '400 24px Azeret Mono, monospace';
    const role =
      spec.relation === 'self' ? 'YOUR FLEET' : spec.relation === 'ally' ? 'ALLY' : 'HOSTILE';
    x.fillText(spec.eliminated ? `${role} · DESTROYED` : role, W / 2, H * 0.72);
    if (spec.eliminated) {
      x.strokeStyle = 'rgba(224,75,40,.85)';
      x.lineWidth = 5;
      x.beginPath();
      x.moveTo(W * 0.08, H * 0.86);
      x.lineTo(W * 0.92, H * 0.14);
      x.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  private buildBoard(slot: Slot): BoardRig {
    const grp = new THREE.Group();
    const basePos = new THREE.Vector3(0, 0.52, 0);
    grp.position.copy(basePos);
    this.scene.add(grp);

    const brass = this.mat('brass');
    const fr = new THREE.Group();
    grp.add(fr);
    const bar = (w: number, d: number, x: number, z: number) =>
      fr.add(this.mk(new THREE.BoxGeometry(w, 0.11, d), brass, [x, 0, z]));
    bar(10.5, 0.22, 0, -5.14);
    bar(10.5, 0.22, 0, 5.14);
    bar(0.22, 10.5, -5.14, 0);
    bar(0.22, 10.5, 5.14, 0);
    (
      [
        [-5.14, -5.14],
        [5.14, -5.14],
        [-5.14, 5.14],
        [5.14, 5.14],
      ] as const
    ).forEach((p) =>
      fr.add(
        this.mk(new THREE.CylinderGeometry(0.17, 0.2, 0.3, 12), brass, [p[0], -0.02, p[1]]),
      ),
    );

    const plate = this.mk(new THREE.BoxGeometry(10, 0.045, 10), this.mat('glass'), [0, -0.02, 0]);
    plate.castShadow = false;
    grp.add(plate);

    const pts: number[] = [];
    for (let i = 0; i <= BOARD; i++) {
      const v = i - 5;
      pts.push(v, 0.01, -5, v, 0.01, 5, -5, 0.01, v, 5, 0.01, v);
    }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    grp.add(
      new THREE.LineSegments(
        gg,
        new THREE.LineBasicMaterial({ color: 0xf3ffff, transparent: true, opacity: 0.68 }),
      ),
    );

    const lm = (tex: THREE.Texture) =>
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.82, depthWrite: false });
    const la = this.mk(new THREE.PlaneGeometry(10, 1), lm(this.tex.labelsA), [0, 0.012, -5.6], [
      -Math.PI / 2,
      0,
      0,
    ]);
    const ln = this.mk(new THREE.PlaneGeometry(10, 1), lm(this.tex.labelsN), [-5.6, 0.012, 0], [
      -Math.PI / 2,
      0,
      Math.PI / 2,
    ]);
    la.castShadow = false;
    ln.castShadow = false;
    grp.add(la);
    grp.add(ln);

    const pick = new THREE.Mesh(
      new THREE.PlaneGeometry(10, 10),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    pick.rotation.x = -Math.PI / 2;
    pick.position.y = 0.02;
    grp.add(pick);

    const pegGeo = new THREE.CylinderGeometry(0.11, 0.13, 0.3, 10);
    pegGeo.translate(0, 0.15, 0);
    const pegW = new THREE.InstancedMesh(
      pegGeo,
      new THREE.MeshStandardMaterial({ color: 0xefe7d4, roughness: 0.5, metalness: 0.05 }),
      100,
    );
    const pegR = new THREE.InstancedMesh(
      pegGeo,
      new THREE.MeshStandardMaterial({
        color: 0xc0392a,
        roughness: 0.45,
        metalness: 0.1,
        emissive: 0x300a04,
        emissiveIntensity: 0.6,
      }),
      100,
    );
    pegW.count = 0;
    pegR.count = 0;
    pegW.castShadow = true;
    pegR.castShadow = true;
    pegW.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    pegR.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    grp.add(pegW);
    grp.add(pegR);

    const ships = new THREE.Group();
    grp.add(ships);

    const col = this.mk(
      new THREE.CylinderGeometry(0.42, 0.46, 3.2, 18, 1, true),
      new THREE.MeshBasicMaterial({
        map: this.tex.col,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
      [0, 1.6, 0],
    );
    col.castShadow = false;
    col.visible = false;
    grp.add(col);

    const ret = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.48, 40),
      new THREE.MeshBasicMaterial({
        color: 0xffd9a0,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    ret.rotation.x = -Math.PI / 2;
    ret.position.y = 0.05;
    ret.visible = false;
    grp.add(ret);

    // The enemy grid keeps a fog blanket for the whole board. Per-ship fog was
    // dropped on purpose: in a 1v1 it would betray where the hulls are.
    // Hidden for `you` / `ally`, shown for a fogged enemy board. Toggled by
    // `applySlotMeta`, never rebuilt — simpler than adding/removing the mesh.
    const blanket = new THREE.Mesh(
      new THREE.PlaneGeometry(10.4, 10.4),
      new THREE.MeshBasicMaterial({
        map: this.tex.cloud,
        transparent: true,
        opacity: 0.26,
        depthWrite: false,
        color: 0xd9f2f1,
      }),
    );
    blanket.rotation.x = -Math.PI / 2;
    blanket.position.y = 0.42;
    blanket.visible = false;
    grp.add(blanket);

    // Team rail: a thin coloured bar just outboard of the brass frame — the
    // primary "whose board is this" cue at wide framing.
    const railMat = new THREE.MeshStandardMaterial({
      color: 0x8c9296,
      emissive: 0x8c9296,
      emissiveIntensity: 0.4,
      roughness: 0.35,
      metalness: 0.6,
    });
    const railBar = (w: number, d: number, x: number, z: number) =>
      new THREE.Mesh(new THREE.BoxGeometry(w, 0.05, d), railMat).translateX(x).translateZ(z);
    [
      railBar(10.9, 0.16, 0, -5.34),
      railBar(10.9, 0.16, 0, 5.34),
      railBar(0.16, 10.9, -5.34, 0),
      railBar(0.16, 10.9, 5.34, 0),
    ].forEach((m) => {
      m.castShadow = false;
      grp.add(m);
    });

    const plateMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
    const namePlate = new THREE.Mesh(new THREE.PlaneGeometry(4, 1.25), plateMat);
    namePlate.position.set(0, 1.6, -6.3);
    namePlate.castShadow = false;
    namePlate.receiveShadow = false;
    grp.add(namePlate);

    return {
      slot,
      grp,
      pick,
      pegW,
      pegR,
      ships,
      col,
      ret,
      blanket,
      rail: railMat,
      plate: namePlate,
      plateMat,
      basePos,
      phase: Math.random() * 6.28,
    };
  }

  private local(c: number, r: number): THREE.Vector3 {
    return new THREE.Vector3(c - 4.5, 0, r - 4.5);
  }

  private worldCell(slot: Slot, idx: number): THREE.Vector3 {
    const b = this.boards.get(slot)!;
    return b.grp.localToWorld(this.local(idx % BOARD, Math.floor(idx / BOARD)));
  }

  /* ----------------------------------------------------------------- hulls ---- */

  private hullGeo(len: number, beam: number, dep: number, taper: number): THREE.BufferGeometry {
    const L = len / 2;
    const w = beam / 2;
    const s = new THREE.Shape();
    s.moveTo(-L, 0);
    s.bezierCurveTo(-L, w * 0.6, -L * 0.62, w, -L * 0.15, w);
    s.lineTo(L * 0.42, w * 0.97);
    s.bezierCurveTo(L * 0.78, w * 0.85, L * 0.93, w * 0.42, L, 0);
    s.bezierCurveTo(L * 0.93, -w * 0.42, L * 0.78, -w * 0.85, L * 0.42, -w * 0.97);
    s.lineTo(-L * 0.15, -w);
    s.bezierCurveTo(-L * 0.62, -w, -L, -w * 0.6, -L, 0);
    const g = new THREE.ExtrudeGeometry(s, {
      depth: dep,
      bevelEnabled: true,
      bevelSize: beam * 0.05,
      bevelThickness: dep * 0.1,
      bevelSegments: 2,
      curveSegments: 12,
    });
    g.rotateX(-Math.PI / 2);
    g.translate(0, -dep, 0);
    const p = g.attributes.position;
    const uv: number[] = [];
    const tp = taper ?? 0.5;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      const k = tp + (1 - tp) * Math.min(1, (y + dep) / dep);
      p.setX(i, p.getX(i) * (0.94 + 0.06 * k));
      p.setZ(i, p.getZ(i) * k);
      uv.push((p.getX(i) / len + 0.5) * 3, (y + dep) / dep);
    }
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    return g;
  }

  private deckPlate(len: number, beam: number, y: number): THREE.BufferGeometry {
    const L = (len / 2) * 0.97;
    const w = (beam / 2) * 0.95;
    const s = new THREE.Shape();
    s.moveTo(-L, 0);
    s.bezierCurveTo(-L, w * 0.6, -L * 0.62, w, -L * 0.15, w);
    s.lineTo(L * 0.42, w * 0.97);
    s.bezierCurveTo(L * 0.78, w * 0.85, L * 0.93, w * 0.42, L, 0);
    s.bezierCurveTo(L * 0.93, -w * 0.42, L * 0.78, -w * 0.85, L * 0.42, -w * 0.97);
    s.lineTo(-L * 0.15, -w);
    s.bezierCurveTo(-L * 0.62, -w, -L, -w * 0.6, -L, 0);
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.04, bevelEnabled: false, curveSegments: 12 });
    g.rotateX(-Math.PI / 2);
    g.translate(0, y, 0);
    const p = g.attributes.position;
    const uv: number[] = [];
    for (let i = 0; i < p.count; i++) uv.push((p.getX(i) / len) * 2 + 0.5, p.getZ(i) / beam + 0.5);
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    return g;
  }

  private turret(scale: number, barrels = 2): THREE.Group {
    const g = new THREE.Group();
    const s = scale;
    g.add(
      this.mk(new THREE.CylinderGeometry(0.13 * s, 0.15 * s, 0.06 * s, 14), this.mat('dark'), [
        0,
        0.03 * s,
        0,
      ]),
    );
    g.add(
      this.mk(new THREE.BoxGeometry(0.26 * s, 0.11 * s, 0.22 * s), this.mat('steel'), [
        0,
        0.11 * s,
        0,
      ]),
    );
    g.add(
      this.mk(new THREE.BoxGeometry(0.1 * s, 0.07 * s, 0.2 * s), this.mat('steel'), [
        -0.15 * s,
        0.13 * s,
        0,
      ]),
    );
    for (let i = 0; i < barrels; i++) {
      const off = (i - (barrels - 1) / 2) * 0.075 * s;
      g.add(
        this.mk(
          new THREE.CylinderGeometry(0.017 * s, 0.02 * s, 0.42 * s, 8),
          this.mat('black'),
          [0.26 * s, 0.12 * s, off],
          [0, 0, Math.PI / 2],
        ),
      );
    }
    return g;
  }

  private funnel(rB: number, rT: number, h: number, cap: boolean): THREE.Group {
    const g = new THREE.Group();
    g.add(this.mk(new THREE.CylinderGeometry(rT, rB, h, 16), this.mat('dark'), [0, h / 2, 0]));
    g.add(
      this.mk(
        new THREE.TorusGeometry(rT * 1.02, rT * 0.16, 7, 16),
        this.mat('black'),
        [0, h, 0],
        [Math.PI / 2, 0, 0],
      ),
    );
    if (cap) {
      g.add(
        this.mk(new THREE.CylinderGeometry(rT * 0.72, rT * 0.72, 0.02, 12), this.mat('black'), [
          0,
          h - 0.01,
          0,
        ]),
      );
    }
    return g;
  }

  private aircraft(s: number): THREE.Group {
    const g = new THREE.Group();
    const grey = this.mat('cream');
    g.add(
      this.mk(
        new THREE.CapsuleGeometry(0.035 * s, 0.2 * s, 4, 8),
        grey,
        [0, 0.045 * s, 0],
        [0, 0, Math.PI / 2],
      ),
    );
    g.add(
      this.mk(new THREE.BoxGeometry(0.075 * s, 0.012 * s, 0.44 * s), grey, [
        0.01 * s,
        0.055 * s,
        0,
      ]),
    );
    g.add(
      this.mk(new THREE.BoxGeometry(0.05 * s, 0.01 * s, 0.16 * s), grey, [-0.13 * s, 0.06 * s, 0]),
    );
    g.add(
      this.mk(new THREE.BoxGeometry(0.04 * s, 0.06 * s, 0.01 * s), grey, [
        -0.14 * s,
        0.085 * s,
        0,
      ]),
    );
    return g;
  }

  private radar(s: number): THREE.Group {
    const g = new THREE.Group();
    g.add(
      this.mk(
        new THREE.SphereGeometry(0.11 * s, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2.4),
        this.mat('cream'),
        [0, 0, 0],
        [Math.PI / 2.6, 0, 0],
      ),
    );
    g.add(
      this.mk(new THREE.CylinderGeometry(0.008 * s, 0.008 * s, 0.09 * s, 6), this.mat('black'), [
        0,
        -0.05 * s,
        0,
      ]),
    );
    return g;
  }

  private shipMesh(key: ShipKey): { group: THREE.Group; anim: AnimSpec[]; baseY: number } {
    const G = new THREE.Group();
    const steel = this.mat('steel');
    const cream = this.mat('cream');
    const black = this.mat('black');
    const brass = this.mat('brass');
    const anim: AnimSpec[] = [];
    let baseY = 0;
    let L: number;
    let B: number;
    let D: number;

    if (key === 'carrier') {
      L = 4.72;
      B = 0.92;
      D = 0.44;
      G.add(this.mk(this.hullGeo(L, B, D, 0.5), this.mat('red')));
      G.add(this.mk(this.hullGeo(L, B, D * 0.55, 0.92), steel, [0, D * 0.5, 0]));
      G.add(
        this.mk(new THREE.BoxGeometry(L * 0.99, 0.055, B * 1.24), this.mat('flight'), [
          0,
          D * 0.5 + 0.03,
          0.02,
        ]),
      );
      G.add(
        this.mk(
          new THREE.BoxGeometry(L * 0.45, 0.045, B * 0.3),
          this.mat('flight'),
          [L * 0.1, D * 0.5 + 0.03, -B * 0.68],
          [0, 0.05, 0],
        ),
      );
      const isl = new THREE.Group();
      isl.position.set(L * 0.06, D * 0.5 + 0.06, B * 0.42);
      G.add(isl);
      isl.add(this.mk(new THREE.BoxGeometry(0.62, 0.2, 0.24), steel, [0, 0.1, 0]));
      isl.add(this.mk(new THREE.BoxGeometry(0.42, 0.16, 0.2), cream, [-0.04, 0.28, 0]));
      isl.add(this.mk(new THREE.BoxGeometry(0.2, 0.14, 0.17), steel, [0.1, 0.43, 0]));
      const fn = this.funnel(0.075, 0.062, 0.2, true);
      fn.position.set(-0.16, 0.2, 0);
      isl.add(fn);
      isl.add(this.mk(new THREE.CylinderGeometry(0.008, 0.008, 0.5, 6), black, [0.16, 0.72, 0]));
      const rd = this.radar(1);
      rd.position.set(0.06, 0.56, 0);
      isl.add(rd);
      anim.push({ o: rd, k: 'spin', s: 0.5 });
      (
        [
          [-L * 0.36, -B * 0.34, 0.5],
          [-L * 0.3, B * 0.22, -0.8],
          [L * 0.3, -B * 0.42, 1.9],
          [L * 0.42, B * 0.2, 2.4],
        ] as const
      ).forEach((a) => {
        const p = this.aircraft(0.85);
        p.position.set(a[0], D * 0.5 + 0.06, a[1]);
        p.rotation.y = a[2];
        G.add(p);
      });
      G.add(
        this.mk(new THREE.BoxGeometry(L * 0.9, 0.012, 0.012), brass, [
          0,
          D * 0.5 + 0.1,
          -B * 0.62,
        ]),
      );
    } else if (key === 'battleship') {
      L = 3.85;
      B = 0.76;
      D = 0.42;
      G.add(this.mk(this.hullGeo(L, B, D, 0.46), this.mat('red')));
      G.add(this.mk(this.hullGeo(L, B, D * 0.5, 0.94), steel, [0, D * 0.52, 0]));
      G.add(this.mk(this.deckPlate(L, B, D * 0.5 + 0.02), this.mat('deck')));
      G.add(this.mk(new THREE.BoxGeometry(1.1, 0.14, B * 0.66), steel, [-0.02, D * 0.5 + 0.09, 0]));
      G.add(this.mk(new THREE.BoxGeometry(0.66, 0.16, B * 0.5), cream, [0.02, D * 0.5 + 0.22, 0]));
      G.add(this.mk(new THREE.BoxGeometry(0.34, 0.2, B * 0.36), steel, [0.06, D * 0.5 + 0.38, 0]));
      G.add(this.mk(new THREE.BoxGeometry(0.2, 0.14, B * 0.26), cream, [0.06, D * 0.5 + 0.53, 0]));
      G.add(
        this.mk(new THREE.CylinderGeometry(0.05, 0.05, 0.18, 10), black, [
          0.06,
          D * 0.5 + 0.68,
          0,
        ]),
      );
      (
        [
          [-0.1, 0, 0.34],
          [-0.1, 0.05, -0.34],
          [0.12, 0, 0],
        ] as const
      ).forEach((t) =>
        G.add(
          this.mk(
            new THREE.CylinderGeometry(0.012, 0.016, 0.62, 6),
            black,
            [0.02 + t[0] * 0.4, D * 0.5 + 0.62, t[2] * 0.14],
            [t[2] * 0.16, 0, -t[0] * 0.5],
          ),
        ),
      );
      G.add(this.mk(new THREE.BoxGeometry(0.16, 0.05, 0.05), cream, [0.04, D * 0.5 + 0.92, 0]));
      const fn = this.funnel(0.1, 0.085, 0.26, true);
      fn.position.set(-0.42, D * 0.5 + 0.16, 0);
      G.add(fn);
      const t1 = this.turret(1.15);
      t1.position.set(L * 0.3, D * 0.5 + 0.04, 0);
      const t2 = this.turret(1.15);
      t2.position.set(L * 0.14, D * 0.5 + 0.13, 0);
      const t3 = this.turret(1.15);
      t3.position.set(-L * 0.34, D * 0.5 + 0.04, 0);
      t3.rotation.y = Math.PI;
      [t1, t2, t3].forEach((t, i) => {
        G.add(t);
        anim.push({ o: t, k: 'sweep', s: 0.22 + i * 0.05, ph: i * 1.7 });
      });
      for (let i = 0; i < 6; i++) {
        const z = i < 3 ? B * 0.4 : -B * 0.4;
        const x = ((i % 3) - 1) * 0.34 - 0.3;
        const st = this.turret(0.5);
        st.position.set(x, D * 0.5 + 0.1, z);
        st.rotation.y = z > 0 ? 0.6 : -0.6;
        G.add(st);
      }
    } else if (key === 'cruiser') {
      L = 2.88;
      B = 0.56;
      D = 0.34;
      G.add(this.mk(this.hullGeo(L, B, D, 0.44), this.mat('red')));
      G.add(this.mk(this.hullGeo(L, B, D * 0.46, 0.94), steel, [0, D * 0.55, 0]));
      G.add(this.mk(this.deckPlate(L, B, D * 0.55 + 0.02), this.mat('deck')));
      G.add(this.mk(new THREE.BoxGeometry(0.86, 0.12, B * 0.62), steel, [0.05, D * 0.55 + 0.08, 0]));
      G.add(this.mk(new THREE.BoxGeometry(0.36, 0.15, B * 0.46), cream, [0.24, D * 0.55 + 0.2, 0]));
      G.add(this.mk(new THREE.BoxGeometry(0.18, 0.12, B * 0.3), steel, [0.26, D * 0.55 + 0.33, 0]));
      const f1 = this.funnel(0.075, 0.06, 0.22, true);
      f1.position.set(0.02, D * 0.55 + 0.13, 0);
      G.add(f1);
      const f2 = this.funnel(0.07, 0.055, 0.19, true);
      f2.position.set(-0.36, D * 0.55 + 0.12, 0);
      G.add(f2);
      G.add(
        this.mk(new THREE.CylinderGeometry(0.01, 0.014, 0.52, 6), black, [
          0.3,
          D * 0.55 + 0.62,
          0,
        ]),
      );
      const rd = this.radar(1.3);
      rd.position.set(0.3, D * 0.55 + 0.9, 0);
      G.add(rd);
      anim.push({ o: rd, k: 'spin', s: 0.85 });
      const t1 = this.turret(0.9);
      t1.position.set(L * 0.33, D * 0.55 + 0.04, 0);
      G.add(t1);
      anim.push({ o: t1, k: 'sweep', s: 0.3 });
      const t2 = this.turret(0.9);
      t2.position.set(-L * 0.36, D * 0.55 + 0.04, 0);
      t2.rotation.y = Math.PI;
      G.add(t2);
      anim.push({ o: t2, k: 'sweep', s: 0.26, ph: 2 });
      ([-1, 1] as const).forEach((sgn) => {
        for (let i = 0; i < 2; i++) {
          const x = -0.1 - i * 0.24;
          G.add(
            this.mk(
              new THREE.CapsuleGeometry(0.035, 0.14, 3, 7),
              cream,
              [x, D * 0.55 + 0.13, sgn * B * 0.44],
              [0, 0, Math.PI / 2],
              [1, 1, 0.6],
            ),
          );
          G.add(
            this.mk(new THREE.CylinderGeometry(0.006, 0.006, 0.14, 5), black, [
              x,
              D * 0.55 + 0.2,
              sgn * B * 0.42,
            ]),
          );
        }
      });
    } else if (key === 'submarine') {
      L = 2.8;
      B = 0.4;
      D = 0.42;
      const h = new THREE.Mesh(new THREE.CapsuleGeometry(B / 2, L - B, 8, 20), this.mat('dark'));
      h.rotation.z = Math.PI / 2;
      h.castShadow = true;
      h.receiveShadow = true;
      h.position.y = -0.02;
      G.add(h);
      G.add(
        this.mk(
          new THREE.ConeGeometry((B / 2) * 0.98, 0.34, 20),
          this.mat('dark'),
          [-L / 2 + 0.05, -0.02, 0],
          [0, 0, Math.PI / 2],
        ),
      );
      G.add(
        this.mk(new THREE.BoxGeometry(L * 0.8, 0.03, B * 0.5), this.mat('black'), [
          0,
          B / 2 - 0.04,
          0,
        ]),
      );
      G.add(
        this.mk(new THREE.BoxGeometry(0.44, 0.22, B * 0.52), this.mat('dark'), [
          0.06,
          B / 2 + 0.08,
          0,
        ]),
      );
      G.add(
        this.mk(new THREE.CylinderGeometry(0.028, 0.028, 0.12, 10), this.mat('black'), [
          0.16,
          B / 2 + 0.24,
          0,
        ]),
      );
      const per = this.mk(new THREE.CylinderGeometry(0.012, 0.012, 0.3, 6), this.mat('black'), [
        0,
        B / 2 + 0.33,
        0,
      ]);
      G.add(per);
      anim.push({ o: per, k: 'spin', s: 0.4 });
      G.add(
        this.mk(new THREE.BoxGeometry(0.05, 0.02, 0.02), this.mat('brass'), [
          0.03,
          B / 2 + 0.47,
          0,
        ]),
      );
      G.add(
        this.mk(new THREE.BoxGeometry(0.16, 0.02, B * 1.5), this.mat('dark'), [
          -L * 0.42,
          -0.06,
          0,
        ]),
      );
      G.add(
        this.mk(new THREE.BoxGeometry(0.14, 0.28, 0.02), this.mat('dark'), [-L * 0.44, 0.02, 0]),
      );
      G.add(
        this.mk(new THREE.BoxGeometry(0.03, 0.02, 0.02), this.mat('brass'), [
          0.28,
          B / 2 + 0.2,
          0,
        ]),
      );
      baseY = -0.06;
    } else {
      L = 1.92;
      B = 0.42;
      D = 0.3;
      G.add(this.mk(this.hullGeo(L, B, D, 0.42), this.mat('red')));
      G.add(this.mk(this.hullGeo(L, B, D * 0.44, 0.95), steel, [0, D * 0.56, 0]));
      G.add(this.mk(this.deckPlate(L, B, D * 0.56 + 0.02), this.mat('deck')));
      G.add(this.mk(new THREE.BoxGeometry(0.52, 0.1, B * 0.6), steel, [0.06, D * 0.56 + 0.07, 0]));
      G.add(this.mk(new THREE.BoxGeometry(0.2, 0.13, B * 0.44), cream, [0.16, D * 0.56 + 0.17, 0]));
      const f = this.funnel(0.06, 0.048, 0.17, true);
      f.position.set(-0.06, D * 0.56 + 0.11, 0);
      G.add(f);
      G.add(
        this.mk(new THREE.CylinderGeometry(0.008, 0.011, 0.38, 6), black, [
          0.2,
          D * 0.56 + 0.42,
          0,
        ]),
      );
      const t1 = this.turret(0.78);
      t1.position.set(L * 0.3, D * 0.56 + 0.04, 0);
      G.add(t1);
      anim.push({ o: t1, k: 'sweep', s: 0.34 });
      ([-1, 1] as const).forEach((sgn) => {
        for (let i = 0; i < 4; i++) {
          G.add(
            this.mk(new THREE.CylinderGeometry(0.032, 0.032, 0.06, 9), this.mat('black'), [
              -L * 0.3 - i * 0.085,
              D * 0.56 + 0.06,
              sgn * B * 0.24,
            ]),
          );
        }
        G.add(
          this.mk(new THREE.BoxGeometry(0.4, 0.012, 0.012), brass, [
            -L * 0.36,
            D * 0.56 + 0.1,
            sgn * B * 0.24,
          ]),
        );
      });
      G.add(
        this.mk(new THREE.BoxGeometry(0.1, 0.05, 0.05), this.mat('black'), [
          -L * 0.46,
          D * 0.56 + 0.06,
          0,
        ]),
      );
    }

    G.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    return { group: G, anim, baseY };
  }

  private buildFleetMeshesFor(slot: Slot, rig: BoardRig): void {
    const visuals = this.visuals.get(slot)!;
    SHIP_DEFS.forEach((def) => {
      const { group, anim, baseY } = this.shipMesh(def.key);
      group.visible = false;
      rig.ships.add(group);
      visuals.set(def.key, {
        key: def.key,
        mesh: group,
        anim,
        bobPhase: Math.random() * 6.28,
        baseY,
        placement: null,
        sunk: false,
        floating: false,
      });
    });
  }

  /* --------------------------------------------------------------- ambient ---- */

  private buildAmbient(): void {
    for (let i = 0; i < 16; i++) {
      const sp = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.tex.cloud,
          transparent: true,
          opacity: 0.5 + Math.random() * 0.3,
          depthWrite: false,
          color: 0xffeeda,
          fog: false,
        }),
      );
      const a = Math.random() * Math.PI * 2;
      const d = 150 + Math.random() * 220;
      sp.position.set(Math.cos(a) * d, 16 + Math.random() * 48, Math.sin(a) * d);
      const s = 60 + Math.random() * 110;
      sp.scale.set(s, s * 0.42, 1);
      this.scene.add(sp);
      this.clouds.push({ sp, v: 0.6 + Math.random() * 0.9 });
    }

    const gm = new THREE.MeshStandardMaterial({ color: 0xf2e9d8, roughness: 0.8, metalness: 0 });
    for (let i = 0; i < 6; i++) {
      const grp = new THREE.Group();
      const body = this.mk(new THREE.CapsuleGeometry(0.06, 0.16, 3, 6), gm, [0, 0, 0], [
        0,
        0,
        Math.PI / 2,
      ]);
      const wl = this.mk(new THREE.BoxGeometry(0.1, 0.012, 0.42), gm, [0, 0.03, 0.22]);
      const wr = this.mk(new THREE.BoxGeometry(0.1, 0.012, 0.42), gm, [0, 0.03, -0.22]);
      grp.add(body, wl, wr);
      grp.scale.setScalar(1.2);
      this.scene.add(grp);
      this.gulls.push({
        grp,
        wl,
        wr,
        r: 14 + Math.random() * 26,
        h: 5 + Math.random() * 7,
        a: Math.random() * 6.28,
        v: 0.16 + Math.random() * 0.18,
        f: 4 + Math.random() * 4,
      });
    }
  }

  /* ------------------------------------------------------------- particles ---- */

  private mkField(cap: number, additive: boolean): THREE.Points {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
    geo.setAttribute('pcolor', new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
    geo.setAttribute('psize', new THREE.BufferAttribute(new Float32Array(cap), 1));
    geo.setAttribute('palpha', new THREE.BufferAttribute(new Float32Array(cap), 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: this.tex.soft }, uScale: { value: 900 } },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: [
        'attribute vec3 pcolor; attribute float psize; attribute float palpha;',
        'uniform float uScale; varying vec3 vC; varying float vA;',
        'void main(){ vC=pcolor; vA=palpha; vec4 mv=modelViewMatrix*vec4(position,1.0);',
        ' gl_Position=projectionMatrix*mv; gl_PointSize=psize*uScale/max(-mv.z,0.01); }',
      ].join('\n'),
      fragmentShader: [
        'uniform sampler2D uTex; varying vec3 vC; varying float vA;',
        'void main(){ if(vA<=0.002) discard; vec4 t=texture2D(uTex,gl_PointCoord);',
        ' gl_FragColor=vec4(vC, t.a*vA); }',
      ].join('\n'),
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    this.scene.add(pts);
    return pts;
  }

  private buildFields(): void {
    this.fieldAdd = { pts: this.mkField(1400, true), free: [], live: [], cap: 1400, n: 0, dirty: false };
    this.fieldNorm = { pts: this.mkField(1200, false), free: [], live: [], cap: 1200, n: 0, dirty: false };
  }

  private emit(
    additive: boolean,
    o: {
      p: THREE.Vector3;
      v: THREE.Vector3;
      ttl: number;
      s0: number;
      s1: number;
      c0: THREE.Color;
      c1?: THREE.Color;
      grav?: number;
      drag?: number;
      a0?: number;
      a1?: number;
      wind?: number;
    },
  ): void {
    const P = additive ? this.fieldAdd : this.fieldNorm;
    let i: number;
    if (P.free.length) i = P.free.pop()!;
    else if (P.n < P.cap) i = P.n++;
    else return;
    P.live.push({
      i,
      t: 0,
      ttl: o.ttl,
      p: o.p.clone(),
      v: o.v.clone(),
      grav: o.grav ?? 0,
      drag: o.drag ?? 0.6,
      s0: o.s0,
      s1: o.s1,
      c0: o.c0,
      c1: o.c1 ?? o.c0,
      a0: o.a0 ?? 1,
      a1: o.a1 ?? 0,
      wind: o.wind ?? 0,
    });
    P.dirty = true;
    this.wake(500);
  }

  private updField(P: Field, dt: number): void {
    if (!P.live.length && !P.dirty) return;
    const at = P.pts.geometry.attributes as unknown as Record<string, THREE.BufferAttribute>;
    for (let k = P.live.length - 1; k >= 0; k--) {
      const q = P.live[k];
      q.t += dt;
      const u = q.t / q.ttl;
      if (u >= 1) {
        at.palpha.array[q.i] = 0;
        P.free.push(q.i);
        P.live.splice(k, 1);
        P.dirty = true;
        continue;
      }
      q.v.y -= q.grav * dt;
      q.v.multiplyScalar(1 - q.drag * dt);
      if (q.wind) {
        q.v.x += q.wind * dt * 0.8;
        q.v.z += q.wind * dt * 0.3;
      }
      q.p.addScaledVector(q.v, dt);
      const i3 = q.i * 3;
      at.position.array[i3] = q.p.x;
      at.position.array[i3 + 1] = q.p.y;
      at.position.array[i3 + 2] = q.p.z;
      const c = this.scratchColor.copy(q.c0).lerp(q.c1, u);
      at.pcolor.array[i3] = c.r;
      at.pcolor.array[i3 + 1] = c.g;
      at.pcolor.array[i3 + 2] = c.b;
      at.psize.array[q.i] = q.s0 + (q.s1 - q.s0) * u;
      at.palpha.array[q.i] = q.a0 + (q.a1 - q.a0) * u;
    }
    at.position.needsUpdate = true;
    at.pcolor.needsUpdate = true;
    at.psize.needsUpdate = true;
    at.palpha.needsUpdate = true;
    P.dirty = false;
  }

  private buildPools(): void {
    for (let i = 0; i < 12; i++) {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(0.6, 1, 48),
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      this.scene.add(m);
      this.rings.push(m);
    }
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(1, 18, 14),
        new THREE.MeshBasicMaterial({
          color: 0xffb060,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      m.visible = false;
      this.scene.add(m);
      this.balls.push(m);
    }
    for (let i = 0; i < 14; i++) {
      const s = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.tex.soft,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          color: 0xffb070,
        }),
      );
      s.visible = false;
      this.scene.add(s);
      this.glows.push(s);
    }
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(
        new THREE.CylinderGeometry(0.5, 0.62, 1, 20, 1, true),
        new THREE.MeshBasicMaterial({
          map: this.tex.col,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      m.visible = false;
      this.scene.add(m);
      this.cols.push(m);
    }
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.07, 10, 8),
        new THREE.MeshStandardMaterial({
          color: 0x22282b,
          roughness: 0.4,
          metalness: 0.7,
          emissive: 0x210800,
          emissiveIntensity: 0.4,
        }),
      );
      m.visible = false;
      this.scene.add(m);
      this.shells.push(m);
    }
  }

  private take<T extends THREE.Object3D>(arr: T[]): T | null {
    return arr.find((o) => !o.visible) ?? null;
  }

  private tw(fn: (u: number) => void, dur: number, done?: () => void): void {
    this.tweens.push({ t: 0, d: dur, fn, done });
    this.wake(dur * 1000 + 100);
  }

  /** A tween that also resolves a promise, so shot choreography can be awaited. */
  private twAsync(fn: (u: number) => void, dur: number, done?: () => void): Promise<void> {
    return new Promise((resolve) => {
      this.tweens.push({
        t: 0,
        d: dur,
        fn,
        done: () => {
          done?.();
          resolve();
        },
      });
      this.wake(dur * 1000 + 100);
    });
  }

  /* ----------------------------------------------------------------- effects ---- */

  private ring(pos: THREE.Vector3, col: number, r0: number, r1: number, dur: number, op = 0.85) {
    const m = this.take(this.rings);
    if (!m) return;
    const mat = m.material as THREE.MeshBasicMaterial;
    m.visible = true;
    m.position.copy(pos);
    m.position.y += 0.03;
    mat.color.set(col);
    this.tw(
      (u) => {
        m.scale.setScalar(r0 + (r1 - r0) * u);
        mat.opacity = op * (1 - u) * (1 - u);
      },
      dur,
      () => {
        m.visible = false;
        mat.opacity = 0;
      },
    );
  }

  private glow(pos: THREE.Vector3, col: number, s0: number, s1: number, dur: number, op = 1) {
    const s = this.take(this.glows);
    if (!s) return;
    const mat = s.material as THREE.SpriteMaterial;
    s.visible = true;
    s.position.copy(pos);
    mat.color.set(col);
    this.tw(
      (u) => {
        const k = s0 + (s1 - s0) * u;
        s.scale.set(k, k, 1);
        mat.opacity = op * (1 - u);
      },
      dur,
      () => {
        s.visible = false;
        mat.opacity = 0;
      },
    );
  }

  private splash(pos: THREE.Vector3): void {
    const W = new THREE.Color(0xf2f8f7);
    const B = new THREE.Color(0xbcd8dc);
    const c = this.take(this.cols);
    if (c) {
      const mat = c.material as THREE.MeshBasicMaterial;
      c.visible = true;
      c.position.copy(pos);
      this.tw(
        (u) => {
          const h = 3.4 * Math.sin(Math.min(1, u * 1.35) * Math.PI * 0.75) + 0.2;
          c.scale.set(0.5 + u * 0.55, h, 0.5 + u * 0.55);
          c.position.y = pos.y + h / 2;
          mat.opacity = 0.85 * (1 - u * u);
        },
        1.5,
        () => {
          c.visible = false;
          mat.opacity = 0;
        },
      );
    }
    for (let i = 0; i < 46; i++) {
      const a = Math.random() * 6.28;
      const r = Math.random() * 0.34;
      this.emit(false, {
        p: pos.clone().add(new THREE.Vector3(Math.cos(a) * r, 0.1, Math.sin(a) * r)),
        v: new THREE.Vector3(
          Math.cos(a) * (0.7 + Math.random() * 1.6),
          3.4 + Math.random() * 3.4,
          Math.sin(a) * (0.7 + Math.random() * 1.6),
        ),
        grav: 7.4,
        drag: 0.25,
        ttl: 0.9 + Math.random() * 0.7,
        s0: 0.06 + Math.random() * 0.07,
        s1: 0.02,
        c0: W,
        c1: B,
        a0: 0.95,
        a1: 0,
      });
    }
    this.ring(pos, 0xd8ecec, 0.35, 3.2, 1.5, 0.5);
    this.ring(pos, 0xffffff, 0.2, 1.5, 0.8, 0.55);
    this.sfx('splash');
  }

  private boom(pos: THREE.Vector3): void {
    const F = this.fire;
    const Y = new THREE.Color(0xffe2a8);
    const S = new THREE.Color(0x161a1c);
    const S2 = new THREE.Color(0x3a3f42);
    const b = this.take(this.balls);
    if (b) {
      const mat = b.material as THREE.MeshBasicMaterial;
      b.visible = true;
      b.position.copy(pos);
      this.tw(
        (u) => {
          b.scale.setScalar(0.28 + u * 1.5);
          mat.color.lerpColors(Y, F, Math.min(1, u * 1.6));
          mat.opacity = 0.95 * (1 - u) * (1 - u);
        },
        0.75,
        () => {
          b.visible = false;
          mat.opacity = 0;
        },
      );
    }
    this.glow(pos.clone().setY(pos.y + 0.4), 0xffb267, 1.2, 6.5, 0.7, 0.95);
    this.glow(pos.clone().setY(pos.y + 0.3), 0xffe9c4, 0.6, 2.6, 0.35, 1);
    this.ring(pos, 0xffcf9a, 0.3, 3.6, 0.65, 0.85);
    for (let i = 0; i < 34; i++) {
      const a = Math.random() * 6.28;
      this.emit(true, {
        p: pos.clone(),
        v: new THREE.Vector3(
          Math.cos(a) * (1 + Math.random() * 3),
          1.6 + Math.random() * 4,
          Math.sin(a) * (1 + Math.random() * 3),
        ),
        grav: 3.4,
        drag: 0.9,
        ttl: 0.45 + Math.random() * 0.5,
        s0: 0.16 + Math.random() * 0.16,
        s1: 0.03,
        c0: Y,
        c1: F,
        a0: 1,
        a1: 0,
      });
    }
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * 6.28;
      this.emit(false, {
        p: pos.clone(),
        v: new THREE.Vector3(
          Math.cos(a) * (2 + Math.random() * 5),
          3 + Math.random() * 6,
          Math.sin(a) * (2 + Math.random() * 5),
        ),
        grav: 11,
        drag: 0.1,
        ttl: 0.9 + Math.random() * 0.8,
        s0: 0.045,
        s1: 0.03,
        c0: S2,
        c1: S,
        a0: 1,
        a1: 0.2,
      });
    }
    this.smoke(pos, 2.6, 26);
    this.shake(0.55);
    this.sfx('boom');
  }

  private smoke(pos: THREE.Vector3, dur: number, n: number): void {
    const S = new THREE.Color(0x22282a);
    const S2 = new THREE.Color(0x6a7276);
    for (let i = 0; i < n; i++) {
      setTimeout(
        () => {
          if (this.disposed) return;
          this.emit(false, {
            p: pos
              .clone()
              .add(new THREE.Vector3((Math.random() - 0.5) * 0.4, 0.1, (Math.random() - 0.5) * 0.4)),
            v: new THREE.Vector3(
              (Math.random() - 0.5) * 0.4,
              0.7 + Math.random() * 0.7,
              (Math.random() - 0.5) * 0.4,
            ),
            grav: -0.25,
            drag: 0.5,
            ttl: 3.4 + Math.random() * 2.6,
            wind: 0.5,
            s0: 0.3 + Math.random() * 0.2,
            s1: 1.5 + Math.random(),
            c0: S,
            c1: S2,
            a0: 0.62,
            a1: 0,
          });
        },
        (i / n) * dur * 1000,
      );
    }
  }

  private slick(pos: THREE.Vector3): void {
    const m = new THREE.Mesh(
      new THREE.CircleGeometry(1, 40),
      new THREE.MeshBasicMaterial({
        map: this.tex.soft,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        color: 0x120f0d,
      }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.copy(pos);
    m.position.y += 0.02;
    this.scene.add(m);
    this.slicks.push(m);
    const mat = m.material as THREE.MeshBasicMaterial;
    this.tw(
      (u) => {
        m.scale.setScalar(0.7 + u * 3.2);
        mat.opacity = 0.5 * (1 - u * 0.75);
      },
      14,
      () => {
        this.scene.remove(m);
        m.geometry.dispose();
        mat.dispose();
        this.slicks = this.slicks.filter((s) => s !== m);
      },
    );
  }

  private shake(a: number): void {
    this.cam.shake = Math.min(1.1, this.cam.shake + a);
  }

  private shellArc(
    from: THREE.Vector3,
    to: THREE.Vector3,
    opts: { apex: number; dur: number },
  ): Promise<void> {
    const m = this.take(this.shells);
    const mid = from.clone().add(to).multiplyScalar(0.5);
    mid.y += opts.apex;
    this.sfx('cannon');
    setTimeout(() => this.sfx('whistle'), opts.dur * 0.21 * 1000);
    const gun = from.clone();
    gun.y += 0.25;
    this.glow(gun, 0xffcf8a, 0.3, 2.2, 0.28, 1);
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * 6.28;
      this.emit(true, {
        p: gun.clone(),
        v: new THREE.Vector3(Math.cos(a) * 1.4, 0.6 + Math.random(), Math.sin(a) * 1.4),
        grav: 1,
        drag: 1.6,
        ttl: 0.3,
        s0: 0.14,
        s1: 0.02,
        c0: new THREE.Color(0xffe0b0),
        c1: this.fire,
        a0: 0.9,
        a1: 0,
      });
    }
    const S = new THREE.Color(0x8c9296);
    const S2 = new THREE.Color(0x2a3033);
    if (m) m.visible = true;
    return this.twAsync(
      (u) => {
        const p = new THREE.Vector3()
          .addScaledVector(from, (1 - u) * (1 - u))
          .addScaledVector(mid, 2 * (1 - u) * u)
          .addScaledVector(to, u * u);
        if (m) m.position.copy(p);
        if (Math.random() < 0.85) {
          this.emit(false, {
            p,
            v: new THREE.Vector3((Math.random() - 0.5) * 0.3, 0.3, (Math.random() - 0.5) * 0.3),
            grav: -0.1,
            drag: 0.7,
            ttl: 1.1 + Math.random() * 0.8,
            wind: 0.3,
            s0: 0.1,
            s1: 0.6,
            c0: S,
            c1: S2,
            a0: 0.5,
            a1: 0,
          });
        }
      },
      opts.dur,
      () => {
        if (m) m.visible = false;
      },
    );
  }

  private addPeg(slot: Slot, idx: number, hit: boolean): void {
    const b = this.boards.get(slot);
    if (!b) return;
    const im = hit ? b.pegR : b.pegW;
    if (im.count >= 100) return;
    const p = this.local(idx % BOARD, Math.floor(idx / BOARD));
    im.setMatrixAt(im.count, new THREE.Matrix4().makeTranslation(p.x, hit ? 0.06 : 0, p.z));
    im.count++;
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
  }

  /* ------------------------------------------------------------ public API ---- */

  setPhase(phase: ScenePhase, interactive: boolean): void {
    this.phase = phase;
    this.interactive = interactive;
    if (phase !== 'deploy') this.clearGhostTint();
    this.wake();
  }

  /** Boards the local player may raycast right now (deploy: `['you']`; battle: living foes). */
  setPickable(slots: Slot[]): void {
    this.pickable = slots;
    this.pickMeshes = [];
    this.meshToSlot.clear();
    slots.forEach((s) => {
      const rig = this.boards.get(s);
      if (!rig) return;
      this.pickMeshes.push(rig.pick);
      this.meshToSlot.set(rig.pick, s);
    });
    this.wake();
  }

  /** Highlights whichever board currently owns the turn (a soft light column). */
  setActingSlot(slot: Slot | null): void {
    this.actingSlot = slot;
  }

  /** Deployment preview: which ship is in hand and which cells are already used. */
  setGhost(ghost: GhostSpec): void {
    if (this.ghost && (!ghost || ghost.key !== this.ghost.key)) {
      const prev = this.visuals.get('you')?.get(this.ghost.key);
      if (prev && !prev.placement) {
        this.tint(prev.mesh, null);
        prev.mesh.visible = false;
        prev.floating = false;
      }
    }
    this.ghost = ghost;
    this.updateGhost();
  }

  private clearGhostTint(): void {
    if (!this.ghost) return;
    const v = this.visuals.get('you')?.get(this.ghost.key);
    if (v && !v.placement) {
      this.tint(v.mesh, null);
      v.mesh.visible = false;
      v.floating = false;
    }
    this.ghost = null;
    this.ghostCells = null;
    this.ghostValid = false;
  }

  private updateGhost(): void {
    const spec = this.ghost;
    if (!spec) return;
    const visual = this.visuals.get('you')?.get(spec.key);
    const def = SHIP_DEFS.find((d) => d.key === spec.key);
    if (!visual || !def) return;
    if (visual.placement) return;

    const onOwnBoard = this.hover?.slot === 'you';
    if (!onOwnBoard || this.phase !== 'deploy') {
      visual.mesh.visible = false;
      visual.floating = false;
      this.ghostCells = null;
      this.ghostValid = false;
      return;
    }

    const hoverIdx = this.hover!.idx;
    const cells = cellsFor(hoverIdx, def.len, spec.orient);
    const taken = new Set(spec.occupied);
    const ok = Boolean(cells) && cells!.every((c) => !taken.has(c));
    this.ghostCells = cells;
    this.ghostValid = ok;

    visual.mesh.visible = true;
    visual.floating = true;
    const c0 = hoverIdx % BOARD;
    const r0 = Math.floor(hoverIdx / BOARD);
    const cx = spec.orient === 'H' ? c0 + (def.len - 1) / 2 : c0;
    const cz = spec.orient === 'H' ? r0 : r0 + (def.len - 1) / 2;
    const p = this.local(Math.min(cx, 9), Math.min(cz, 9));
    visual.mesh.position.set(p.x, visual.baseY + 0.16, p.z);
    visual.mesh.rotation.y = spec.orient === 'H' ? 0 : Math.PI / 2;
    this.tint(visual.mesh, ok ? 0x1d5a3a : 0x7a1b12, 0.5);
  }

  /** True when the cell under the cursor is a legal drop for the ship in hand. */
  ghostIsValid(): boolean {
    return this.ghostValid && this.ghostCells !== null;
  }

  private tint(mesh: THREE.Object3D, col: number | null, k = 0.5): void {
    mesh.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const ud = m.userData as {
        baseMat?: THREE.Material;
        tintMat?: THREE.MeshStandardMaterial;
      };
      if (!ud.baseMat) ud.baseMat = m.material as THREE.Material;
      if (col == null) {
        m.material = ud.baseMat;
        return;
      }
      if (!ud.tintMat) {
        const clone = (ud.baseMat as THREE.MeshStandardMaterial).clone();
        clone.emissive = new THREE.Color(col);
        clone.emissiveIntensity = k;
        clone.transparent = true;
        clone.opacity = 0.85;
        ud.tintMat = clone;
      } else {
        ud.tintMat.emissive.set(col);
      }
      m.material = ud.tintMat;
    });
  }

  /** Positions and reveals a board's hulls — used for both `you` and `ally`. */
  setFleet(slot: Slot, fleet: Placement[]): void {
    fleet.forEach((p) => this.placeShip(slot, p, true));
  }

  /** Places a single hull. `visible` is false for a fogged board until it sinks. */
  private placeShip(slot: Slot, placement: Placement, visible: boolean): void {
    const visual = this.visuals.get(slot)?.get(placement.key);
    if (!visual) return;
    const def = SHIP_DEFS.find((d) => d.key === placement.key)!;
    const c0 = placement.cells[0] % BOARD;
    const r0 = Math.floor(placement.cells[0] / BOARD);
    const cx = placement.orient === 'H' ? c0 + (def.len - 1) / 2 : c0;
    const cz = placement.orient === 'H' ? r0 : r0 + (def.len - 1) / 2;
    const p = this.local(cx, cz);
    this.tint(visual.mesh, null);
    visual.mesh.position.set(p.x, visual.baseY, p.z);
    visual.mesh.rotation.y = placement.orient === 'H' ? 0 : Math.PI / 2;
    visual.mesh.rotation.z = 0;
    visual.mesh.rotation.x = 0;
    visual.mesh.visible = visible;
    visual.placement = placement;
    visual.floating = false;
  }

  /** Pulls a single hull back off the board (re-placing during deployment). */
  clearShip(slot: Slot, key: ShipKey): void {
    const visual = this.visuals.get(slot)?.get(key);
    if (!visual) return;
    this.tint(visual.mesh, null);
    visual.mesh.visible = false;
    visual.mesh.rotation.set(0, 0, 0);
    visual.placement = null;
    visual.sunk = false;
    visual.floating = false;
  }

  /** Empties one board's fleet without touching pegs or effects. */
  clearFleet(slot: Slot): void {
    this.visuals.get(slot)?.forEach((v) => this.clearShip(slot, v.key));
  }

  /** Silent board restore — used on first load and on reconnect. */
  syncBoard(slot: Slot, marks: readonly number[]): void {
    const b = this.boards.get(slot);
    if (!b) return;
    b.pegW.count = 0;
    b.pegR.count = 0;
    marks.forEach((m, idx) => {
      if (m === 1) this.addPeg(slot, idx, false);
      else if (m === 2) this.addPeg(slot, idx, true);
    });
    b.pegW.instanceMatrix.needsUpdate = true;
    b.pegR.instanceMatrix.needsUpdate = true;
  }

  /** Shows an already-sunk hull without replaying the animation. */
  revealSunkSilently(slot: Slot, placement: Placement): void {
    const visual = this.visuals.get(slot)?.get(placement.key);
    if (!visual || visual.sunk) return;
    this.placeShip(slot, placement, true);
    visual.sunk = true;
    visual.mesh.position.y = visual.baseY;
    visual.mesh.rotation.z = 0.55;
  }

  /**
   * Full shot choreography: muzzle flash, arc, impact, peg, and the sinking hull.
   * The shell always leaves from the rim of `from` facing `to`.
   */
  async playShot(opts: {
    from: Slot;
    to: Slot;
    idx: number;
    hit: boolean;
    sunk: Placement | null;
  }): Promise<void> {
    const { from, to, idx, hit, sunk } = opts;
    const fromRig = this.boards.get(from);
    const toRig = this.boards.get(to);
    if (!fromRig || !toRig) return;

    const dir = new THREE.Vector3(
      toRig.grp.position.x - fromRig.grp.position.x,
      0,
      toRig.grp.position.z - fromRig.grp.position.z,
    );
    if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0);
    dir.normalize();
    const src = fromRig.grp.position.clone().addScaledVector(dir, 4.4);
    src.y += 0.6;
    const dst = this.worldCell(to, idx);
    const dist = src.distanceTo(dst);

    await this.shellArc(src, dst, {
      apex: 4.2 + dist * 0.3,
      dur: Math.min(1.7, Math.max(1.0, 0.85 + dist * 0.028)),
    });
    if (this.disposed) return;

    if (hit) {
      const p = dst.clone();
      p.y += 0.2;
      this.boom(p);
    } else {
      this.splash(dst.clone());
    }
    this.addPeg(to, idx, hit);

    if (sunk) {
      // A fogged hull's position is only known now that the server revealed it.
      if (this.slotMeta.get(to)?.fogged) this.placeShip(to, sunk, true);
      this.sinkShip(to, sunk);
    }
    await new Promise<void>((r) => setTimeout(r, hit ? 460 : 300));
    if (this.disposed) return;
  }

  /** A short, watchable representation of the 50-cell special bombardment. */
  async playSpecialBombardment(opts: { from: Slot; to: Slot; cells: readonly number[]; marks: readonly number[] }): Promise<void> {
    const fromRig = this.boards.get(opts.from);
    const toRig = this.boards.get(opts.to);
    if (!fromRig || !toRig) return;
    const dir = new THREE.Vector3(toRig.grp.position.x - fromRig.grp.position.x, 0, toRig.grp.position.z - fromRig.grp.position.z);
    if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0);
    dir.normalize();
    const src = fromRig.grp.position.clone().addScaledVector(dir, 4.4);
    src.y += 0.6;
    // Every real impact gets its own missile, but at a brisk cadence so the
    // fifty-cell barrage is still watchable rather than a long cutscene.
    for (const idx of opts.cells) {
      const dst = this.worldCell(opts.to, idx);
      await this.shellArc(src.clone(), dst, { apex: 3.4, dur: 0.085 });
      if (this.disposed) return;
      const hit = opts.marks[idx] === 2;
      if (hit) this.boom(dst.clone().add(new THREE.Vector3(0, 0.2, 0)));
      else this.splash(dst.clone());
      this.addPeg(opts.to, idx, hit);
      await new Promise<void>((resolve) => setTimeout(resolve, 18));
    }
  }

  /** Reveals and sinks the two ships destroyed by the special strike in sequence. */
  async playSpecialSinks(slot: Slot, ships: readonly Placement[]): Promise<void> {
    for (const ship of ships) {
      // A concurrent snapshot restore may already have rendered this wreck.
      // Reset this one visual so a special's sacrifice is always witnessed.
      const visual = this.visuals.get(slot)?.get(ship.key);
      if (visual) visual.sunk = false;
      this.placeShip(slot, ship, true);
      this.sinkShip(slot, ship, 0.85);
      await new Promise<void>((resolve) => setTimeout(resolve, 920));
      if (this.disposed) return;
    }
  }

  /** A concentrated blast used before the traitor's sacrificed ally ship sinks. */
  async playSpecialExplosion(slot: Slot, ship: Placement): Promise<void> {
    if (this.slotMeta.get(slot)?.fogged) this.placeShip(slot, ship, true);
    const center = ship.cells[Math.floor(ship.cells.length / 2)];
    for (const idx of ship.cells) {
      const point = this.worldCell(slot, idx).add(new THREE.Vector3(0, 0.35, 0));
      this.boom(point);
    }
    this.shake(0.8);
    await new Promise<void>((resolve) => setTimeout(resolve, 460));
    if (this.disposed) return;
    // Keep the centre hot for a beat after the initial cell-by-cell detonation.
    this.boom(this.worldCell(slot, center).add(new THREE.Vector3(0, 0.5, 0)));
  }

  private sinkShip(slot: Slot, placement: Placement, duration = 2.2): void {
    const visual = this.visuals.get(slot)?.get(placement.key);
    if (!visual || visual.sunk) return;
    visual.sunk = true;
    const m = visual.mesh;
    m.visible = true;
    const y0 = m.position.y;
    const rz = (Math.random() > 0.5 ? 1 : -1) * 0.55;
    this.sfx('sink');
    this.tw(
      (u) => {
        const e = u * u;
        // Let the wreck settle back to the sea surface, where it remains visible
        // as a persistent marker for the already-cleared cells.
        m.position.y = y0 + (visual.baseY - y0) * e;
        m.rotation.z = rz * Math.min(1, u * 1.4);
        m.rotation.x = 0.16 * Math.sin(u * 3);
        if (Math.random() < 0.7) {
          const wp = m.getWorldPosition(new THREE.Vector3());
          this.emit(false, {
            p: wp
              .clone()
              .add(
                new THREE.Vector3(
                  (Math.random() - 0.5) * placement.cells.length * 0.7,
                  0.1,
                  (Math.random() - 0.5) * 0.5,
                ),
              ),
            v: new THREE.Vector3(
              (Math.random() - 0.5) * 0.4,
              0.9 + Math.random(),
              (Math.random() - 0.5) * 0.4,
            ),
            grav: -0.4,
            drag: 0.4,
            ttl: 1.1,
            s0: 0.05,
            s1: 0.14,
            c0: new THREE.Color(0xdff0f0),
            c1: new THREE.Color(0xa8cdd2),
            a0: 0.75,
            a1: 0,
          });
        }
      },
      duration,
      () => {
        m.position.y = visual.baseY;
        m.rotation.z = rz;
        m.rotation.x = 0;
      },
    );
    const mid = placement.cells[Math.floor(placement.cells.length / 2)];
    const c = this.worldCell(slot, mid);
    this.slick(c);
    this.smoke(c, 3.2, 20);
    this.cam.push = 1;
  }

  /** Marks a board destroyed: light and fog drop, the table dips, the plate redraws. */
  markEliminated(slot: Slot): void {
    const spec = this.slotMeta.get(slot);
    if (!spec || spec.eliminated) return;
    this.slotMeta.set(slot, { ...spec, eliminated: true });
    const rig = this.boards.get(slot);
    if (rig) this.applySlotMeta(rig, this.slotMeta.get(slot)!);
  }

  /** Wipes every board for a rematch. */
  reset(): void {
    this.boards.forEach((b, slot) => {
      b.pegW.count = 0;
      b.pegR.count = 0;
      b.pegW.instanceMatrix.needsUpdate = true;
      b.pegR.instanceMatrix.needsUpdate = true;
      this.visuals.get(slot)?.forEach((v) => {
        this.tint(v.mesh, null);
        v.mesh.visible = false;
        v.mesh.rotation.set(0, 0, 0);
        v.mesh.position.y = v.baseY;
        v.placement = null;
        v.sunk = false;
        v.floating = false;
      });
      const spec = this.slotMeta.get(slot);
      if (spec && spec.eliminated) {
        const revived = { ...spec, eliminated: false };
        this.slotMeta.set(slot, revived);
        this.applySlotMeta(b, revived);
      }
    });
    this.slicks.slice().forEach((s) => {
      this.scene.remove(s);
      s.geometry.dispose();
      (s.material as THREE.Material).dispose();
    });
    this.slicks = [];
    this.ghost = null;
    this.ghostCells = null;
    this.ghostValid = false;
    this.hover = null;
  }

  /* ------------------------------------------------------------ interaction ---- */

  private pointerOf(e: PointerEvent | WheelEvent): {
    x: number;
    y: number;
    cx: number;
    cy: number;
  } {
    const r = this.renderer.domElement.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * 2 - 1,
      y: -((e.clientY - r.top) / r.height) * 2 + 1,
      cx: e.clientX,
      cy: e.clientY,
    };
  }

  private bind(): void {
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove, { passive: true });
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', this.onPointerUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKeyDown);
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.wake();
    try {
      this.renderer.domElement.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    const p = this.pointerOf(e);
    this.drag = { cx: p.cx, cy: p.cy, th: this.cam.tth, ph: this.cam.tph };
    this.moved = 0;
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.cx - b.cx, a.cy - b.cy), rad: this.cam.trad };
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    this.wake();
    const p = this.pointerOf(e);
    this.pointers.set(e.pointerId, p);

    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.cx - b.cx, a.cy - b.cy);
      const [lo, hi] = this.radClamp();
      this.cam.trad = Math.max(lo, Math.min(hi, this.pinch.rad * (this.pinch.d / Math.max(1, d))));
      return;
    }
    if (this.drag) {
      const dx = p.cx - this.drag.cx;
      const dy = p.cy - this.drag.cy;
      this.moved = Math.max(this.moved, Math.hypot(dx, dy));
      if (this.moved > 4) {
        this.cam.tth = this.drag.th - dx * 0.0055;
        this.cam.tph = Math.max(0.16, Math.min(1.16, this.drag.ph - dy * 0.004));
      }
    }
    this.updateHover(p.x, p.y);
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.wake(150);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.drag && this.moved < 5 && this.hover && this.interactive) {
      this.onPick?.(this.hover);
    }
    this.drag = null;
  };

  private radClamp(): [number, number] {
    const base = this.rosterLength >= 4 ? CAM_4 : CAM_2;
    const solved = this.mobile ? base.radMobile : base.rad;
    return [solved * 0.55, solved * 2.0];
  }

  private onWheel = (e: WheelEvent): void => {
    this.wake();
    e.preventDefault();
    const [lo, hi] = this.radClamp();
    this.cam.trad = Math.max(lo, Math.min(hi, this.cam.trad + e.deltaY * 0.018));
  };

  /** Only camera keys live here; game keys are owned by the React layer. */
  private onKeyDown = (): void => {};

  private updateHover(nx: number, ny: number): void {
    let hit: BoardHit | null = null;
    if (this.interactive && this.pickMeshes.length) {
      this.ray.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
      const found = this.ray.intersectObjects(this.pickMeshes, false)[0];
      if (found) {
        const slot = this.meshToSlot.get(found.object);
        const rig = slot ? this.boards.get(slot) : undefined;
        if (slot && rig) {
          const l = rig.grp.worldToLocal(found.point.clone());
          const c = Math.floor(l.x + 5);
          const r = Math.floor(l.z + 5);
          if (c >= 0 && c < BOARD && r >= 0 && r < BOARD) hit = { slot, idx: r * BOARD + c };
        }
      }
    }
    if (hit?.slot !== this.hover?.slot || hit?.idx !== this.hover?.idx) {
      this.hover = hit;
      this.onHover?.(hit);
      if (this.phase === 'deploy') this.updateGhost();
    }
  }

  /* ------------------------------------------------------------------ audio ---- */

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (!muted) {
      const ac = this.audio();
      if (ac && this.master) this.master.gain.linearRampToValueAtTime(0.55, ac.currentTime + 0.4);
    } else if (this.ac && this.master) {
      this.master.gain.linearRampToValueAtTime(0, this.ac.currentTime + 0.2);
    }
  }

  private audio(): AudioContext | null {
    if (!this.ac) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      this.ac = new AC();
      this.master = this.ac.createGain();
      this.master.gain.value = 0;
      this.master.connect(this.ac.destination);

      const len = this.ac.sampleRate * 3;
      const buf = this.ac.createBuffer(1, len, this.ac.sampleRate);
      const d = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.2;
      }
      const src = this.ac.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const lp = this.ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 380;
      const gg = this.ac.createGain();
      gg.gain.value = 0.5;
      src.connect(lp);
      lp.connect(gg);
      gg.connect(this.master);
      src.start();
      this.noiseBuf = buf;
      this.gullTimer = setInterval(() => {
        if (!this.muted && Math.random() < 0.5) this.sfx('gull');
      }, 7000);
    }
    if (this.ac.state === 'suspended') void this.ac.resume();
    return this.ac;
  }

  private sfx(kind: Sfx): void {
    if (this.muted || !this.ac || !this.master || !this.noiseBuf) return;
    const ac = this.ac;
    const t = ac.currentTime;
    const out = this.master;

    const noise = (dur: number, type: BiquadFilterType, f0: number, f1: number, g0: number, q?: number) => {
      const s = ac.createBufferSource();
      s.buffer = this.noiseBuf;
      s.loop = true;
      const bp = ac.createBiquadFilter();
      bp.type = type;
      bp.frequency.setValueAtTime(f0, t);
      bp.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
      if (q) bp.Q.value = q;
      const g = ac.createGain();
      g.gain.setValueAtTime(g0, t);
      g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
      s.connect(bp);
      bp.connect(g);
      g.connect(out);
      s.start(t);
      s.stop(t + dur + 0.05);
    };
    const tone = (f0: number, f1: number, dur: number, g0: number, type: OscillatorType = 'sine') => {
      const o = ac.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
      const g = ac.createGain();
      g.gain.setValueAtTime(g0, t);
      g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
      o.connect(g);
      g.connect(out);
      o.start(t);
      o.stop(t + dur + 0.02);
    };

    if (kind === 'cannon') {
      noise(0.34, 'lowpass', 900, 120, 0.75, 1);
      tone(150, 42, 0.4, 0.55);
    } else if (kind === 'whistle') {
      tone(1750, 420, 0.85, 0.055);
    } else if (kind === 'splash') {
      noise(0.55, 'highpass', 700, 2600, 0.32, 0.7);
      noise(0.4, 'lowpass', 500, 140, 0.24);
    } else if (kind === 'boom') {
      noise(1.1, 'lowpass', 1600, 90, 0.9, 1);
      tone(110, 26, 1.1, 0.6, 'triangle');
      noise(0.3, 'highpass', 1800, 900, 0.2);
    } else if (kind === 'sink') {
      noise(2.2, 'lowpass', 420, 90, 0.4, 1.4);
      tone(210, 60, 2, 0.16);
    } else if (kind === 'gull') {
      [0, 0.16, 0.34].forEach((d, i) => {
        const o = ac.createOscillator();
        o.type = 'sawtooth';
        const g = ac.createGain();
        const bp = ac.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 2100 + i * 180;
        bp.Q.value = 6;
        o.frequency.setValueAtTime(1500 - i * 120, t + d);
        o.frequency.exponentialRampToValueAtTime(900, t + d + 0.16);
        g.gain.setValueAtTime(0.06, t + d);
        g.gain.exponentialRampToValueAtTime(0.001, t + d + 0.19);
        o.connect(bp);
        bp.connect(g);
        g.connect(out);
        o.start(t + d);
        o.stop(t + d + 0.22);
      });
    } else if (kind === 'click') {
      tone(880, 620, 0.07, 0.06, 'square');
    }
  }

  click(): void {
    this.sfx('click');
  }

  /* ------------------------------------------------------------------ frame ---- */

  private frame(dt: number): void {
    this.t += dt;
    const t = this.t;
    this.ocean.material.uniforms.uTime.value = t;

    for (let i = this.tweens.length - 1; i >= 0; i--) {
      const f = this.tweens[i];
      f.t += dt;
      const u = Math.min(1, f.t / f.d);
      f.fn(u);
      if (u >= 1) {
        this.tweens.splice(i, 1);
        f.done?.();
      }
    }
    this.updField(this.fieldAdd, dt);
    this.updField(this.fieldNorm, dt);

    this.boards.forEach((b, slot) => {
      if (!b.grp.visible) return;
      const meta = this.slotMeta.get(slot);
      const fogged = meta?.fogged ?? slot.startsWith('foe');

      this.visuals.get(slot)?.forEach((v) => {
        if (!v.mesh.visible || v.sunk) return;
        const wp = v.mesh.getWorldPosition(this.scratchWorld);
        const h = this.waveH(wp.x, wp.z, t) * 0.34;
        v.mesh.position.y = v.baseY + h + (v.floating ? 0.16 : 0);
        v.mesh.rotation.z = Math.sin(t * 0.75 + v.bobPhase) * 0.028;
        v.mesh.rotation.x = Math.sin(t * 0.55 + v.bobPhase * 1.7) * 0.02;
        v.anim.forEach((a) => {
          if (a.k === 'spin') a.o.rotation.y = t * a.s;
          else a.o.rotation.y = Math.sin(t * a.s + (a.ph ?? 0)) * 0.55;
        });
      });

      const show = this.interactive && this.hover?.slot === slot;
      b.col.visible = show && fogged;
      b.ret.visible = show;
      if (show) {
        const p = this.local(this.hover!.idx % BOARD, Math.floor(this.hover!.idx / BOARD));
        b.col.position.set(p.x, 1.6, p.z);
        (b.col.material as THREE.MeshBasicMaterial).opacity = 0.28 + 0.16 * Math.sin(t * 3);
        b.ret.position.set(p.x, 0.05, p.z);
        b.ret.rotation.z = t * 0.6;
        b.ret.scale.setScalar(1 + 0.04 * Math.sin(t * 5));
      }
      if (b.blanket.visible) {
        const mat = b.blanket.material as THREE.MeshBasicMaterial;
        mat.opacity = 0.34 + 0.06 * Math.sin(t * 0.4);
        b.blanket.position.y = 0.4 + 0.04 * Math.sin(t * 0.5);
      }
      b.grp.position.y = b.basePos.y + this.waveH(b.grp.position.x, 0, t) * 0.1;
      b.grp.rotation.z = Math.sin(t * 0.4 + b.phase) * 0.006;

      // Billboard the nameplate toward the camera, compensating for the board's yaw.
      const worldPos = b.grp.getWorldPosition(this.scratchWorld);
      const toCam = Math.atan2(this.camera.position.x - worldPos.x, this.camera.position.z - worldPos.z);
      b.plate.rotation.y = toCam - b.grp.rotation.y;

      // The acting board rises slightly and its rail glows — the primary
      // "whose turn is it" cue at wide framing.
      const acting = this.actingSlot === slot && !meta?.eliminated;
      b.grp.position.y += acting ? 0.08 : 0;
      const baseIntensity = meta?.eliminated ? 0 : meta?.relation === 'self' ? 0.75 : 0.4;
      b.rail.emissiveIntensity = acting
        ? baseIntensity + 0.35 + 0.15 * Math.sin(t * 4)
        : baseIntensity;
    });

    this.clouds.forEach((c) => {
      c.sp.position.x += c.v * dt;
      if (c.sp.position.x > 400) c.sp.position.x = -400;
    });
    this.gulls.forEach((k) => {
      k.a += k.v * dt;
      k.grp.position.set(Math.cos(k.a) * k.r, k.h + Math.sin(k.a * 2) * 0.8, Math.sin(k.a) * k.r);
      k.grp.rotation.y = -k.a + Math.PI / 2;
      const f = Math.sin(t * k.f) * 0.6;
      k.wl.rotation.x = f;
      k.wr.rotation.x = -f;
    });

    const c = this.cam;
    c.th += (c.tth - c.th) * Math.min(1, dt * 6);
    c.ph += (c.tph - c.ph) * Math.min(1, dt * 6);
    if (c.push > 0) c.push = Math.max(0, c.push - dt * 0.7);
    c.rad += (c.trad * (1 - c.push * 0.1) - c.rad) * Math.min(1, dt * 4);
    const cp = this.scratchCamera.setFromSphericalCoords(c.rad, Math.PI / 2 - c.ph, c.th);
    cp.add(this.target);
    if (c.shake > 0.001) {
      c.shake *= Math.pow(0.02, dt);
      const k = c.shake * 0.16;
      cp.x += (Math.random() - 0.5) * k;
      cp.y += (Math.random() - 0.5) * k;
      cp.z += (Math.random() - 0.5) * k;
    }
    this.camera.position.copy(cp);
    this.camera.lookAt(this.target);
    this.ocean.material.uniforms.uCam.value.copy(cp);
    this.sky.position.copy(cp);

    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
  }
}

/** Creates the scene, translating a missing WebGL context into a readable error. */
export function createScene(opts: SceneOptions): SeaBattleScene | null {
  try {
    return new SeaBattleScene(opts);
  } catch (err) {
    opts.onFatal?.(
      err instanceof Error && err.message
        ? err.message
        : 'This browser or device could not open a WebGL context.',
    );
    return null;
  }
}
