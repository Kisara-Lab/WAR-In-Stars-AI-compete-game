import { z } from 'zod';
const id=z.string().min(1).max(160);
export const EMERGENCY_SCHEMAS={
  activate_extraction:z.strictObject({}),
  stop_extraction:z.strictObject({}),
  demand_stop_extraction:z.strictObject({factionId:id,eventId:id}),
  accept_stop_extraction:z.strictObject({demandId:id}),
  reject_stop_extraction:z.strictObject({demandId:id}),
};
export const EMERGENCY_DESCRIPTIONS:Record<keyof typeof EMERGENCY_SCHEMAS,string>={
  activate_extraction:'5.4国教每局一次什四税，最长1800日。无来源特殊补助只托基础经济和启用时舰船额度，新军备/额外战争维护/维修/加工不报销；社会逐步恢复，征收Q最高0.50且信仰任期失格。立即公开并引发乌托邦180日要求+180日通牒。',
  stop_extraction:'永久停止本次征收，不可重开。立即撤销舰船补助；剩余原期限内民生补助线性退出，社会恢复轨迹继续。',
  demand_stop_extraction:'乌托邦针对已知仍持续的eventId提出180日停止通牒；条约不阻止提出要求；每事件每方一次，不刷新期限。',
  accept_stop_extraction:'接受收到的停止通牒，停止征收并进入1080日改革监督；归还相关救援战争占领并签三年互不侵犯。补助仍按原截止日渐退，连续360日合格才完整履责。',
  reject_stop_extraction:'拒绝收到的停止要求，立即开放征收救援理由，仍遵守互不侵犯；不能重复拒绝刷新时钟。',
};
