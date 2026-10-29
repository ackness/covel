<!--
内核在一次提交不只是单个玩家的普通发言时（多个角色、主持人、插件类型），
按这里的格式把玩家的行动写成给模型看的文字。每行一个 `key: value`。
`{{actor}}` 是角色名，`{{label}}` 是行动类型的名称，`{{text}}` 是玩家写的内容。
-->

with-actor: 【{{actor}}·{{label}}】{{text}}
without-actor: 【{{label}}】{{text}}
say: 说
act: 行动
narrate: 旁白
direct: 导演指示
advance: 推进
command: 命令
