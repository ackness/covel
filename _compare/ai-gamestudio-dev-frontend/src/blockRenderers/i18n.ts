import { useUiStore } from '../stores/uiStore'

type Lang = 'zh' | 'en'

const texts = {
  // ItemUpdateRenderer
  'action.gain': { zh: '获得', en: 'Gained' },
  'action.lose': { zh: '失去', en: 'Lost' },
  'action.use': { zh: '使用', en: 'Used' },
  'action.equip': { zh: '装备', en: 'Equipped' },
  'action.unequip': { zh: '卸下', en: 'Unequipped' },
  'itemType.weapon': { zh: '武器', en: 'Weapon' },
  'itemType.armor': { zh: '护甲', en: 'Armor' },
  'itemType.consumable': { zh: '消耗品', en: 'Consumable' },
  'itemType.quest': { zh: '任务物品', en: 'Quest Item' },
  'itemType.misc': { zh: '杂物', en: 'Misc' },
  'itemType.currency': { zh: '货币', en: 'Currency' },
  'itemType.material': { zh: '材料', en: 'Material' },
  'itemType.key': { zh: '钥匙', en: 'Key' },

  // CombatRenderer
  'combat.start': { zh: '战斗开始', en: 'Combat Start' },
  'combat.end': { zh: '战斗结束', en: 'Combat End' },
  'combat.hp': { zh: 'HP', en: 'HP' },
  'combat.initiative': { zh: '先攻', en: 'Init' },
  'combat.hit': { zh: '命中', en: 'Hit' },
  'combat.miss': { zh: '未命中', en: 'Miss' },
  'combat.defend': { zh: '防御', en: 'Defend' },
  'combat.flee': { zh: '逃跑', en: 'Flee' },
  'combat.attackRoll': { zh: '攻击骰', en: 'Attack' },
  'combat.damage': { zh: '伤害', en: 'Damage' },
  'combat.survivors': { zh: '存活', en: 'Survivors' },
  'combat.loot': { zh: '获得', en: 'Loot' },
  'outcome.victory': { zh: '胜利', en: 'Victory' },
  'outcome.defeat': { zh: '失败', en: 'Defeat' },
  'outcome.flee': { zh: '逃跑', en: 'Fled' },
  'outcome.truce': { zh: '休战', en: 'Truce' },

  // SkillCheckResultRenderer
  'skill.check': { zh: '检定', en: 'Check' },
  'skill.skillCheck': { zh: '技能检定', en: 'Skill Check' },
  'skill.modifier': { zh: '修正', en: 'Mod' },
  'skill.attribute': { zh: '属性', en: 'Attr' },
  'skill.total': { zh: '总计', en: 'Total' },
  'skill.criticalSuccess': { zh: '大成功', en: 'Critical Success' },
  'skill.success': { zh: '成功', en: 'Success' },
  'skill.failure': { zh: '失败', en: 'Failure' },
  'skill.criticalFailure': { zh: '大失败', en: 'Critical Failure' },

  // QuestRenderer
  'quest.active': { zh: '进行中', en: 'Active' },
  'quest.completed': { zh: '已完成', en: 'Completed' },
  'quest.failed': { zh: '已失败', en: 'Failed' },
  'quest.objectives': { zh: '目标', en: 'Objectives' },
  'quest.rewards': { zh: '奖励', en: 'Rewards' },

  // LootRenderer
  'rarity.common': { zh: '普通', en: 'Common' },
  'rarity.uncommon': { zh: '优秀', en: 'Uncommon' },
  'rarity.rare': { zh: '稀有', en: 'Rare' },
  'rarity.epic': { zh: '史诗', en: 'Epic' },
  'rarity.legendary': { zh: '传说', en: 'Legendary' },
  'loot.gold': { zh: '金币', en: 'Gold' },

  // StatusEffectRenderer
  'effect.apply': { zh: '施加', en: 'Applied' },
  'effect.remove': { zh: '移除', en: 'Removed' },
  'effect.tick': { zh: '触发', en: 'Tick' },
  'effect.rounds': { zh: '回合', en: 'rounds' },
  'effect.dmgPerTurn': { zh: '每回合 {0} 伤害', en: '{0} dmg/turn' },
  'effect.healPerTurn': { zh: '每回合 {0} 治疗', en: '{0} heal/turn' },

  // RelationshipRenderer
  'rel.friend': { zh: '友人', en: 'Friend' },
  'rel.rival': { zh: '对手', en: 'Rival' },
  'rel.romantic': { zh: '恋人', en: 'Romantic' },
  'rel.mentor': { zh: '导师', en: 'Mentor' },
  'rel.enemy': { zh: '敌人', en: 'Enemy' },

  // ReputationRenderer — no extra labels needed beyond faction/rank from data

  // CodexRenderer
  'codex.newDiscovery': { zh: '新发现!', en: 'New Discovery!' },
  'codex.updated': { zh: '已更新', en: 'Updated' },
  'codex.expand': { zh: '展开', en: 'Expand' },
  'codex.collapse': { zh: '收起', en: 'Collapse' },
  'codex.viewInPanel': { zh: '已收录到图鉴，前往图鉴面板查看详情。', en: 'Saved to Codex. Open the Codex panel for details.' },
  'codex.monster': { zh: '怪物', en: 'Monster' },
  'codex.item': { zh: '物品', en: 'Item' },
  'codex.location': { zh: '地点', en: 'Location' },
  'codex.lore': { zh: '传说', en: 'Lore' },
  'codex.character': { zh: '角色', en: 'Character' },
} as const satisfies Record<string, Record<Lang, string>>

type TextKey = keyof typeof texts

/** Returns a `t()` function bound to the current UI language. */
export function useBlockI18n() {
  const language = useUiStore((s) => s.language) as Lang
  const lang: Lang = language === 'zh' ? 'zh' : 'en'

  function t(key: TextKey, ...args: (string | number)[]): string {
    const entry = texts[key]
    let result: string = entry?.[lang] ?? entry?.en ?? key
    for (let i = 0; i < args.length; i++) {
      result = result.replace(`{${i}}`, String(args[i]))
    }
    return result
  }

  return { t, lang }
}
