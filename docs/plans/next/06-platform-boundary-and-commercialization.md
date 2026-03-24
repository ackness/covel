# 06. 平台边界与商业化设计

## 1. 基本原则

商业化能力必须从架构上被隔离为平台边界，而不是融入开源核心运行时。

核心原则：

- 开源核心负责内容、会话、扩展、编排
- 平台边界负责账号、计量、账单、同步、托管

## 2. Open Source Core

开源核心应包含：

- content system
- session system
- package runtime
- workflow runtime
- prompt graph
- artifact runtime
- BYOK provider support

## 3. Hosted Platform

托管平台可以增加：

- auth
- tenant
- usage ledger
- plans
- credits
- billing
- hosted providers
- cloud sync

## 3.1 平台对象

平台层建议显式包含这些对象：

- `Account`
- `Organization`
- `Membership`
- `Plan`
- `Subscription`
- `Entitlement`
- `UsageEvent`
- `BillingLedger`
- `Payment`
- `Invoice`
- `FeatureFlag`
- `AuditLog`

## 4. Usage Ledger

系统必须从一开始就有 usage ledger。

原因：

- 自部署用户也需要成本视图
- 托管平台需要按量计费
- 运维和分析需要 usage 数据

但 billing 只属于平台边界。

## 5. Provider Routing

建议系统支持三种 provider 模式：

- BYOK
- hosted
- hybrid

这样开源版和平台版可以共享一套核心架构。

## 5.1 Experience Shells

从平台视角，还应单独区分交付壳：

- Web
- Electron
- iOS
- Android

## 6. Plan 与 Credit 模型

托管平台建议围绕：

- free quota
- monthly plan
- usage pack
- team plan

构建。

但这些概念不应进入 package runtime 内部。

## 7. Workspace / Tenant 边界

平台化后必须有明确隔离：

- tenant
- workspace
- project
- user

不过开源模式可以默认退化为单租户。

## 8. Marketplace 与 Package 分发

如果未来有官方 package 市场，它应属于平台边界增强能力，而不是扩展平台本体的一部分。

扩展平台在开源版中也必须独立成立。

## 9. 设计结果

只要平台边界独立，后续商业化就能建立在同一套核心之上，而不会逼迫系统重构。
