import type { PluginRegistrar, RuntimeHandlerContext, RuntimeHandlerResult } from "@covel/plugin-runtime";
import type { RuntimeContextView } from "@covel/shared";

export default function register(registrar: PluginRegistrar) {
  registrar.addRuntimeHandler("char-tracker", charTrackerHandler);
}

/**
 * Analyze the narrative from the current turn and extract character mentions.
 *
 * Uses simple heuristics:
 * - Chinese: quoted names 「」, or patterns like X说/X道/X笑
 * - English: capitalized proper nouns
 *
 * Emits record.upsert for each new character and a state.patch with the full character list.
 */
async function charTrackerHandler(
  ctx: RuntimeHandlerContext
): Promise<RuntimeHandlerResult> {
  const context = ctx.context as RuntimeContextView;
  const narrative = context.narrative?.content ?? "";
  if (!narrative) return { proposals: [] };

  const isZh = ctx.locale.startsWith("zh");

  // Get existing characters from state
  const existingChars = (context.state as Record<string, unknown>)?.characters as
    | Record<string, CharRecord>
    | undefined;
  const known = new Set(Object.keys(existingChars ?? {}));

  // Extract character names from narrative
  const extracted = isZh
    ? extractChineseNames(narrative)
    : extractEnglishNames(narrative);

  // Filter to new characters only
  const newChars = extracted.filter((name) => !known.has(name));
  if (newChars.length === 0) return { proposals: [] };

  const proposals: Array<{ kind: string; payload: unknown }> = [];
  const turnId = context.run.turnId;

  // Build updated character map
  const updatedChars: Record<string, CharRecord> = { ...(existingChars ?? {}) };

  for (const name of newChars) {
    const role = inferRole(name, narrative, isZh);
    const record: CharRecord = {
      name,
      role,
      description: inferDescription(name, narrative, isZh),
      firstSeenTurn: turnId,
    };

    updatedChars[name] = record;

    // Emit record.upsert for each new character
    proposals.push({
      kind: "record.upsert",
      payload: {
        key: `character:${name}`,
        value: record,
      },
    });
  }

  // Emit state.patch with full character list
  proposals.push({
    kind: "state.patch",
    payload: {
      characters: updatedChars,
    },
  });

  return { proposals };
}

interface CharRecord {
  name: string;
  role: "protagonist" | "npc" | "unknown";
  description: string;
  firstSeenTurn: string;
}

/**
 * Extract Chinese character names from narrative text.
 * Matches patterns like: X说, X道, X问, X笑, 「X」, "X" in dialogue attribution.
 */
function extractChineseNames(text: string): string[] {
  const names = new Set<string>();

  // Pattern: 2-4 char name followed by speech/action verb
  const speechPattern = /([^\s，。！？、：""''（）\n]{2,4})(说|道|问|答|笑|叹|喊|叫|低声|冷声|沉声|点头|摇头|看向)/g;
  let match;
  while ((match = speechPattern.exec(text)) !== null) {
    const name = match[1];
    // Filter common non-name patterns
    if (!isCommonPhrase(name)) {
      names.add(name);
    }
  }

  // Pattern: quoted name in 「」or ""
  const quotedPattern = /[「"]([\u4e00-\u9fff]{2,4})[」"]/g;
  // This catches names in quotes but may have false positives, skip for now

  return Array.from(names);
}

/**
 * Extract English character names from narrative text.
 * Matches capitalized words that appear with speech verbs.
 */
function extractEnglishNames(text: string): string[] {
  const names = new Set<string>();

  // Pattern: Capitalized name + speech verb
  const speechPattern = /([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+(said|asked|replied|whispered|shouted|laughed|nodded|shook|looked|turned|smiled)/g;
  let match;
  while ((match = speechPattern.exec(text)) !== null) {
    names.add(match[1]);
  }

  return Array.from(names);
}

function inferRole(
  name: string,
  narrative: string,
  isZh: boolean
): "protagonist" | "npc" | "unknown" {
  // Check if the player character name appears in "你" patterns (Chinese)
  if (isZh && narrative.includes("你")) {
    // Player is addressed as "你", named characters are NPCs
    return "npc";
  }
  if (!isZh && /\byou\b/i.test(narrative)) {
    return "npc";
  }
  return "unknown";
}

function inferDescription(name: string, narrative: string, isZh: boolean): string {
  // Try to find a sentence mentioning the character
  const sentences = narrative.split(/[。.!！？?]/);
  for (const sentence of sentences) {
    if (sentence.includes(name) && sentence.length > 10 && sentence.length < 100) {
      return sentence.trim();
    }
  }
  return isZh ? `在叙事中出现的角色` : `A character mentioned in the narrative`;
}

function isCommonPhrase(text: string): boolean {
  const common = [
    "但是", "因为", "然后", "所以", "如果", "虽然", "已经", "可以", "应该",
    "不过", "只是", "这里", "那里", "他们", "她们", "我们", "你们",
    "这个", "那个", "什么", "怎么", "为什么", "一个", "一些",
  ];
  return common.includes(text);
}
