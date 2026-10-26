import { V54, emergencyRules } from '../shared/emergency.js';
import { governed, actionLimit, outputLimit, V53 } from '../shared/governance.js';
import { responsible, RESPONSIBILITY } from '../shared/responsibility.js';
import { CIVILIZATION, V5_POLICIES, welfareRules, modern } from '../shared/civilization.js';
import { BALANCE } from '../shared/balance.js';
import { ESCALATION } from '../shared/escalation.js';
import { POLICIES } from '../shared/civil.js';
import { LABOR, BUILDING_EFFECTS, EXPANSIONS, INDUSTRY, shipMaterials } from '../shared/industry.js';
import { BASE, RULES, SHIPS, STRUCTURES } from '../shared/rules.js';
import { V4, WAR_NAMES } from '../shared/v4.js';
import type { GameState } from '../shared/types.js';

export function decisionRules(state: GameState) {
  const v5=modern(state);
  const lines = [
    '你是多方太空4X比赛指挥官。依据当前己方可知情报自主选择收益与风险。唯一最终调用submit_turn，最多23条orders及简短公开中文summary；等待提交orders=[]。无需先查询：comparison已包含规则资格、产业、政策与预测。摘要不输出隐藏推理。',
    'SSE完整响应后校验。任一命令失败整批回滚，资源与槽位预留全部撤销。根据对应function_call_output重交完整计划；每回合最多3次请求，失败不提交。最近summary只是意图，recentDecisionOutcomes和当前事实优先。',
    '势力同轮边界并发决策。按orders顺序预留；可先宣战后移动。未知敌军不等于零，不得把其他国家军力计入目标敌国。敌军按ID去重并参考lastSeenDay；局部基地、增援及未知军力分别评估；1.5倍仅建议。',
    '单位：资源为实际数量；凝聚力0～100，100最高。每轮100日，每步10日，一年360日。生产建设基础倍率0.5+凝聚力/100；每种基础短缺效率与战力×0.5。探索和殖民固定500日。',
    '外交：contact双方confirm_contact才正式和平；和平默认闭境，通行须授权或宣战。条约禁止宣战，政策锁定不禁止战争。和平提议300日过期且下一轮才可接受，停战签1080日条约并撤军；撤离中舰队不能下新移动命令。',
    JSON.stringify({warPaths:{total:{fields:{warType:'total',systemIds:[],grievanceId:'有效且可用理由ID',reason:'公开理由'},path:'母星、失土、宿敌、遭总体战、圣地或成熟征服准备；无当前理由可评估准备路径',reward:'吞并、淘汰；整合720实际控制日生产/建设/增长×0.5，维护全额；每持有整合完成的星系100成果分',cost:'每场主动/防御总体战舰船电矿维护+25%/+10%，最多60%；主动每场凝聚力-1最多-3'},claim:{path:'100矿物宣称已探索法理接壤敌方星系，必须前一决策轮完成；最多两个，禁对方初始母星及最后领土割让',reward:'声明目标割让；无吞并整合期'},limited:{path:'邻接敌基地一个',reward:'不割地；基地停用300日，赔偿最多200矿物'},missionary:{path:'国教、邻接敌殖民星系',reward:'1800日传教权，不割地不改宗'},ideological:{path:'己方殖民地有对方传教权或影响>=20',reward:'清除指定宗教影响与权利，1080日保护'}},settlement:'非总体战临时占领不淘汰，连续控制目标200日可强制议和；疲劳100或2160日结算；首次接触冲突900日返还，空战争不刷宿敌',preparation:'准备日数、条约剩余、资格有效期分别见escalation。成熟即具资格，1080无条约和平日是有效期，不是额外等待。仍需另行declare_war，total目标数组永远[]，进攻目的地另用move_fleet。'}),
    v5 ? 'V5三层制度：普通世俗可不承诺；乌托邦共同体、军国主义、永久国教互斥且永久。民众待遇是每人口真实账单，最高待遇不自动建立乌托邦；两年政策只是演习/交流/监听/不采用，不代表文明路线。重工业不等于低福利，工业惩罚与福利分别结算。'
      : '4.3仍使用旧两年政策与永久国教。乌托邦政策不禁战、不禁止征服准备；主动总体战只使该届灯塔评估不合格。宣称战争可以割地，有限军事战不能割地。',
    v5 ? JSON.stringify({civilizations:{secular:'无永久承诺，可付五档待遇',utopia:'最高待遇连续720日，最近72步至少90%福利足额/基础供应正常/凝聚力>=80且当前足额供应。先明确撤回征服准备，再确认永久。锁最高福利，无旧资源折损。正常履约增长×1.15、凝聚力+2，2/3期灯塔另+1/+2；每合格720日100文明分。只禁止prepare_conquest，所有有合法依据的其他战争包括总体战仍可发动，参战不使评估失格。',militarist:'无需军力或战绩前置；永久确认。舰队基地战力1.10，造舰1.15，全舰维护1.10，工业惩罚1.25，无资源产出加成。准备180日/150矿50粮5凝聚力；可选五档福利。',theocracy:'须探索发现可达候选，永久主圣地和教义。锁教廷保障；未祝圣不罚失守。低危机战力1.08，安全已祝圣主圣地且危机<20全资源生产1.10；失约增加危机，损失及圣地失守可使优势反转。稳定信仰完整期100文明分，主/附属圣地200/100动态分'},welfare:'基础维护优先、再按共同比例支付福利、再冶炼、维修。待遇360日冷却，永久制度锁定优先。资源不足不降档不借债；失约凝聚力-6×未兑现比例。文明总分1500封顶。',minorPolicies:'每720日一期，不自动续期，可提前预约。演习仅舰队战力1.03及舰船维护1.05；交流须至少一方正式和平凝聚力+.5增长1.05；监听仅正常LRS维护.85，不增视野。'}) : '',
    '产业：1人口1岗位，地表轨道共享；岗位不足设施按比例运行。先比较comparison.industry中的暂不建设、封存及调岗，不能把空岗位等同需要电站。已排队建筑已计入新增产能比较；已排队船已预付材料。地表轨道分别串行，船厂独立串行；LRS满员且供电维护正常才有两跳军事视野，不替代探索。建设投资、维护、岗位挤占、完成日期及具体资源用途一起比较；冶炼转换不是材料增值投资，不能因材料等价回本为空就认定无用。',
    '评分：100×法理星系+200×殖民地+5×人口+0.5×基础舰队战力+储备分+战争成果+文明成果。矿物+2合金前2000每10计分、后8000每40计分，上限400。建筑本身不计分；战争领土成果同星系持有才计且去重，非领土目标去重总限500。比较剩余时间，不设路线、战争或政策配额。',
    '预测为条件性经济试算：冻结控制权和外部战况，不假设胜利，不读取敌方隐藏资产；供应、排队及战争可使结果变化。经济静态表不代表将来保证收入。',
    JSON.stringify({civilization:v5?{...CIVILIZATION,revision:state.rulesRevision}:undefined,welfare:v5?welfareRules(state):undefined,policies:v5?V5_POLICIES:Object.fromEntries(Object.entries(POLICIES).filter(([id])=>['none','utopia','balanced','militarism'].includes(id))),industry:INDUSTRY,labor:LABOR,effects:BUILDING_EFFECTS,expansions:EXPANSIONS,structures:STRUCTURES,ships:Object.fromEntries(Object.entries(SHIPS).map(([id,s])=>[id,{...s,materialCost:Object.fromEntries(Object.entries(shipMaterials(id as keyof typeof SHIPS)).map(([k,v])=>[k,v/1000]))}])),base:BASE,faithTiers:V4.faithTiers,warTypes:responsible(state)?WAR_NAMES:Object.fromEntries(Object.entries(WAR_NAMES).filter(([id])=>id!=='humanitarian')),escalation:ESCALATION,balance:{annexationDays:BALANCE.annexationDays,civilizationCap:BALANCE.civilizationCap},limits:{...RULES,startingUnity:RULES.startingUnity/100,maxActions:actionLimit(state),maxOutputTokens:outputLimit(state)}}),
  ].filter(Boolean);
  if(emergencyRules(state)) lines.push(
    '5.4什四税：永久国教可随时activate_extraction，每局一次1800日。补助是无来源特殊救急，与正常产出分账；只覆盖基础维护、完整可交付教廷福利及启用时舰船额度。新增军备、额外战争维护、冶炼、维修、建设不报销。社会恢复轨迹将危机上限降至19、凝聚力下限升至60。征收期间Q最高0.50，重叠稳定信仰任期失格；须比较退出后的经济。',
    '乌托邦获知强制征收后180日内须demand_stop_extraction；目标再有180日接受，拒绝可提前开放救援理由。条约不阻止提出要求但禁止宣战。可合法干预而不行动受责任惩罚；空宣战不算履责，有实际交火最多缓冲720日。普通援助或改革提案不能替代本次停止要求。',
    'accept_stop_extraction或以accept_reform接受该救援战争：停止征收、归还占领、1080日停战和监督；控制声明基地200日可enforce_peace取得停止协议。无条件accept_peace不会强制停止征收。停止后取消舰船补助，民生托底按剩余原期限渐退，不重开不延期；连续360日合格才完成救援责任。responsibilities.emergency和comparison.emergencyEconomy提供账目及退出估算；静态政策表为正常经济，特殊补助另列。',
    JSON.stringify({emergency:V54}),
  );
  if(governed(state)) {
    for(let i=0;i<lines.length;i++) lines[i]=lines[i].replace('最多23条orders','最多48条实际动作；批量子项逐条计数').replace('地表轨道分别串行，船厂独立串行','每行星地表轨道各2条并行施工线；船厂默认1条，正常满员干船坞及电矿供应正常开放第2条').replace('200×殖民地+5×人口','Q×(200×殖民地+5×人口)');
    lines.push('5.3：Q为最近720日实际待遇系数×福利兑现×基础供应×min(1,凝聚力/60)的十日平均，可降至0。没有历史时仅显示当前估计。国家名称或路线不直接加分；只折算殖民地与人口分，历史成果不删除。comparison.governance显示原始及折算社会资产。');
    lines.push('5.3军国：总体战正式吞并新星系立即不满-30；按势力+星系永久去重，每战阶段压力缓冲最多1080日。完整成果仍须战后认定。临时占领不算吞并。accept_peace无条件归还临时占领，只有正式吞并主权保留；未达标声明目标不会割让。先看settlementPreview，不把计划摘要当作实际事实。');
    lines.push('传教责任actionable=false仅描述传教路径。普通战争、宣称及征服准备须分别判断；未知军力不是零，军事侦察日期不代表殖民情报更新。争端不存在或回应冷却未结束时不能重复回应。批量move_fleets/queue_ships_many/set_structures_status按输入顺序展开，每项计动作，任何子项错误整批回滚。无需填满48条。');
    lines.push(JSON.stringify({v53:V53}));
  }
  if(responsible(state)) return lines.map(line=>line.replace('可选五档福利。','仅可选小康/基础/生存；从高待遇建立时必须同时明确welfare。').replace('须探索发现可达候选，永久主圣地和教义。','全图只有两个永久创教名额，须探索且法理拥有并实际控制未登记候选。登记后失守或淘汰不释放；附属圣地不提供名额。')).concat([
    '5.2责任：国教1080日、军国720日整备。国教须兑现传教目标并保有有效传教权；军国须实际军事成果或成功防御。空宣战不算，真实战损或占领每战最多缓冲360日。没有合法路径才暂停，缺资源/舰队不暂停。comparison.responsibilities提供己方时钟、合法路径、民生报告及协议。',
    '乌托邦关注360日到期后可援助、改革或民生救援战。援助预付300电150矿300粮、180日接受，只补360日福利；真实支付且改善100日才有进展。改革1080日，180日恢复，持续监督，协议不等于完成责任。民生救援战warType=humanitarian、有效关注/违约grievanceId、一个已知可达边境殖民目标；不割地，控制200日强制改革，停战1080日条约。连续合格360日才完成责任，空提案不刷新时钟。',
    '无回应暂停灯塔并使当期不合格，文明当前扣分每100日50、最多300；实际进展最长缓冲720日，履责或解除后300日恢复分数。国教逾期每100日+6危机，连续720日后+10；军国+5不满，20/40/70档凝聚力-1/-3/-6，失败主动战争另+20。实际成果满足1800日。',
    'recentWorldResults按命令和目标汇总实际世界执行；recentSettlementFailures持久记录基地失败。二者优先于计划摘要，不能把工具接受当作建设成功；同目标未刷新情报应先派舰侦察或建立合法传感覆盖，不要重复旧情报基地命令。',
    JSON.stringify({responsibilities:RESPONSIBILITY}),
  ]).join('\n');
  return lines.join('\n');
}
