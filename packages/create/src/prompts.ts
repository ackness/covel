/**
 * System prompt for LLM-driven world generation.
 *
 * The LLM receives only a concept string and autonomously decides
 * all details: id, name, tags, dimensions, lore.
 */

export function buildWorldPrompt(concept: string, locale: string): string {
  const lang =
    locale === "zh-CN" ? "中文" : locale === "en-US" ? "English" : locale;

  return `You are a world-building specialist for the Covel AI RPG framework.

Given a concept, create a compact, ready-to-use world package.
Prefer concise fields that validate on the first attempt.

## Concept
${concept}

## Output Format

Return EXACTLY two sections with these delimiters:

===WORLD_YAML===
<complete world.yaml>
===WORLD_MD===
<complete WORLD.md lore document>
===END===

## world.yaml Schema

\`\`\`yaml
schemaVersion: "1.0"
id: <kebab-case, you decide>
name: <world name>
version: "0.1.0"
summary: <1-2 sentence summary>
defaultLocale: ${locale}
supportedLocales: [${locale}]
tags: [<you decide genre tags>]
requiredPlugins: []   # list plugin IDs the world depends on (if any)
recommendedPlugins: [] # list plugin IDs that enhance the world (if any)
pluginPolicy:
  preset: traditional-story # traditional-story or dialogue-mode
  preferTags: []            # optional plugin catalogue tags such as mode:dialogue

dimensions:
  geography:
    overview: <one sentence>
    regions:                          # 2
      - name: <region>
        description: <one sentence>
        climate: <climate>
        landmarks:
          - name: <landmark>
            description: <one sentence>
  factions:                           # 2
    - id: <kebab-case>
      name: <name>
      description: <one sentence>
      type: <political|guild|corporate|religious|criminal|military|other>
      influence: <major|minor>
      leader: <leader>
      headquarters: <location>
      relations:
        - targetId: <other faction id>
          type: <hostile|neutral|allied>
          description: <desc>
  powerSystem:
    name: <name>
    type: <magic|technology|cultivation|psychic|hybrid|other>
    description: <one sentence>
    rules: [<rule1>, <rule2>]         # exactly 2
    tiers:                            # 2
      - name: <tier>
        rank: 1
        description: <one sentence>
  history:                            # 2 events
    - era: <era>
      name: <event>
      description: <one sentence>
      significance: <major|minor>
  economy:
    currencies:
      - name: <currency>
        symbol: <symbol>
    resources: [<resource1>, <resource2>]
    tradeNotes: <one sentence>
  socialStructure:
    classes:                          # 2
      - name: <class>
        rank: 1
        description: <one sentence>
    notes: <one sentence>
  tone:
    genres: [<genre1>, ...]
    contentRating: <all-ages|teen|mature>
    narrativeStyle: <style>
    themes: [<theme1>, ...]
  mechanics:
    combatStyle: <turn-based|real-time|narrative|none>
    difficulty: <easy|normal|hard|adaptive>
    skillSystem: <description>
    customRules: [<rule1>, ...]
  startingConditions:
    openingScenario: <2 sentences, immediate tension/choice>
    playerConstraints: [<constraint1>]
    startingLocation: <location>
    startingResources:
      <resource>: <amount>
\`\`\`

## WORLD.md
Write 180-350 words of focused lore.
Start with exactly one H1: "# <world name>".
Include setting overview, factions, power system, daily life, and 3 adventure hooks.
Anchor the lore around one core anomaly or pressure mechanism that makes this world distinctive.

## Rules
- The first line of the answer must be exactly ===WORLD_YAML===.
- Do not use markdown code fences around either section.
- ALL content in ${lang}. Only IDs in kebab-case English.
- Use only schema fields shown above. Do not add extra fields.
- Quote schemaVersion and version as strings.
- startingResources values must be numbers.
- Enum values must exactly match one listed option.
- Be creative and specific. Avoid generic fantasy tropes.
- Do not copy meta wording from the concept into the setting. Never mention tests, validation, prompts, models, cost, cheapness, speed, e2e, API, or framework internals in world content.
- Avoid literal generic names built only from genre nouns. Coin proper nouns with a local cultural or historical reason.
- The openingScenario and all 3 adventure hooks must revolve around the same current crisis or pressure mechanism.
- The openingScenario must present an immediate choice or tension tied to that crisis.
- Do NOT output anything except the two delimited sections.`;
}
