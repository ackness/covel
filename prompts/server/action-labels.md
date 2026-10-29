<!--
How the kernel writes a player's actions for the model when a submission is
more than one player's plain message (several characters, a host, a plugin
kind). One `key: value` line per entry. `{{actor}}` is the character's name,
`{{label}}` the kind's label and `{{text}}` what the player wrote.
-->

with-actor: [{{actor}} · {{label}}] {{text}}
without-actor: [{{label}}] {{text}}
say: says
act: acts
narrate: narration
direct: direction
advance: advance
command: command
