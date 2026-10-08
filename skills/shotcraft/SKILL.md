---
name: shotcraft
version: 1.6.0
toolset: 2026-10-08
description: 确定性节拍驱动代码视频的通用分镜/转场/特效/媒介风格技法库（从 pdoom-video 及 25 个 Opus 5.5 视频开源仓库蒸馏，平台无关）。当用户要为生成式音乐视频/动态影像设计分镜、转场、特效或视觉媒介风格（刻线版画、水彩笔刷、risograph、halftone、剪纸、火花、逐词卡拉OK、字体猛击、无限晶格、Droste、倒带循环…），要复刻某种视觉手法，或在使用 VideoGraph 平台（videograph MCP 全引擎 Scene 管线）制作 PV 时使用。关键词：分镜、转场、特效、镜头卡、PV、卡拉OK、刻线、版画、riso、笔刷、媒介模拟、spark、videograph、VideoGraph、opus。
---

# shotcraft：确定性代码视频的分镜·转场·特效技法库

一套平台无关的制作工艺，核心世界观只有一句话：**每帧是歌曲时间 t 的确定性纯函数，
一切节拍/歌词事件从分析数据推导，受限调色板 + 单一强调色 + 辉光纪律**。
技法语料来自 pdoom-video（本仓库同级 `../pdoom-video`，MIT），所有手法都标注了范例出处，
但每一条都给出了脱离该工程的通用做法。语料清单与许可逐条见 [SOURCES.md](SOURCES.md)。

两个用途：
1. **自由创作**：任何项目里设计分镜/转场/特效（本文 + 三个 references）。
2. **VideoGraph 全引擎管线**（videograph MCP，Scene 类 TS 场景）→ 先读
   `references/platform-videograph.md`。

VideoGraph开工先检索已有特效和基础件；有参考作品先渲染抽帧并观察运动，再读代码。每轮默认连续帧自查与意见收件箱，导出前说明未验证项。具体参数、混合媒介经验、文字PV配方和歌曲对拍见[PV制作流程](references/pv-production.md)，也可用`craft_guide({topic:"pv-production"})`读取。

## 五条通用法则（任何平台都先过这一关）

1. **确定性**：输出是 `t` 的纯函数。禁 `Math.random()/Date.now()/performance.now()`；
   随机用种子 RNG（mulberry32）与 hash；任何"每帧抖动"都要以帧号为种子，不能用连续时间
   累积状态——否则运动模糊子帧、seek、倒放、逐帧重放全部崩坏。
2. **时间从数据推导**：分镜切点 = 歌词行首词所在（或之前）最近的拍；板内事件 = 词起点
   （`word.start`，可细化到音节/字符）吸附到拍网格。**绝不手写秒数当事件锚**。
3. **调色板与辉光纪律**：墨黑底 / 骨白主字 / **唯一信号橙 = 语义强调**（火花、唱词、数字、
   关键动效），至多一个一次性 accent 色。只有强调色允许进辉光（线性域 >0.85 或
   shadowBlur），主文字永不发光。
4. **卡拉OK法则**：逐词同步是硬约束——高亮永远不超前于人声；预显整行 ≤0.4s 可。
   未唱 = 低透明度/描边预览，唱中 = 强调色，唱完 = 冷却回主字色。
5. **一镜一主角 + 节拍律动**：每个镜头只讲一个动效；大变化（切、爆、换色、砸落）落在
   downbeat/kick/snare 上，用脉冲衰减（halfLife 0.06–0.22s）驱动 shake/zoom/flash；
   强缓动（outExpo/outBack/spring）、有蓄力有释放，忌匀速漂。

## 文件地图

| 时机 | 读 |
|------|----|
| 设计分镜（选镜头范式） | `references/shots.md` — 17 种分镜范式库 |
| 设计剪辑与转场 | `references/transitions.md` |
| 写视觉代码（手法/公式/参数速查） | `references/effects.md` |
| 选/实现视觉媒介风格（水彩/riso/GPU 笔刷/剪纸/18 媒介引擎…） | `references/media-styles.md` — 媒介风格库 |
| 查生态新增特效/转场（boil/套印漂移/brush wipe/HANDOFF 表…） | `references/fx-tx-addendum.md` |
| 制片管线（换歌/本地化/验证闭环/agent 编排/风格 prompt 词汇表） | `references/pipeline-playbook.md` |
| 参考研究、混合媒介PV、连续帧迭代与歌词语义配方 | [PV制作流程](references/pv-production.md) |
| 落到 VideoGraph 平台 | `references/platform-videograph.md` |
| 深挖范例的逐行实现 | `../pdoom-video/app/src/scenes/`（docs/TREATMENT.md 是风格圣经）；语料清单与许可见 [SOURCES.md](SOURCES.md) |

## 生态语料（Opus 5.5 视频仓库，2026-09 蒸馏）

上游语料是 25 个开源 Opus 5.5 视频/基建仓库（水彩 p5.brush 系、
three.js 换歌系、risograph/GPU 笔刷/18 媒介引擎等独立风格系、videowright 等 agent 制片框架；
清单与许可逐条见 [SOURCES.md](SOURCES.md)）。
蒸馏产出：媒介模拟风格库（media-styles.md，核心宪法 "Simulate the process, not the look" +
材料沉积/形变/光学三条实现路径判据）、特效转场增补（fx-tx-addendum.md）、制片 playbook
（pipeline-playbook.md：换歌六层、双语卡拉OK、验证闭环、wave 编排、风格 prompt 词汇表+五段式
模板）。原 three.js 引擎手法见 effects/transitions/shots 三篇，不重复。

## 词汇速览（10 个核心概念）

1. **plate / 镜头卡**：一支片 = 十几个镜头板，每板一个视觉世界（介质/材质不同），共享调色板、
   字体系统、颗粒。
2. **handshake（板间握手）**：转场的真正内容——上一板最后一帧构造出下一板第一帧
   （出口产物=入口产物：轮廓/缝/纬线/光标/中线/火花落点）。
3. **刻线版画**：明暗即线密度。光照照度 → 排线覆盖率，墨不发光。
4. **出生钟粒子**：粒子出生在恒定时钟上，变速率=按 hash 抽稀，发射率写成出生时刻的函数。
5. **卡拉OK状态机**：预览描边 → 热填 → 冷却；时间唯一来源是 `wordProgress`。
6. **odometer 滚数**：连续值→逐位鼓轮（detent+进位+速度模糊）。
7. **beat 阶跃弹簧**：离散拍事件→连续运动：每段 key 差值乘 springStep；低频副本=松动物件的滞后。
8. **弧长参数化**：路径均匀重采样后，一切"生长/燃烧/经过/书写"都是标量前沿 vs 弧长。
9. **whip multi-tap**：快门内取两个相机位姿，shader/多次绘制之间插值采样=运动模糊。
10. **倒带循环**：预渲染静帧加速倒放 + 场景实例倒放刹车停在第一帧 = 无缝循环。

## 特效能力分级（选择手法前先看平台能跑什么）

- **L0 纯 Canvas2D**：卡拉OK、火花/粒子、仪表、字体猛击、排版压强、印章墨水、撕纸、
  手绘排线版画——任何平台可用。
- **L1 单 pass GLSL**：hatch/engrave/heat、fwidth 恒宽线、透镜方程、Droste、全屏逆布局
  （十万格）、bloom 金字塔后期——需要 shader 的平台。
- **L2 三维/raymarch**：G-buffer 刻线、实体光照、无限晶格、线框房间软件投影——需要
  three.js/3D 管线的平台。

VideoGraph 当前管线的精确能力边界、契约与工作流见
`references/platform-videograph.md`；把 L1/L2 手法降到 L0 的等价写法也在那里。

## 验证闭环（做完必须验，不能只看代码）

- **通用**：抽 5 帧（进度 0 / 0.25 / 0.45 / 0.75 / 末帧）静帧检查 + 类型检查/编译 +
  挑最运动的一段出短片段看动态。**静帧必须真的"看"**（渲染成图后逐张读），不能只看无报错。
- **全引擎管线**：`project_validate`（后台编译+5 帧抽检）通过 ≠ 审美通过。写镜头前读
  `song_cue_sheet`（小节节奏表）；改完用 `project_filmstrip`（`around` 关键下拍）看起势与衰减、
  `project_rhythm_report` 量下拍命中/偏移/死区/闪烁、`project_contact_sheet` 看全片强弱与一致性；
  转场用 `project_transition_validate` 抽帧。参考好作品的基准：画面峰约 94% 落在拍/鼓点/词起点上，下拍命中约 38%。
- **pdoom-video repo 本体**：`cd app && bun scripts/render.ts stills --t … --only <板>`
  （PNG 必须用 Read 看）、`sheet` 联络表、`video --from --to` 短片段。
