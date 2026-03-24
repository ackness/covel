# 00. 系统地图

## 1. 一句话系统定义

covel 的下一代系统应被设计成：

一个以世界与会话为核心、以 package 为能力组织单位、以 flow engine 为中央编排层、以 artifact 为统一结果对象、以多宿主客户端承载交互、以平台边界承接托管能力的开放系统。

## 2. 系统总分层

在产品外形上，建议先固定成三层式平台：

- `Open Core Runtime`
- `Hosted Platform Layer`
- `Experience Shells`

其中：

- Open Core Runtime 负责开源、自部署、扩展与运行
- Hosted Platform Layer 负责账号、计量、套餐、同步、托管
- Experience Shells 负责 Web / Electron / Mobile 等交付外壳

在系统内部结构上，再继续细分为下面六层。

建议从上到下分成六层。

### 2.1 Experience Layer

用户直接感知的体验层：

- 世界构建
- 会话推进
- artifact 交付
- 多端交互

### 2.2 Flow Layer

系统中央编排层：

- turn flow
- workflow flow
- job flow
- automation flow

### 2.3 Runtime Layer

真正执行能力的层：

- command runtime
- capability runtime
- state runtime
- artifact runtime
- presentation runtime

### 2.4 Extension Platform Layer

组织可扩展能力的层：

- package runtime
- contract runtime
- extension points
- credential and permission model

### 2.5 Domain Layer

稳定业务对象层：

- world
- project
- session
- persona
- actor
- event
- artifact

### 2.6 Platform Boundary Layer

托管平台能力边界层：

- auth
- tenant
- usage ledger
- billing
- sync
- hosted providers

## 3. 核心对象

系统的核心对象建议固定为：

- `Workspace`
- `World`
- `Project`
- `Session`
- `Persona`
- `Actor`
- `Workflow`
- `Command`
- `Capability`
- `Artifact`
- `Package`
- `Entity`

如果换成更“系统公民”的表达方式，也可以把这套系统收敛为 8 个一等公民：

- `Entity`
- `Block`
- `Artifact`
- `Capability`
- `Extension`
- `Context Graph`
- `Job / Workflow`
- `Event`

## 4. 核心总线

系统运行时的协作建议统一通过 6 条总线：

- `Command Bus`
- `Event Bus`
- `Workflow Bus`
- `Capability Bus`
- `Artifact Bus`
- `State Bus`

同时，系统应正式定义 6 组统一协议：

- `Action Protocol`
- `Event Protocol`
- `Artifact Protocol`
- `Block Protocol`
- `Context Protocol`
- `Capability Protocol`

## 5. 扩展平台的最小能力

一个成熟的扩展平台至少要支持：

- package metadata
- shared contracts
- extension point registration
- permission declarations
- credentials
- client contributions
- backend contributions
- workflow contributions

## 6. 上下文系统的核心结论

上下文不应是一大坨对象，而应是：

- `Context Graph`

Prompt 只是 Context Graph 的一种投影：

- `Prompt Graph`

## 7. 结果对象的核心结论

系统输出不应只围绕文本。

应统一围绕：

- `Artifact`
- `Block`
- `State Patch`
- `Event`
- `Trace`

## 8. 客户端的核心结论

客户端不应被定义为一组页面。

它应被定义为：

- 一个可扩展 host runtime

## 9. 商业化的核心结论

商业化不应改变核心运行时。

它应通过平台边界接入：

- usage ledger 进入 core
- quota / credits / billing 留在 platform

## 10. 推荐阅读顺序

推荐顺序：

1. `00-system-map.md`
2. `01-system-vision-and-principles.md`
3. `02-domain-runtime-and-lifecycle.md`
4. `03-extension-platform-and-package-model.md`
5. `04-context-prompt-and-flow-engine.md`
6. `05-client-host-and-multidevice-architecture.md`
7. `06-platform-boundary-and-commercialization.md`
8. `07-governance-security-and-observability.md`
9. `08-delivery-roadmap.md`

## 11. 最终判断

这个系统应该是：

一个内容原生、artifact 原生、package 原生、flow 原生、host 无关、platform 可插拔的开放架构。
