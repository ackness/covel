/**
 * Preset seed worlds for out-of-the-box gameplay.
 */
import type { WorldDimensions } from "@covel/shared";
import {
  MISTPORT_DIMENSIONS,
  NEONRIDGE_DIMENSIONS,
  CLOUDMERE_DIMENSIONS,
  MISTPORT_EN_DIMENSIONS,
} from "./seed-world-dimensions.js";

export interface SeedWorld {
  name: string;
  description: string;
  /** Extended lore injected into system prompt as world context. */
  lore: string;
  locale: "zh-CN" | "en-US";
  tags: string[];
  /** Structured world-building dimensions. */
  dimensions?: WorldDimensions;
}

export const SEED_WORLDS: SeedWorld[] = [
  {
    name: "雾港・裂潮纪",
    description: "一座被永恒浓雾包裹的港口城市。潮汐带来远古遗物，也带来危险。",
    locale: "zh-CN",
    tags: ["港", "雾", "冒险"],
    dimensions: MISTPORT_DIMENSIONS,
    lore: `# 雾港・裂潮纪

## 世界设定
雾港是一座嵌在悬崖断面与海面之间的港口城市，像一枚钉入岩壁的铁楔。永恒的灰白浓雾笼罩一切，空气中永远弥漫着盐和铁锈的味道，能见度从不超过五十步。没有人见过雾港的天空——老人们说，上一次雾散是三代人以前的事了。

城市依崖壁垂直展开三层。最高处是**上城**，议会与商会盘踞在崖顶，石砌高墙将雾气隔在脚下，议事厅穹顶嵌着的远古潮石灯是全城唯一不靠火焰的光源。中层是**中港**，码头、工坊、旅店和赌档挤成一团，机械钟塔以潮汐为动力，每六小时敲响一次——这是雾港人唯一的计时方式。最下方是**下潮区**，涨潮时完全淹没于灰色海水之下，退潮时暴露出远古文明的遗迹。

没有人知道这些遗迹是谁建造的。唯一确定的是，每次退潮暴露出的遗迹地形完全不同——仿佛海底在不断重组自己。验潮师公会将这种现象称为"裂潮"，而他们至今无法解释它的成因。这些遗迹中散落着各种远古遗物：有的能在雾中照出百步，有的接触就会让手臂石化。遗物贸易是雾港经济的命脉，也是所有冲突的根源。

## 核心规则
- **裂潮法则**：每次潮退，下潮区暴露出完全不同的远古遗迹结构，永远不重复。没有地图可用——每次下潮都是盲探。退潮窗口通常持续4-6小时，涨潮速度极快且不可预测。
- **雾兽**：雾中栖息着被称为"雾兽"的未知生物。它们没有固定形态，被声音和光亮吸引。明火、大声说话、金属碰撞都可能引来雾兽。探险者使用特制的潮石雾灯（冷光，低声）代替火把。
- **遗物鉴定**：远古遗物效果不可预测且可能致命。未经验潮师鉴定擅自使用遗物是违法行为——但黑市上未鉴定遗物的价格是鉴定品的三倍。
- **封潮令**：议会颁布的法令，禁止无许可证的平民进入下潮区。违者处以监禁和没收财产。但法令执行困难——下潮区太大，雾太浓，议会巡逻队自己也经常迷路。
- **潮力**：少数人能感知到来自海底遗迹的神秘能量——"潮力"。退潮时最强，涨潮时几乎消失。过度使用潮力会导致"雾蚀"：身体逐渐变得半透明，最终溶入雾中。

## 势力格局
**雾港议会**由商会领袖和世家组成，控制上城和合法遗物贸易。议长陈远山正推动"封潮令"，表面上是保护平民安全，实际上是垄断遗物来源——议会自己的探险队不受封潮令限制。议会内部并非铁板一块：鸽派议员认为封锁只会助长黑市，鹰派则主张武力清剿盐牙会。

**验潮师公会**是唯一有资质鉴定远古遗物的学术组织，依赖议会资金运作，但保持着名义上的独立。公会长齐老是温和的学者，更关心研究而非政治。但公会内部的年轻验潮师们越来越不满——他们发现了一些遗迹中的秘密，而上层似乎在故意压制某些鉴定报告。

**盐牙会**控制着下潮区的非法遗物贸易，势力深植底层。二当家铁姑以铁腕手段维持秩序，但她对手下有一条不可动摇的规矩：不卖未鉴定的危险遗物给不知情的平民。她曾是验潮师学徒——这段过去是她最大的秘密。盐牙会与议会处于长期冷战：彼此互相渗透，偶尔爆发巷战，但谁也无法消灭对方。

**雾中教会**是近年崛起的神秘组织。他们崇拜"雾之主"——他们相信雾本身是一个有意识的存在，而远古遗迹是"雾之主的身体"。教会吸引了大量底层贫民，传播"雾蚀不是诅咒而是升华"的教义。议会视其为邪教，但其信众增长速度令人不安。

## 关键人物
- **林远舟**：验潮师公会新晋学徒，刚通过初试。性格谨慎但好奇心极强。他在初试考核中意外发现自己能微弱感知潮力——这个能力他不敢告诉任何人，因为公会官方立场是"潮力不存在，只是迷信"。
- **铁姑**：盐牙会二当家，三十余岁，左臂从肘部以下因遗物事故变成半透明的雾蚀状态。她为人冷厉但守信。铁姑掌控黑市不仅为钱——她在暗中搜集特定的遗物碎片，似乎在拼凑某个更大的谜题。
- **陈远山**：议会议长，年过六旬，精于权术。表面推行封潮令是为公共安全，但他的亲信探险队在下潮区的搜索频率远超正常。他到底在找什么？
- **齐老**：验潮师公会长，白发苍苍的温和学者。他是少数知道"裂潮"真相的人之一，但他选择了沉默。近期他的身体开始出现雾蚀征兆——但他从未公开使用过潮力。
- **小霜**：雾中教会最年轻的"雾使"，不过十五六岁。她声称能听到雾的"低语"，并数次准确预言了退潮时间和遗迹位置。是先知、疯子，还是骗子？

## 暗线与悬念
- 下潮区最深处从未被人类到达过。最近一次深退潮中，探险队带回一块遗物，上面刻着与雾港建城碑文完全相同的文字——但碳测定显示它比雾港古老一万年。
- 雾蚀患者的数量在过去一年翻了三倍，但官方拒绝承认。齐老的私人笔记中提到："雾在变浓。每十年浓一次。我们正处在某个周期的临界点。"
- 铁姑收集的遗物碎片似乎是某种"钥匙"的零件。它能打开什么？她不说。但议长陈远山也在找同样的东西。
- 三年前一支议会探险队深入下潮区后全队失踪。唯一的幸存者疯了，只会反复说一句话："它在下面醒了。"

## 开局情境
黄昏时分，你踏上中港主栈桥的湿滑木板。渡船的缆绳在浓雾中消失，仿佛你是从虚无中走来。空气咸腥沉重，远处传来钟塔沉闷的鸣响——不是常规的计时钟声，而是急促的三连击。码头上的老水手们停下手中的活计，面面相觑。

三连击意味着"深退潮预警"。这是极其罕见的事件——上一次深退潮还是六年前，那次暴露出了被称为"骨拱门"的巨大结构，也带走了十七条人命。

栈桥上迅速分成两股人流：盐牙会的人在暗处招募胆大的探险者，许诺丰厚报酬；议会巡逻队则在张贴紧急封潮令，警告任何未持许可证进入下潮区者将被逮捕。

一个穿着验潮师公会制服的年轻女人挤过人群，急匆匆地向你走来——你认出那是前几天入门考核时的监考官。她的脸色不太好。

"你是今天刚到的新学徒？"她没等你回答，就压低声音说："齐老失踪了。今天早上他留下一封信就走了，信上说他去了下潮区——可是现在是涨潮期，没有人能在涨潮期进入下潮区。"

她看了一眼钟塔的方向："但如果深退潮来了……"

钟塔第四次敲响。地面微微震颤。码头边的海水开始以肉眼可见的速度后退。`,
  },
  {
    name: "霓虹脊・2087",
    description: "赛博朋克城市，义体改造与企业战争是日常。你是街头的无名小卒。",
    locale: "zh-CN",
    tags: ["赛博", "义体", "霓虹"],
    dimensions: NEONRIDGE_DIMENSIONS,
    lore: `# 霓虹脊・2087

## 世界设定
霓虹脊是一座垂直建造的巨型城市，从地下废水处理层到海拔两千米的空中庭园，共计一百二十层。它不是长出来的——它是堆出来的。每当底层的基础设施老化腐烂，企业集团不是修缮，而是直接在上面加盖新层。六十年下来，最底下的二十层已经彻底失去日照，被称为"永夜层"。

义体改造是霓虹脊的日常。超过70%的居民至少拥有一处义体——义体眼、义体臂、神经加速器、记忆扩展芯片。顶层的人用义体追求完美，底层的人靠义体活命。问题在于：所有义体都需要充能和维护，而充能站和维护费用由三大企业集团垄断。一个底层工人月收入的40%要花在义体维护上——这不是医疗，这是租金。你的身体有一部分不属于你自己。

永夜层的空气闻起来像烧焦的塑料和机油。霓虹灯管是唯一的光源——红的、蓝的、紫的——它们照亮潮湿的金属墙壁，也照亮墙上密密麻麻的广告：充能站促销、义体分期、赤焰安保招募令。在这里，抬头看不到天空，只能看到上层建筑的底板，像一块永远压在头顶的铁幕。

## 核心规则
- **义体充能**：所有义体每72小时必须在授权充能站充能一次。逾期未充能会导致义体性能衰退，超过168小时将完全停摆。企业利用充能站系统追踪每个义体使用者的位置和状态。
- **金属热**：义体过载或使用未授权改装件会导致"金属热"——免疫系统对义体产生排异反应。轻症是高烧和义肢抽搐，重症会导致义体失控暴走，极端情况下义体会反噬宿主。底层充能站质量参差不齐，金属热在永夜层是常见死因。
- **信号屏蔽**：底层40层以下的区域被企业联合屏蔽了城市主网信号——官方说法是"基础设施不支持"，但所有人都知道这是为了防止底层组织化。通讯依赖物理线路和跑腿信使（俗称"线虫"）。
- **自由体**：完全没有义体改造的人，俗称"自由体"。全城不到2%的人口。底层人对自由体又敬又畏——他们不受充能系统控制，不怕金属热，但也无法胜任大多数需要义体的工作。企业视自由体为潜在的安全威胁，因为他们无法被追踪。
- **记忆篡改**：高端义体包括记忆芯片。企业安保有能力远程修改持有记忆芯片者的记忆——这是最高级别的秘密，官方否认其存在。但永夜层流传着无数"醒来后忘了昨天"的故事。

## 势力格局
**寰宇科技**掌控城市的基础设施——电力、供水、空气循环。它是三大企业中最"温和"的，但也意味着它的垄断最深入：切断一个区域的供电，就等于宣判那个区域的死刑。寰宇的CEO韩昭奉行"技术中立"，但他的中立只在三大企业之间——对底层，他漠不关心。

**赤焰安保**是私人武装力量，同时承包城市治安和企业间的"商业纠纷解决"。赤焰的重装巡逻队是底层人的噩梦——他们有权在"安全威胁评估"下先开枪后质询。赤焰指挥官孙铁的口头禅是"秩序比公正重要"。但赤焰内部也不是铁板一块——一些基层士兵来自底层，他们的忠诚正在被自己的经历侵蚀。

**幽蓝制药**表面上是医药和义体研发企业，实际控制着整个义体供应链。它生产义体，也生产治疗金属热的药物——先制造问题，再出售解决方案。幽蓝的研发部门是三大企业中最神秘的，坊间传闻他们在进行"全义体化"实验——将人的意识完全转移到机械身体中。幽蓝首席研究员"博士"从不以真名示人，据说她自己就是一个实验品。

**底层势力**并非一盘散沙。虹姐经营的**信号站**是底层最大的信息中枢，掌控物理线路通讯网络。她不属于任何企业，靠出售信息为生，对所有势力保持等距外交。黑市义体技师网络（俗称"焊工帮"）提供廉价但风险极高的义体改装服务。还有越来越多的"断线者"——主动拆除义体、回归自由体状态的激进分子，他们梦想着推翻义体经济体系。

## 关键人物
- **玩家（"线虫"）**：永夜层第七区的跑腿信使，靠一双义体腿在没有电梯的楼层间跑上跑下。你的义体腿是二手货，隔三差五需要阿灰帮忙修修补补。你不算底层最惨的人——至少虹姐的活能让你按时充能。你最大的优势是熟悉永夜层的每一条巷子、每一个通风管道、每一处赤焰巡逻队的盲区。
- **阿灰**：你的旧友，黑市义体技师中最好的一个。他脾气古怪但手艺精湛，能用三大企业报废的零件拼出比原装还好用的义体。三天前他告诉你他接了一个"改变命运的大活"，兴奋得像个孩子。然后他就失联了。阿灰不是会主动消失的人。
- **虹姐**：信号站老板，四十多岁，一只义体眼不停转动地扫描着信息流。她对所有人都很客气，也对所有人都有所保留。虹姐的规矩是"不问来源，只卖信息"，但她有一条底线：不帮企业做事。有传言说她曾经是寰宇科技的高级员工——但那只是传言。
- **孙铁**：赤焰安保第三区指挥官，冷酷高效。他对底层人没有同情心，但也没有恶意——在他眼里一切只是"任务"。最近他接到的命令越来越奇怪：封锁废弃充能站、搜查特定型号的义体芯片、逮捕几个从未听说过的人。他开始感到不安。
- **小七**：断线者组织的联络人，一个拆掉了所有义体的二十岁年轻人。他总是笑嘻嘻的，但眼神锐利得吓人。他找过你好几次，想拉你"入伙"。他说："你知道你的义体腿里有个追踪芯片吗？你跑得再快，也跑不出他们的手掌心。"

## 暗线与悬念
- 阿灰失联前接的"大活"来自一个匿名客户，内容是改装一种从未见过的义体芯片——不是记忆芯片，不是神经加速器，而是某种能干扰信号屏蔽的装置。如果这东西量产，底层将第一次接入城市主网。
- 幽蓝制药最近在永夜层的废弃区域秘密设立了一个实验室。多名无家可归者在附近失踪。赤焰安保被命令"不要调查"。
- 三大企业表面互相竞争，实际上通过一份秘密协议（"三柱协定"）瓜分了城市的控制权。但最近寰宇科技开始单方面违反协定——韩昭在下一盘什么棋？
- 永夜层最底部——所有人都以为是废水处理厂的地方——传出了奇怪的无线电信号。那个频率不属于任何已知的通讯协议。

## 开局情境
凌晨三点十七分，永夜层第七区。你被义体腿膝关节的酸痛惊醒——充能快到期了，明天得去充能站。铁皮隔板外传来远处赤焰巡逻队的靴声和探照灯的嗡鸣。

手腕上的通讯器震动。虹姐的加密文字消息：

"线虫。阿灰失联48小时。最后信号：第三区，废弃充能站GR-17。他手上有我要的东西——一批特殊芯片的数据备份。拿到数据，酬金够你充能三个月。去不去？"

你翻身坐起来。第三区现在是赤焰安保的强化巡逻区——三天前一批走私义体被截获后，孙铁把整个区封锁了。正常的线虫不会冒这个险。

但阿灰不只是生意伙伴。去年金属热发作时是他半夜三点从床上爬起来帮你修的义体腿。他不是会无缘无故失联的人。

你拉开隔板。巷子里的霓虹灯还在闪烁——红蓝交替的光映在潮湿的金属地板上，像一道道凝固的伤口。远处传来充能站的低频嗡鸣。

通讯器又震了一下。不是虹姐——是一个陌生号码。消息只有四个字：

"别去GR-17。"`,
  },
  {
    name: "九州・云梦泽",
    description: "修仙世界，灵气复苏，宗门林立。你是偏僻小宗的外门弟子。",
    locale: "zh-CN",
    tags: ["修仙", "灵气", "宗门"],
    dimensions: CLOUDMERE_DIMENSIONS,
    lore: `# 九州・云梦泽

## 世界设定
云梦泽是九州大陆东南方的一片广袤灵域，方圆三千里，水系纵横如织，终年弥漫着淡蓝色的水雾。这里的灵气浓郁到肉眼可见——清晨时分，灵气凝结成细小的光点，像萤火虫一样在水面上漂浮。外来者初入云梦泽时往往会感到眩晕，那是身体在适应远超常规的灵气浓度。

云梦泽以灵植培育、炼丹和水系法术闻名九州。数十个大小宗门散布其中，各据一条灵脉。灵脉是地底深处的灵气通道，灵气沿灵脉涌出地表，形成高浓度灵气区域——宗门都建在灵脉出口之上。灵脉的品质决定了宗门的实力上限：一等灵脉能养出金丹修士，末等灵脉连练气都勉强。

修仙体系分为五个大境界：**练气**（感知灵气、引气入体）、**筑基**（构建灵力循环、开辟丹田）、**金丹**（凝聚灵力核心）、**元婴**（孕育第二意识体）、**化神**（意识与天道共鸣）。每个大境界又分九层。绝大多数修士终身停在练气期——不是天赋不够，就是资源不足。筑基是真正的分水岭：百名练气修士中能成功筑基者不过二三。

这是一个看似风雅实则残酷的世界。宗门之间吟诗论道、互赠灵茶，背地里却为一条灵脉的控制权打得你死我活。高阶修士呼风唤雨，低阶弟子如蝼蚁。资源永远不够——灵石、功法、丹药、灵植种子——每一样都要用命去争、用命去换。

## 核心规则
- **灵脉分布**：灵气并非均匀分布。灵脉附近浓郁，荒野稀薄。离开灵脉超过百里，修炼效率降至十分之一。这使得灵脉成为所有宗门争夺的核心资源。新灵脉的发现可以改变整个地区的势力格局。
- **修炼三要素**：修炼需要功法（修炼方法）、灵石（能量来源兼通用货币）和灵根（天生资质）。灵根分五行——金木水火土——以及罕见的变异灵根。云梦泽水气充沛，水灵根修士在此地有天然优势。
- **梦莲**：云梦泽特产的灵植，生于深水灵脉交汇处。服用后可短暂扩展灵识范围至平时的十倍，是探查、鉴宝的利器。但梦莲有极强的成瘾性——长期服用者会出现"梦溺"症状：灵识过度扩展后无法收回，最终意识涣散、沦为行尸走肉。低品梦莲在坊市公开售卖，高品梦莲被各大宗门严格管控。
- **宗门法则**：表面上，云梦泽各宗门遵守"灵脉盟约"——不得以武力争夺已划定的灵脉。实际上，盟约被无数次暗中违反。宗门派出低阶弟子"探查"他人灵脉边界、在试炼中"意外"伤害竞争宗门的天才弟子——这些都是心照不宣的手段。低阶弟子是宗门纷争中最先被牺牲的棋子。
- **天道感应**：金丹以上的修士行事会引发"天道感应"——大规模使用灵力会引来天劫雷罚。因此高阶修士轻易不会出手，宗门间的冲突大多由筑基及以下弟子执行。这形成了一个扭曲的格局：决定战争的是老人，上战场的是年轻人。

## 势力格局
**碧波宗**是云梦泽最大的宗门，占据一等灵脉"碧波灵渊"，坐拥三名金丹长老。宗主萧衍笙是云梦泽修为最高者（金丹九层，据传已在尝试凝婴），也是灵脉盟约的制定者和最大受益者——盟约实质上是在他碧波宗已经占据最好灵脉后冻结现状。碧波宗弟子以傲慢闻名，但他们的水系功法确实是云梦泽最精纯的。

**青萍宗**是中等宗门，据三等灵脉"青萍涧"，仅有宗主一人为金丹修士。青萍宗以灵植培育和炼丹见长，出产的灵丹在坊市颇有口碑。宗主陆沉渊为人低调寡言，在宗门事务上放权给几位筑基长老管理。外界传言他正在闭关冲击元婴——但知情者知道，青萍宗的灵脉品质不足以支撑元婴突破。他到底在做什么？

**药王谷**不算传统宗门，而是炼丹师的松散联盟，控制着云梦泽大半的丹药贸易。谷主"百毒不侵"柳娘是极少数的毒修——在以水灵根为尊的云梦泽，毒修被视为异端。但没人敢惹她，因为你永远不知道她今天喝的茶里放了什么。药王谷与所有宗门做生意，不偏不倚，唯利是图。

**散修联盟**是近年兴起的底层力量。没有灵脉、没有功法传承的散修们联合起来，在宗门势力的夹缝中求生。他们在荒野中搜寻残存灵气修炼，效率低下但自由。联盟中人才参差不齐——有走投无路的前宗门弃徒，也有天赋异禀但出身寒微的天才。联盟领袖"老树"据说是一个筑基后期的散修，在没有灵脉支撑下达到这个境界本身就是传奇。

**梦商会**是一个灰色势力，垄断了高品梦莲的地下交易。表面上他们是药材商人，实际上梦莲成瘾者是他们最稳定的客户群。梦商会渗透了几乎所有宗门的底层，因为低阶弟子压力最大、最容易依赖梦莲来提升短期表现。

## 关键人物
- **玩家**：青萍宗外门弟子，练气三层，水灵根（中品）。入门两年，表现中规中矩。你不是天才——在一个天才如云的宗门里，你只是数百外门弟子中普通的一个。但你有一个别人没有的特质：你的灵识异常敏锐，能感知到常人忽略的灵气波动。验灵长老说这不算天赋，只是"体质略有不同"。
- **师姐苏婉**：外门首席弟子，筑基二层，罕见的冰灵根（水灵根变异）。她是青萍宗外门弟子的标杆——天赋高、修炼勤、待人温和。她对你格外照顾，不仅因为你们入门同期，更因为她发现了你灵识敏锐的特质，认为这被低估了。苏婉的压力比她表现出来的大得多——内门选拔在即，她是外门唯一有希望入选的人，整个外门的期待压在她一个人肩上。
- **宗主陆沉渊**：金丹后期，五十余岁但面容不过三十。极少在弟子面前露面，宗门日常由三位筑基长老管理。他给人的感觉像一潭深水——平静，深不见底。最近半年他连长老会议都不再参加，只传出一句话："试炼大会照常举行。"
- **碧波宗少主萧云璃**：练气九层（即将筑基），萧衍笙之子。天赋极高但性情乖戾，视其他宗门的同辈为蝼蚁。他将参加今年的宗门联合试炼——上一次他参加时，"意外"重伤了两名其他宗门弟子。
- **柳娘**：药王谷谷主，修为不详（她拒绝参加任何公开比试）。总是笑眯眯地端着一杯颜色可疑的茶。她与陆沉渊似乎有旧交——每年春分，她会亲自给青萍宗送一批特殊丹药，但没人知道那是什么药。
- **"老树"**：散修联盟领袖，外貌苍老如枯木。筑基后期的散修——在没有灵脉支撑下修到这个境界，说明他要么有惊人的天赋，要么有不为人知的秘密。他最近频繁出现在青萍宗附近的坊市，采购大量灵植种子。

## 暗线与悬念
- 苏婉三天前在云梦泽深处发现了一条未登记的野生灵脉。这本该是改变青萍宗命运的喜讯——但她没有上报宗门，而是先告诉了你。她说她在灵脉附近感知到了"不对劲的东西"，希望你用你敏锐的灵识先去确认。
- 陆沉渊并非在冲击元婴。最近偶然撞见他书房的弟子发现，他在研究一种极其古老的阵法——那些符文不属于任何已知的功法体系。他的桌上还放着一封被撕碎的信，信纸上有碧波宗的水纹印记。
- 云梦泽的灵气浓度在过去一年中缓慢下降。这个变化微小到只有最敏感的修士才能察觉——而你恰好是其中之一。灵脉在干涸？还是灵气在被某种东西吸走？
- 梦莲的产量在上升，但深水灵脉的梦莲花田在萎缩。也就是说，有人在人工培植梦莲——但梦莲的培植技术据说已经失传千年。谁掌握了这个技术？
- 十年前的"碧波灵渊事件"是云梦泽最大的忌讳。碧波宗声称那只是一次灵脉异动，但参与处理的三名非碧波宗修士事后全部失踪。

## 开局情境
春日午后，青萍宗外门坊市。空气中飘着灵植花粉的甜香，淡蓝色的灵气光点在水汽中浮沉。坊市不大，但今天格外热闹——三天后就是试炼大会，外门弟子们都在抢购最后的备战物资。

你刚用攒了两个月的灵石买了一瓶回灵丹——品质一般，但聊胜于无——就看见师姐苏婉从坊市东侧快步走来。她的脸色不太对。苏婉向来从容沉静，你很少看到她这副表情。

她拉住你的袖子，把你带到一个无人的角落。

"我发现了一条灵脉。"她的声音压得很低，但你能听出其中的激动和不安，"在云梦泽东南方向，百灵沼泽的深处。三等……不，至少二等。是野生的，没有任何宗门的标记。"

你的心跳加速。一条未被发现的二等灵脉——这在云梦泽几十年来闻所未闻。如果上报宗门，这足以让青萍宗的实力上一个台阶。

但苏婉的下一句话浇了你一盆冷水。

"灵脉旁边有东西。"她皱着眉，"我的灵识探到了一个地下结构——非常古老，灵纹风格不像任何已知的宗门遗址。而且……"她犹豫了一下，"那个结构在吸收灵脉的灵气。不是自然消散，是主动吸收。像是有什么东西在里面……在进食。"

远处传来宗门钟楼的正午钟声，惊起一群灵雀。

"我没有告诉任何人。"苏婉看着你，"试炼大会之前，你愿意和我去看看吗？"

钟声回荡在水雾之间，久久不散。`,
  },
  {
    name: "Mistport Chronicles",
    description: "A fog-shrouded port city where each tide reveals ancient ruins. Adventure awaits.",
    locale: "en-US",
    tags: ["fog", "harbor", "adventure"],
    dimensions: MISTPORT_EN_DIMENSIONS,
    lore: `# Mistport Chronicles

## World Setting
Mistport is a city that shouldn't exist — wedged between sheer sea cliffs and a restless ocean, clinging to the rock face like a barnacle that grew too ambitious. Perpetual grey fog blankets everything. The air always tastes of brine and corroded iron. Visibility never exceeds fifty paces, and on bad days it's half that. The locals don't say "good morning" — they say "quiet fog," because a quiet fog means the fog beasts aren't close.

The city sprawls vertically across three tiers. The **Upper City** sits atop the cliffs, where the Council and the great merchant houses hide behind stone walls thick enough to muffle the sea. The air is cleaner up there — fog thins near the cliff edge, and on rare days you can almost see the sky. **Mid-Harbor** is the city's beating heart: a chaotic tangle of docks, workshops, taverns, and gambling dens strung along the cliff face on platforms of wood and iron. Everything creaks. Everything leaks. The great mechanical tide-clock tower marks time not by hours but by tidal cycles — the only schedule that matters. Below everything lies the **Undertow**, a vast expanse of seabed that only reveals itself when the tide pulls back. And when it does, ancient ruins emerge — structures of unknown origin, impossible geometry, and unpredictable treasures.

No one knows who built the ruins. The Tide-Readers Guild, Mistport's scholarly class, has catalogued over four thousand distinct relic types recovered from the Undertow, and none match any known civilization. The strangest part: the Undertow never repeats. Every low tide reveals a completely different layout — as if the seafloor is rearranging itself between floods. The Guild calls this phenomenon "the Rift Tide," and after two centuries of study, they still can't explain it.

Relic trade is the lifeblood of Mistport's economy. Some relics are wondrous — cold-light lanterns that burn without flame, stones that purify water, compasses that point toward hidden things. Others are lethal — a ring that fuses to your finger and slowly turns your hand to coral, a mirror that shows you your death. Every relic must be appraised by a licensed Tide-Reader before it can be legally sold. The black market, of course, has no such requirement.

## Core Rules
- **The Rift Tide**: Each low tide reveals completely different ancient structures in the Undertow. No map is ever valid twice. Withdrawal windows last 4-6 hours. When the tide returns, it comes fast — the Undertow floods completely in under twenty minutes. Being caught in a rising tide is almost certain death.
- **Fog Beasts**: The fog harbors predatory creatures with no fixed form — sometimes they look like tendrils of darker mist, sometimes like distorted silhouettes of people. They hunt by sound and light. Open flames, shouting, metal clashing — all attract them within minutes. Explorers carry coldstone lanterns (dim, silent light) and communicate in sign language. The most experienced never speak at all in the fog.
- **Relic Unpredictability**: Ancient relics have effects that cannot be predicted from their appearance. A jeweled dagger might be harmless; a plain stone might level a building. Unauthorized use of unappraised relics is a capital offense — but on the black market, unappraised relics sell for triple the price, because their unknown potential is the attraction.
- **Tide-Force**: A rare ability — roughly one in a thousand people can sense a mysterious energy emanating from the deep ruins. It's strongest during low tide and vanishes completely at high tide. Overuse causes "fog-erosion": the body gradually becomes translucent, eventually dissolving into the mist. The Council officially denies tide-force exists. The Tide-Readers Guild officially agrees. Both are lying.
- **The Seal Tide Decree**: Council law prohibiting unlicensed civilians from entering the Undertow. Violators face imprisonment and asset seizure. Enforcement is spotty — the Undertow is too vast and the fog too thick for patrols to cover. In practice, the Decree primarily serves to funnel all legal relic trade through Council-approved channels.

## Power Dynamics
The **Mistport Council** is dominated by merchant aristocrats who've held power for generations. Councilor Chen Yuanshan is pushing the Seal Tide Decree harder than any predecessor — officially for public safety, but his personal exploration teams operate in the Undertow with impunity. The Council is fracturing: doves argue that suppression only feeds the black market; hawks want to militarize the Undertow entirely. Chen plays both sides, and no one is sure what he actually wants.

The **Tide-Readers Guild** appraises relics, studies the Rift Tide phenomenon, and maintains Mistport's only library. Guild Master Qi is a gentle, aging scholar who cares more about knowledge than politics — or so he seems. The Guild depends on Council funding but maintains nominal independence. Younger Tide-Readers are growing restless: several have noticed that certain appraisal reports are being suppressed by senior members, and relics matching specific descriptions are being quietly confiscated rather than catalogued.

The **Salt Fangs** control the Undertow's black market from their hidden base in the flooded caves below the city. Their second-in-command, **Iron Meg**, runs operations with an iron fist and a surprising code of ethics: she refuses to sell unappraised dangerous relics to unknowing civilians. Meg was once a Tide-Reader apprentice — a secret that could destroy her credibility in the underworld and the Guild alike. The Salt Fangs and the Council exist in a state of cold war: mutual infiltration, occasional back-alley violence, but neither can eliminate the other.

The **Congregation of the Mist** is a growing religious movement that worships "the Mist Lord" — they believe the fog itself is a living, conscious entity, and that the ancient ruins are fragments of its body. They attract the desperate and the dispossessed with promises that fog-erosion is not a curse but a transcendence. The Council labels them a cult. Their membership has tripled in two years.

## Key Characters
- **The Player**: A newly certified Tide-Reader apprentice arriving at Mid-Harbor. You passed your certification exam with an unusual distinction — your tide-sense readings were off the charts, though the examiners attributed it to equipment malfunction. You know it wasn't a malfunction. You can feel the deep ruins humming beneath the water, even at high tide.
- **Iron Meg**: Salt Fangs second-in-command. Mid-thirties. Her left arm below the elbow is translucent — fog-erosion from a relic accident years ago. Cold, precise, keeps her word. She's not just running a smuggling ring — she's quietly collecting specific relic fragments, pieces of something larger. What she's building, no one knows.
- **Councilor Chen Yuanshan**: Council chairman. Sixties. A master politician who has outlasted three rivals and two assassination attempts. His private exploration teams search the Undertow with an urgency that goes beyond profit. What is he looking for?
- **Guild Master Qi**: White-haired, soft-spoken, perpetually lost in thought. One of the few people alive who knows the truth about the Rift Tide. He has chosen silence. Recently, fog-erosion marks have appeared on his hands — but he has never publicly used tide-force.
- **Frost**: The youngest "Mist Speaker" of the Congregation. Barely sixteen. She claims to hear the fog whispering, and has accurately predicted low-tide timing and ruin locations multiple times. Prophet, lunatic, or fraud?

## Hidden Threads
- In the deepest withdrawal on record, an expedition team retrieved a relic inscribed with text identical to Mistport's founding stone — but carbon dating shows it is ten thousand years older than the city.
- Fog-erosion cases have tripled in the past year. The Council refuses to acknowledge the increase. Qi's private journal reads: "The fog is thickening. It thickens every decade. We are approaching a critical point in the cycle."
- Three years ago, a Council expedition went deep into the Undertow and vanished. The sole survivor went mad, repeating one sentence for the rest of his life: "It woke up down there."
- Iron Meg and Councilor Chen are searching for the same thing — fragments of what appears to be a key. A key to what?

## Opening Scene
Dusk. You step off the ferry onto Mid-Harbor's main pier, boots squelching on waterlogged planking. The mooring ropes disappear into grey nothing within arm's reach, as if the ship you just left has already ceased to exist. The air is thick enough to chew — salt, rust, the faint sweetness of something rotting. Somewhere above, the great tide-clock groans through its mechanisms.

Then the bell rings. Not the regular timekeeping toll — three sharp strikes in rapid succession. On the dock, grizzled sailors freeze mid-motion. Conversations die. Three strikes means a deep withdrawal alert: the tide is pulling back farther than usual, exposing ruins that haven't seen air in decades. The last deep withdrawal was six years ago. It revealed the structure called the Bone Arch. It also killed seventeen people.

The pier splits into two currents of humanity. To your left, Salt Fang recruiters whisper promises of fortune to anyone brave or desperate enough to descend. To your right, Council officers plaster emergency Seal Tide Decree notices on every available surface, warning that unauthorized Undertow entry will result in immediate arrest.

A young woman in a Tide-Readers Guild uniform pushes through the crowd toward you — you recognize her as the examiner from your certification test last week. She looks rattled.

"You're the new apprentice? Good." She doesn't wait for confirmation. Her voice drops. "Guild Master Qi is missing. He left a note this morning and walked into the Undertow — but the tide was still in. No one can enter the Undertow during high tide."

She glances toward the clock tower. "Unless a deep withdrawal changes the timing."

The fourth bell rings. The ground trembles. At the edge of the pier, the grey water begins to retreat, and for the first time in six years, the deep ruins stir.`,
  },
];
