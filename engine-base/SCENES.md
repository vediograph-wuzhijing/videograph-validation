# 引擎与可复用场景基础件

0.2 新歌只复制清单校验后的 [runtime](runtime/) 和 [components](components/)，使用 [窗口模板](scenes/_window-template.ts) 创作；不复制原曲场景、插画、歌词或音乐。同级参考库仅用于操作者明确选择的原曲导入，现有工程的冻结引擎不会被自动升级。

| 基础件 | 能力 | 维护文件 |
|---|---|---|
| world | 相机位置/朝向/FOV、确定性漂移、投影、世界卡片 | [world.ts](components/world.ts) |
| environment | 参数化 sky/ocean/underwater 全屏底层 | [environment.ts](components/environment.ts) |
| text-motion | 逐字进退场组合、7种预设、字素分割 | [text-motion.ts](components/text-motion.ts) |
| layers | 独立渲染目标、每层效果、排序/透明度/合成 | [layers.ts](components/layers.ts) |

AI 先 scene_component_search，再 scene_component_get 读类型/使用例。新工程从 ../components 导入，旧工程可根据返回源码内联，不能改旧冻结引擎。相机/运动以歌曲绝对时间求值，不依赖前一帧状态；环境是参数化基础，不声称物理海洋模拟。独立图层保护文字不受背景折射影响。场景负责调用 dispose；图层拥有渲染目标，外部材质/纹理由创建者管理。

ly.get 字面量绑定由 TypeScript AST 检查，不能引用当前分析中不存在的歌词。草稿检查用于类型/初始化着色器，正式验证还负责渲染中创建的材料。模板不是成片或人工验收。

引擎MIT来源及资源许可见 [第三方手册](../docs/THIRD-PARTY.md) 和 [字体登记](FONTS.md)。
