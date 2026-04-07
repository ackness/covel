# 异步插画工作流公共规则

该插件用于验证一条标准的异步多 runtime workflow：

1. 前端通过插件声明的 action 渲染按钮。
2. 用户点击按钮后，框架创建异步 workflow run。
3. `prompt-optimizer` 先收集上下文并生成结构化图片提示词。
4. `image-generator` 再接收上一 runtime 的结构化输出作为显式输入。
5. 两个 runtime 都必须各自产生一条 published record。
6. 主界面只显示最终图片；详细 prompt、参数和中间状态进入 debug / trace。

所有 runtime 必须：

- 输出当前 locale 的自然语言字段
- 同时保留结构化字段供框架和前端使用
- 不直接读取或依赖底层 trace 原始数据
