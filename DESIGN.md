---
version: alpha
name: "云梯"
description: "面向中文学习者的 AI 互动课堂，以云梯蓝色品牌资产统一产品识别。"
colors:
  primary: "#722ED1"
typography:
  sans:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
  mono:
    fontFamily: "Geist Mono, ui-monospace, monospace"
rounded:
  DEFAULT: "0.625rem"
  sm: "0.375rem"
  md: "0.5rem"
  lg: "0.625rem"
spacing:
  logo-header-height: "1.5rem"
  logo-hero-height: "4rem"
components:
  brand-logo:
    height: "4rem"
  brand-mark:
    height: "2.5rem"
---

# 云梯 Design System

## Overview

云梯是一个高密度、多工作流的 AI 互动课堂产品。界面属于产品型而非营销型：导航、设置、编辑和课堂操作继续沿用现有熟悉模式，品牌表达集中在 Logo、标题和浏览器图标。

Creative North Star 是“当代中文教育工具上的 Swiss 标识系统”：蓝底白字横版 Logo 是唯一醒目的品牌动作，其余产品界面保持克制。反例是在各个页面重复造新的英文品牌字样、并行 Logo 或无关蓝色渐变。

Runtime token ownership 采用 Model B：[app/globals.css](./app/globals.css) 仍是界面色彩、圆角和字体的运行时真源；本文件镜像已接受的值并记录品牌资产路径。[lib/brand.ts](./lib/brand.ts) 是品牌名称、Logo、小图标和官网域名的唯一运行时入口。

## Colors

用户提供的蓝底白字 Logo 使用 `#45AEF4`，但这是图片内的品牌色，不替代现有的操作主色。现有浅色与深色主色继续由 `--primary` 控制，避免一次品牌替换意外改变按钮、焦点和状态语义。

## Typography

产品文本沿用 Inter Variable 与系统无衬线字体回退。品牌名称的标准文本是“云梯”，不再使用英文词标或混合后缀。图片替代文本同样使用“云梯”。

## Layout

横版 Logo 使用固定高度和自然宽高比：首页最高 `4rem`，导航与编辑器栏高 `1.5rem`。小图标仅用于方形或接近方形的容器，不拉伸。

公开课程链接采用独立的沉浸式观看画布：占满 `100dvh`，以黑色安全区承接 16:9 课件，不显示产品导航、账户信息、编辑工具、聊天面板或课程元数据。手机端以轻触启动播放、左右滑动切换场景；首次轻触提示是浏览器有声播放限制所需的唯一临时控件，播放后消失。

## Elevation & Depth

品牌资产不自带额外阴影或发光。其层级由所在的现有容器、边框和背景表达。

## Shapes

Logo 保留原始矩形边界与蓝色底色。小图标保留用户提供的圆形图形，外围容器沿用当前产品圆角。

## Components

- Brand logo: 只使用 `/yunti-logo.png`，用于首页、课堂侧栏和编辑器导航。
- Brand mark: 只使用 `/yunti-mark.png`，用于 PBL 顶栏和浏览器图标。
- Brand copy: 所有用户可见的产品名称为“云梯”；导出文档和页签标题也遵循同一规则。
- Account access: 登录与注册共用扁平边框面板、轻量网格背景和云梯横版 Logo；错误与确认状态在表单内就地呈现。
- Iconography: 功能图标沿用 Lucide，品牌小图标不得作为通用操作图标。
- Motion: 保留现有动效，品牌替换不新增装饰性动画。
- Public viewer: 分享链接只渲染课件内容与课程内部互动，账号和创作能力不进入该界面。
- Mobile interactive actions: 窄屏下将课件内的启动、暂停和重置原按钮收纳到贴合安全区的底部操作栏；沿用按钮原有视觉与事件，不复制或改写课程逻辑。
- Focused page type: 首页以紧凑的五项单选网格选择 3D 可视化、互动模拟、教学游戏、思维导图或测验；选中态沿用现有 `--primary`，不新增一套颜色或控件语法。

## Do's and Don'ts

- **Do:** 从 `lib/brand.ts` 读取品牌名称和资产路径。
- **Do:** 保持 Logo 原始宽高比与可读的替代文本。
- **Don't:** 在用户可见的页面或导出物中再次出现 OpenMAIC 词标。
- **Don't:** 把底层兼容识别符、存储键或 `@openmaic/*` 包名重命名为品牌文案。
