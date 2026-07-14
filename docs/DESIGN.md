---
name: "归简"
description: "紧凑、精确、可信的 Windows 重复文件清理工具"
colors:
  canvas: "#F3F6FA"
  surface: "#FFFFFF"
  surface-subtle: "#F7F9FC"
  text: "#172033"
  text-secondary: "#5E6B7D"
  line: "#D8DEE8"
  line-strong: "#B8C4D3"
  accent: "#356FA5"
  accent-hover: "#295D8D"
  accent-muted: "#E8F0F8"
  danger: "#A4262C"
  danger-muted: "#FCE8E9"
typography:
  headline:
    fontFamily: "Segoe UI Variable Display, Microsoft YaHei UI, sans-serif"
    fontSize: "22px"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Segoe UI Variable Text, Microsoft YaHei UI, sans-serif"
    fontSize: "15px"
    fontWeight: 650
    lineHeight: 1.4
  body:
    fontFamily: "Segoe UI Variable Text, Microsoft YaHei UI, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Segoe UI Variable Text, Microsoft YaHei UI, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.35
  meta:
    fontFamily: "Segoe UI Variable Text, Microsoft YaHei UI, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  none: "0px"
  sm: "3px"
  md: "6px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: "34px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "34px"
  list-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "10px 12px"
    height: "56px"
---

# Design System: 归简

## Overview

**Creative North Star: “精密工作台”**

界面像一件安静、可靠的 Windows 工具：打开后立即进入任务，不展示品牌宣言，也不使用装饰制造存在感。默认密度紧凑，关键信息通过稳定的列对齐、字号差和一像素分隔线建立层级。

视觉系统明确拒绝网页管理后台式卡片堆叠、左右双滚动工作台和“大即高级”的比例。用户最先看到当前重复组及系统已经做出的保留/回收建议；统计数据退到工具栏，安全信息只在决策相关的位置出现。

**Key Characteristics:**

- 冷白与雾银底色，钢蓝只用于主操作、当前选择和键盘焦点。
- 平面、紧凑、列式对齐；容器少于内容区，分隔线多于边框盒子。
- Windows 原生字体与熟悉控件语义，不自定义滚动条外观。
- 状态同时使用文字、图标和位置，不只依赖颜色。
- Windows 原生标题栏承担唯一常驻品牌识别；审阅页不重复应用名，也不设置占据内容空间的大号页面标题。

## Colors

色彩保持低饱和冷色系；大部分屏幕由中性层级构成，强调色在单屏内只占很小比例。

### Primary

- **工作钢蓝** (`#356FA5`)：主按钮、当前重复组、已选状态和焦点；不用于大面积背景。
- **深钢蓝** (`#295D8D`)：悬停和按下状态。
- **薄雾蓝** (`#E8F0F8`)：当前行或轻量选择背景，不承载正文。

### Neutral

- **雾银画布** (`#F3F6FA`)：应用工作区背景。
- **冷白表面** (`#FFFFFF`)：列表、工具栏与底部操作区。
- **次级冷白** (`#F7F9FC`)：表头、只读摘要和细微分区。
- **墨蓝正文** (`#172033`)：主要文本。
- **蓝灰次文** (`#5E6B7D`)：时间、容量、路径辅助信息。
- **冷灰分隔** (`#D8DEE8`)：普通一像素分隔线。
- **冷灰强线** (`#B8C4D3`)：可交互边界和键盘焦点辅助。

### Named Rules

**稀缺强调规则。** 钢蓝只表达“现在要操作什么”或“当前选中了什么”；不要把它用于装饰标题、图标底板或大面积统计块。

**风险后置规则。** 危险红 (`#A4262C`) 只在最终确认与真实错误中出现。审阅阶段的“回收”是可撤销选择，不使用暖黄或整行红底渲染风险。

## Typography

**Display Font:** Segoe UI Variable Display（回退 Microsoft YaHei UI）

**Body Font:** Segoe UI Variable Text（回退 Microsoft YaHei UI）
**Label/Mono Font:** 路径默认仍使用 Segoe UI；仅调试数据使用 Cascadia Mono。

**Character:** 单一 Windows 系统字体族提供熟悉感，通过字重和固定尺寸构成克制层级，不引入展示字体或超大标题。

### Hierarchy

- **Headline** (650, 22px, 28px)：每个阶段唯一的页面标题。
- **Title** (650, 15px, 21px)：重复组文件名和主要区域标题。
- **Body** (400, 13px, 20px)：路径、按钮附近的主要说明和列表内容。
- **Label** (600, 12px, 16px)：按钮、表头、状态标签。
- **Meta** (400, 11px, 15px)：时间、大小、计数等辅助信息。

### Named Rules

**紧凑比例规则。** 标题和正文的级差不超过约 1.2；除结果容量外不使用 24px 以上的数据字号。

## Elevation

系统在静止状态不使用阴影。深度完全依靠画布、表面与次级表面的色阶，以及一像素分隔线表达。弹出菜单或系统对话框可使用平台默认阴影，不在页面内容中模拟悬浮卡片。

### Named Rules

**平面默认规则。** 内容不通过阴影“浮起”；交互反馈使用背景色、描边或焦点环。

## Components

### Buttons

- **Shape:** 3px 小圆角，高度 34px；紧凑但保留清晰点击目标。
- **Primary:** 工作钢蓝背景、冷白文字、水平内边距 14px；每个屏幕通常只出现一个。
- **Hover / Focus:** 悬停转深钢蓝；焦点使用 2px 外描边，状态变化 120–180ms。
- **Secondary / Ghost:** 冷白背景与 1px 强分隔线；文字操作可无边框，但必须保留明确悬停底色。

### Cards / Containers

- **Corner Style:** 内容区域默认 0px；只有文件夹选择框、确认框等完整控件可使用 6px。
- **Background:** 冷白表面或次级冷白。
- **Shadow Strategy:** 无阴影。
- **Border:** 优先使用上下分隔线；避免把每个摘要、列表和标题各自装进边框盒子。
- **Internal Padding:** 列表 10–12px，工具栏 12–16px，不使用 32px 以上的常规内边距。

### Inputs / Fields

- **Style:** 1px 冷灰强线、冷白背景、3px 圆角、32–34px 高度。
- **Focus:** 钢蓝边界加 2px 外焦点环。
- **Error / Disabled:** 错误同时显示图标与文字；禁用降低对比但保持标签可读。

### Navigation

四阶段导航使用窄顶部栏和文字步骤。当前阶段使用钢蓝文字与短下划线；已完成步骤可返回，未完成步骤保持只读。步骤本身不使用圆形数字徽章串联成装饰性时间线。

### Duplicate Review List

重复组采用单一垂直滚动容器。组标题行承担文件名、份数、每份大小和可释放容量；展开后在原位置显示文件路径和保留/回收选择。只允许页面主体这一处滚动，底部操作栏固定，不出现外层与内层相邻滚动条。

## Do's and Don'ts

### Do:

- **Do** 在 900×620 下优先保留页面标题、重复组列表、当前选择摘要和底部主操作。
- **Do** 使用 1px `#D8DEE8` 分隔、固定列宽与数字等宽特性建立秩序。
- **Do** 默认选中最短完整路径作为保留项，并直接展示其他副本已被建议回收。
- **Do** 正确跟随 Windows 缩放；到 200% 时重排或减少辅助列，不整体锁死固定尺寸。
- **Do** 使用标准滚动行为和系统滚动条，不绘制悬空轨道或双层滚动区域。

### Don't:

- **Don't** 做网页管理后台式的卡片仪表盘，也不要重复展示同一组统计、说明或安全提示。
- **Don't** 使用大量圆角容器、阴影、渐变、玻璃效果、暖黄色装饰或无任务价值的动效。
- **Don't** 使用左右两套相互竞争的滚动区域，或自定义细窄滚动条外观。
- **Don't** 把控件、标题和留白整体放大来伪装高级感。
- **Don't** 让回收状态只依赖底色；必须配合明确文字和图标。
- **Don't** 因文件名相似而暗示文件重复；“内容相同”是唯一重复依据。
