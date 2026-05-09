# pregame

在模型驱动的游玩开始前，执行确定性的首轮准备。

## 运行时结构

- `PLUGIN.md`：定时函数 runtime 声明。
- `handler.js`：读取世界和会话数据，并返回初始化输出。

## 数据与行为

- 在 Pre-Game 阶段执行一次。
- 准备欢迎叙事和通知。
- 返回 `preGameDone: true`，让框架推进准备状态。

## 开发

修改 handler 或 manifest 触发时机后，运行 runtime pre-game completion 测试。
