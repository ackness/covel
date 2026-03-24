# 05. 客户端宿主与多端架构

## 1. 客户端原则

客户端不应只是一个页面集合。

它应该是一个可扩展 host runtime，负责：

- 呈现 session 体验
- 承载 package 的 client contributions
- 管理本地交互状态
- 与 server runtime 协同

## 2. Host-agnostic Client Core

建议先定义共享客户端核心，再定义宿主壳。

共享客户端核心负责：

- navigation
- session UI
- action registry
- renderer registry
- local interaction state
- event consumption

## 3. Shell Bridge

多端差异统一通过 Shell Bridge 处理。

Shell Bridge 负责：

- local file
- notifications
- media playback
- secure storage
- deep links
- share sheet
- background execution hooks

这样业务逻辑不会直接绑定 Web 或 Electron API。

## 4. 三类宿主

### 4.1 Web Host

适合：

- 主开发端
- PWA
- hosted platform

### 4.2 Desktop Host

建议早期使用 Electron。

优势：

- 快速打包
- 本地文件能力
- 自动更新
- 更强本地缓存

### 4.3 Mobile Host

建议后续采用共享 Web Core + Mobile Shell 的路线。

重点：

- 业务逻辑复用
- shell bridge 独立

## 5. Client Contribution Registry

前端必须有统一的 contribution registry。

建议至少包括：

- action registry
- panel registry
- renderer registry
- form registry
- route registry
- artifact viewer registry

这使 package 可以向客户端注入能力，而不必改核心页面。

## 6. Presentation 模型

客户端表现层建议围绕这些对象设计：

- session timeline
- block stream
- artifact surface
- contextual panels
- command palette
- inspectors

而不是把所有新能力都塞进一个大页面。

## 7. 本地状态与服务端状态

客户端需要清楚区分两类状态。

### 7.1 Server-backed State

例如：

- session data
- artifacts
- jobs
- entities

### 7.2 Local Interaction State

例如：

- 当前面板是否展开
- 当前播放位置
- 当前筛选器
- 表单草稿

不要混淆这两类状态。

## 8. Artifact 体验

客户端必须是 artifact-native 的。

这意味着对图片、音频、视频、导出文件，不是“下载链接”级别支持，而是标准可交付对象。

客户端应统一支持：

- artifact card
- loading / progress
- preview
- version switch
- share / download

## 9. Offline 与 Sync

多端以后必须从架构上区分：

- local cache
- remote sync

local cache 是客户端体验层的一部分。
remote sync 是平台层的一部分。

两者不能混为一谈。

## 10. 设计结果

当客户端被设计成 host runtime 而不是单纯前端页面后：

- Web、Electron、移动端都能共用大部分业务逻辑
- package 可以标准化注入前端能力
- 多模态 artifact 和复杂交互也更容易承载
