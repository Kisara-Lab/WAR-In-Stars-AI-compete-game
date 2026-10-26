import { z } from 'zod';
const identifier=z.string().min(1).max(160);
export const SOCIAL_SCHEMAS={
  get_responsibilities:z.strictObject({}),
  offer_aid:z.strictObject({factionId:identifier,concernId:identifier}),
  accept_aid:z.strictObject({proposalId:identifier}), reject_aid:z.strictObject({proposalId:identifier}),
  propose_reform:z.strictObject({factionId:identifier,concernId:identifier}),
  accept_reform:z.strictObject({proposalId:identifier}), reject_reform:z.strictObject({proposalId:identifier}),
};
export const SOCIAL_DESCRIPTIONS:Record<keyof typeof SOCIAL_SCHEMAS,string>={
  get_responsibilities:'只读查询自己的文明责任、合法行动路径、已知民生报告、援助及改革协议；不泄露外国经济。',
  offer_aid:'乌托邦针对已知关注事件提出援助，预付300电150矿300粮托管；180日内对方接受后仅补360日福利缺口，未用返还。',
  accept_aid:'接受收到的援助并承诺至少均衡小康360日；覆盖待遇冷却，国教/乌托邦保持制度待遇。',
  reject_aid:'拒绝收到的援助，托管资源返还出资方。',
  propose_reform:'针对已知民生关注提出1080日改革协议，180日恢复期；对方接受才生效，不能靠提案刷责任。',
  accept_reform:'接受改革：proposalId填收到的改革提案ID，或对方民生救援战争ID以提前屈服。低待遇立即升到小康；停战归还占领并签1080日互不侵犯，随后监督实际福利。',
  reject_reform:'拒绝收到的改革提案，关注与合法救援理由不会因此取消。',
};
