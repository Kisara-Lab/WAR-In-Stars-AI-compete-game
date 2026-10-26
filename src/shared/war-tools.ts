import { z } from 'zod';
const identifier = z.string().min(1).max(160);
export const V4_SCHEMAS = {
  prepare_conquest: z.strictObject({ factionId: identifier, reason: z.string().min(1).max(500) }),
  cancel_conquest: z.strictObject({}),
  declare_war: z.strictObject({ factionId: identifier, warType: z.enum(['total', 'limited', 'claim', 'missionary', 'ideological', 'humanitarian']), systemIds: z.array(identifier).max(2).describe('总体战 total 必须 []；进攻星系另用 move_fleet。claim 为1～2个目标；limited/missionary/ideological 为1个目标。'), reason: z.string().min(1).max(500), grievanceId: identifier.nullable().describe('total 必须填己方有效重大理由 ID，例如 conquest-rose-r68-a0；其他战争必须 null。总体战示例：warType=total, systemIds=[], grievanceId=有效ID。') }),
  create_claim: z.strictObject({ systemId: identifier }),
  enforce_peace: z.strictObject({ factionId: identifier }),
  get_wars: z.strictObject({}),
  get_options: z.strictObject({}),
  get_faith: z.strictObject({}),
  establish_religion: z.strictObject({ planetId: identifier, name: z.string().min(1).max(40), doctrine: z.string().min(1).max(500), acknowledgePermanent: z.literal(true) }),
  consecrate: z.strictObject({ planetId: identifier }),
  respond_dispute: z.strictObject({ response: z.enum(['reconcile', 'reform', 'zeal']), warId: identifier.nullable(), systemId: identifier.nullable() }),
  integrate_thought: z.strictObject({ systemId: identifier }),
};
export const V4_DESCRIPTIONS: Record<keyof typeof V4_SCHEMAS, string> = {
  prepare_conquest: '公开准备征服：300矿物100食物10凝聚力，360日准备期间每100日额外凝聚力-2；和平且已知法理接壤，一方最多一个。成熟资格有1080个无条约和平日，不绕过互不侵犯，不自动宣战。',
  cancel_conquest: '撤回本方征服准备或成熟资格，不退还费用。',
  declare_war: '声明战争类型、理由及最多两个目标。总体战须有效grievanceId且无目标，其他战争grievanceId=null。非总体战不允许临时吞并；条约期禁战。',
  create_claim: '花费100矿物宣称一个已探索的敌方边境星系，有效1800日；最多两个，下一决策回合起才能用于宣称战。',
  enforce_peace: '全部有效目标连续控制200日后强制议和，兑现限定收益并签1080日互不侵犯。',
  get_options: '对等比较本方战争目标、政策静态收支、宗教资格与文明成果；与实际命令共用校验，未知情报仍需结算复核。',
  get_wars: '查询己方战争目标、疲劳、宣称和重大理由，不泄露第三方关系。',
  get_faith: '查询己方国教、信仰危机、圣地、争端和文明灯塔，不泄露外国内部状态。',
  establish_religion: '不可逆确立永久国教：永远禁用乌托邦及灯塔，固定一个已探索可达候选为主圣地。必须明确确认永久后果；公开教义没有自定义机械效果。',
  consecrate: '在己方控制的已殖民候选祝圣，200矿物100食物、固定300日；主圣地一个、附属最多两个，不占槽位。失守将造成信仰危机。',
  respond_dispute: '回应教义争端：reconcile支付100矿物200食物；reform暂停宗教正收益720日；zeal必须绑定失守主圣地或当前战争目标，720日未兑现危机+15。无战争目标时warId/systemId=null。',
  integrate_thought: '己方控制的殖民星系思想整合：100矿物100食物，持续720日，每100日削减3点外国宗教总影响，不取消传教条约。',
};
