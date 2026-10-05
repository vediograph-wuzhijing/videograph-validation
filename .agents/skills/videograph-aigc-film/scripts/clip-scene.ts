// clip-scene.ts — AIGC 短片的 VideoGraph 场景模板：AI 视频镜头（帧序列）+ 关键帧兜底 + 黑场 + 字幕 + 快切节拍冲击。
// 用法：全片所有镜头提交同一份源码，按 params.kind 切换；在此基础上增加本片的 engine 类版式（手机界面、地图、落版…）。
// params：{ shot: 's05', kind: 'video' | 'black', frames: 99, subs: [{ t, text, who: 'hero' | 'narrator' }], punch?: [t0, t1] }
// 素材：工程 engine/app/public/<DIR>/<shot>/0001.jpg…（ffmpeg 截本镜时长转 1280×720）；缺视频时放 <DIR>/kf-<shot>.jpg。
// 所有画面是 f.lt 的确定性函数；素材只在 init() 加载。
import * as THREE from 'three';
import { Scene, type Frame, type PostOverrides } from '../engine/scene';
import { Layer2D, W, H } from '../engine/gl';
import { clamp, lerp, ease, hash } from '../engine/util';

type C2 = CanvasRenderingContext2D;
type P = Record<string, any>;
const DIR = 'aigc';          // 改成本片的素材目录名
const FPS = 24;              // Seedance 输出帧率
const sans = (px: number, wt = 500) => `${wt} ${px}px "Noto Sans SC", sans-serif`;
const pr = (x: number, a: number, d: number) => clamp((x - a) / d);

function cover(c: C2, img: CanvasImageSource | undefined, z = 1, ox = 0) {
  if (!img) return;
  const w = W * z, h = H * z; c.drawImage(img, (W - w) / 2 + ox, (H - h) / 2, w, h);
}
function dust(c: C2, t: number, n: number, a: number) {   // 金色光尘（确定性）
  c.save(); c.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) {
    const x = ((hash(i, 1) * W + t * (12 + 30 * hash(i, 2))) % (W + 40)) - 20;
    const y = ((hash(i, 3) * H - t * (18 + 40 * hash(i, 4))) % H + H) % H;
    const r = 1 + 2.6 * hash(i, 5), tw = 0.5 + 0.5 * Math.sin(t * (1.5 + hash(i, 6) * 3) + i);
    const g = c.createRadialGradient(x, y, 0, x, y, r * 4); g.addColorStop(0, `rgba(255,220,150,${a * tw})`); g.addColorStop(1, 'rgba(255,180,80,0)');
    c.fillStyle = g; c.fillRect(x - r * 4, y - r * 4, r * 8, r * 8);
  }
  c.restore();
}
function subtitles(c: C2, subs: { t: number; text: string; who: string }[], lt: number) {
  for (const s of subs) {
    const d = 0.7 + s.text.length * 0.2, a = pr(lt, s.t, 0.15) * (1 - pr(lt, s.t + d, 0.25));
    if (a <= 0) continue;
    c.save(); c.globalAlpha = a; c.shadowColor = 'rgba(0,0,0,0.85)'; c.shadowBlur = 12;
    c.font = sans(42, s.who === 'hero' ? 500 : 400); c.textAlign = 'center'; c.fillStyle = s.who === 'hero' ? '#FFFFFF' : '#F6E3BA';
    c.fillText(s.text, W / 2, H - 78); c.restore();
  }
}

export default class AigcClip extends Scene {
  private ui = new Layer2D();
  private frames: ImageBitmap[] = [];
  private kf: ImageBitmap | null = null;

  override async init() {
    const P = this.ctx.params as P;
    const load = async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`素材缺失 ${res.status}：${url}`);
      return createImageBitmap(await res.blob());
    };
    // 帧序列全部预解码成 ImageBitmap（1280×720 每帧约 3.7MB）：几百帧的长镜头会占用上 GB 内存，长镜头请拆分或降分辨率。
    if (P.kind === 'video') {
      if (P.frames > 0) this.frames = await Promise.all(Array.from({ length: P.frames }, (_, i) => load(`${DIR}/${P.shot}/${String(i + 1).padStart(4, '0')}.jpg`)));
      else this.kf = await load(`${DIR}/kf-${P.shot}.jpg`);
    }
    await Promise.all(['500 64px "Noto Sans SC"', '400 64px "Noto Sans SC"'].map((f) => document.fonts.load(f, '如果可以实现一个愿望')));
  }

  render(f: Frame, out: THREE.WebGLRenderTarget): PostOverrides {
    const { renderer, comp } = this.ctx;
    const P = this.ctx.params as P, lt = f.lt, dur = this.ctx.end - this.ctx.start;
    const L = this.ui; L.clear('#000'); const c = L.ctx;
    let post: PostOverrides = {};
    if (P.kind === 'video') {
      if (this.frames.length) cover(c, this.frames[clamp(Math.floor(lt * FPS), 0, this.frames.length - 1)], 1 + 0.02 * (lt / dur));
      else { cover(c, this.kf ?? undefined, 1.04 + 0.06 * ease.inOutQuad(lt / dur), lerp(-14, 14, lt / dur)); dust(c, f.t, 40, 0.5); }
      // 快切段逐拍推镜冲击：params.punch = [起, 止]（歌曲秒）
      if (P.punch && f.t >= P.punch[0] && f.t < P.punch[1]) {
        const hit = Math.pow(1 - f.beatPhase, 3), down = f.barPhase < 0.25;
        post = { zoom: 1 + 0.035 * hit * (down ? 1 : 0.55), flash: down ? 0.12 * hit : 0 };
      }
    } else if (P.kind === 'black') dust(c, f.t, 26, 0.35 * pr(lt, 0.3, 1.0));
    if (P.subs?.length) subtitles(c, P.subs, lt);
    comp.draw(renderer, L.upload(), out, { mode: 'replace' });
    return { bloom: 0.35, bloomThreshold: 0.88, halation: 0.12, ca: 0.4, grain: 0.03, vignette: 0.25, hud: 0, ...post };
  }

  dispose() { this.ui.texture.dispose(); for (const b of this.frames) b.close(); this.kf?.close(); }
}
