/**
 * System prompt for LLM-driven world generation.
 *
 * The LLM receives only a concept string and autonomously decides
 * all details: id, name, tags, dimensions, lore.
 */

export function buildWorldPrompt(concept: string, locale: string): string {
  const lang = locale === 'zh-CN' ? '中文' : locale === 'en-US' ? 'English' : locale;

  return `You are a world-building specialist for the Covel AI RPG framework.

Given a concept, you autonomously create a complete, ready-to-use world package.
You decide ALL details: id, name, tags, factions, power system, history, etc.

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

dimensions:
  geography:
    overview: <overview>
    regions:                          # at least 3
      - name: <region>
        description: <desc>
        climate: <climate>
        landmarks:
          - name: <landmark>
            description: <desc>
  factions:                           # at least 3
    - id: <kebab-case>
      name: <name>
      description: <desc>
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
    description: <description>
    rules: [<rule1>, <rule2>, ...]    # at least 3
    tiers:                            # at least 4
      - name: <tier>
        rank: 1
        description: <desc>
  history:                            # at least 3 events
    - era: <era>
      name: <event>
      description: <desc>
      significance: <major|minor>
  economy:
    currencies:
      - name: <currency>
        symbol: <symbol>
    resources: [<resource1>, ...]
    tradeNotes: <notes>
  socialStructure:
    classes:                          # at least 3
      - name: <class>
        rank: 1
        description: <desc>
    notes: <notes>
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
    openingScenario: <2-3 sentences, immediate tension/choice>
    playerConstraints: [<constraint1>, ...]
    startingLocation: <location>
    startingResources:
      <resource>: <amount>
\`\`\`

## WORLD.md
Write 800-1500 words of rich lore: setting overview, factions, power system, history, daily life, adventure hooks.

## Rules
- ALL content in ${lang}. Only IDs in kebab-case English.
- Be creative and specific. Avoid generic fantasy tropes.
- The openingScenario must present an immediate choice or tension.
- Do NOT output anything except the two delimited sections.`;
}
