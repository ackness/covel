import crossSpawn from "cross-spawn";

/**
 * Cross-platform spawn for dev scripts.
 *
 * Delegates to cross-spawn: on Windows it resolves `.cmd`/`.bat` shims
 * (pnpm, turbo, …) and applies correct cmd.exe quoting/escaping (trailing
 * backslashes, embedded quotes, %VAR% and other metacharacters) — edge
 * cases a hand-rolled shim gets wrong. On POSIX it is a plain spawn.
 */
export function spawnCommand(command, args = [], options = {}) {
  return crossSpawn(command, args, options);
}
