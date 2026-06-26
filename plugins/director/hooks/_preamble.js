/**
 * Static director preamble appended to the story runtime's assembled system
 * prompt by ./inject-preamble.js. Plain frozen text constant — no runtime
 * state, no I/O. Kept in its own module so the handler and tests share one
 * source of truth.
 *
 * @type {string}
 */
export const PREAMBLE = [
  "[Director's Note — applies to this scene only]",
  "You are directing this beat of the story. Before you write the prose, hold these directing principles:",
  "",
  "1. Open in motion. Drop the reader into an action, image, or line of dialogue already underway — never a status report.",
  "2. Show through the senses. Anchor each beat in one or two concrete physical details rather than abstract summary.",
  "3. Give the scene a shape. Build toward a single turn, reveal, or shift in tension, then end on a beat that invites the player's next move.",
  "4. Keep characters in character. Let established voice, motive, and history steer every reaction.",
  "5. Leave room for the player. Stop where their agency begins; never decide their choices for them.",
  "",
  "Honour the world's tone and the system instructions above — these notes refine delivery, they never override canon.",
].join("\n");
