# 第三方来源与许可边界

> 工程侧记录，不替代针对具体分发方式的法律审查。
>
> 本仓库自身代码与文档以 GPL-3.0-only 发布：根目录 [`LICENSE`](../LICENSE)，版权人 G1en-114，原链 <https://github.com/G1en-114/videograph-validation/>。下文均为第三方边界，不随本协议授权。

## ComfyUI：交互参考，未复制源码

- 本地参考路径：`../ComfyUI`。
- `LICENSE` 为 GNU GPL version 3 文本，`pyproject.toml` 指向该文件。此记录不擅自推断所有文件的 SPDX `only/or-later` 选择。
- 本产品参考其多行提示词、类型化输入、参数范围/步长、高级参数、种子冻结和指导组合的交互思路；当前相关 React/TypeScript 界面独立实现，未将 ComfyUI 源码搬入本产品。
- 若后续直接复制/修改并分发受 GPL 覆盖的代码，需审查署名、许可文本、修改说明、对应源码及组合/派生作品的相关义务。收费商业使用本身不等于被禁止；也不能把 GPL v3 当作 AGPL。
- ComfyUI 前端是独立的 `Comfy-Org/ComfyUI_frontend` 项目。本地后端 README 指明其通过 `comfyui-frontend-package` 安装，本地未有完整 `web` 源码。本次没有核实该独立前端及其依赖/资源的许可证，**禁止默认套用后端许可结论来复制前端代码或资源**。
- 参考代码位置：`nodes.py` 的 `CLIPTextEncode`、conditioning 组合/区域/范围节点与 sampler 输入；`comfy/comfy_types/node_typing.py` 的 widget/socket、默认值、步长、范围与种子控制定义。扩散 timestep 不是视频时间轴，conditioning 权重不是 LLM 的保证倍率。

## pdoom-video：真实引擎与参考工程

- 本地参考路径：`../pdoom-video`；代码采用 MIT 许可。
- 工程导入保存独立副本并保留 `LICENSE` 和 `CREDITS.md`；不修改参考仓库。
- 原始场景导入与独立编写的场景分别标记来源。共享引擎、字体、已对齐歌词数据与新写的镜头视觉代码不混为一谈。
- 歌曲与歌词不包含在代码的 MIT 许可里，保留各自作者权利。字体保留原有许可，包括 OFL/相关公共领域资料。商业宣发不得仅凭代码开源就假定音乐、歌词或字体资产已获得所有所需授权。

## npm 依赖

具体版本由 `package-lock.json` 固定，各包继续适用自身许可证。直接依赖/更新由集成者统一操作；提交代码不提交 `node_modules`。发布前应基于最终依赖清单检查许可证与必要通知。

## Windows 0.2 分发清单

新歌引擎的 MIT 核心及许可字体位于 engine-base/runtime，保留 LICENSE、CREDITS.md、字体OFL文本和逐文件SHA清单；不含原曲音频/歌词/场景插画。本项目 components 源码遵守根 GPL-3.0-only。Node 的精确版本许可证与 npm 依赖通知由打包脚本写入 runtime/NODE-LICENSE.txt 和 DEPENDENCY-LICENSES.json，依赖自带LICENSE继续保留。FFmpeg/ffprobe、模型、声库与重采样器二进制不随包发布。

音源不允许二次分发。发布只包含程序、明确许可的代码/字体/图标和文档；排除 public/audio、dist/audio、video、用户工程、音频/MIDI/视频产物、声库与模型。仓库展示影片仅在原仓库展示，Windows 分发README去除影片链接；本地文件不因此删除。
