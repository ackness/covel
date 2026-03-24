# 07. 治理、安全与可观测性

## 1. 为什么这一层必须从第一天设计

扩展平台一旦成立：

- 权限问题
- 凭据问题
- source trust
- trace
- 生态治理

都会成为系统级问题，而不是后补功能。

## 2. 治理对象

建议治理层面重点关注：

- package source
- permissions
- credentials
- usage
- errors
- deprecation
- ecosystem trust

## 3. 信任等级

建议 package source 至少区分：

- local trusted
- verified official
- community reviewed
- untrusted external

不同等级应触发不同安装与运行策略。

## 4. 凭据与密钥

凭据不应由 package 自己管理。

应由系统统一管理：

- secret storage
- scope binding
- rotation
- auditing

## 5. 执行安全

建议按执行方式区分安全策略：

- prompt-only
- workflow-only
- hosted capability
- outbound http
- local script
- host bridge access

不同类型需要不同权限和审计强度。

## 6. 可观测性

系统至少应统一提供：

- trace
- metrics
- logs
- job history
- artifact lineage

尤其是 trace，必须贯穿：

- turn
- workflow
- command
- capability
- package contribution

## 7. 健康检查与回退

每个 runtime 都应支持：

- health status
- timeout
- retry policy
- cancellation
- graceful degradation

这对多模态能力和 hosted providers 尤其重要。

## 8. 生态治理

建议官方长期建立：

- package verification
- review policy
- signing
- compatibility window
- deprecation policy

如果没有这些机制，生态会很快碎片化。

## 9. 设计结果

治理、安全和可观测性不是附属要求，而是扩展平台成立的先决条件。
