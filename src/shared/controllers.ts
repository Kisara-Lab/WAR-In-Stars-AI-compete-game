import type { MatchConfig } from './types.js';

export function factionController(config: MatchConfig, actor: string): 'model' | 'scripted' {
  if (config.controller !== 'mixed') return config.controller;
  const selected = config.factionControllers?.[actor];
  if (!selected) throw new Error('混合局缺少势力控制器：' + actor);
  return selected;
}

export function controllerLabel(config: MatchConfig, actor: string): string {
  const strategy = config.scriptStrategies?.[actor] ?? config.scriptStrategy;
  return factionController(config, actor) === 'model' ? 'AI · ' + config.models[actor]
    : (strategy?.startsWith('adaptive-') ? '智能脚本 · ' + strategy : '旧脚本基线');
}

export function validateControllers(config: MatchConfig) {
  const ids = config.factionIds;
  if (new Set(ids).size !== ids.length) throw new Error('势力清单不能重复');
  if (config.scriptStrategies !== undefined) {
    const strategies = config.scriptStrategies;
    if (config.controller !== 'scripted' || !['adaptive-v4.1', 'adaptive-v4.12'].includes(config.scriptStrategy ?? '') ||
        Object.keys(strategies).length !== ids.length || Object.keys(strategies).some(id => !ids.includes(id)) ||
        ids.some(id => !['adaptive-v4.1', 'adaptive-v4.12'].includes(strategies[id]))) {
      throw new Error('脚本对照仅支持纯脚本V4.1/V4.12，策略席位必须完整且与势力清单一致');
    }
  }
  if (config.controller === 'mixed') {
    const seats = config.factionControllers ?? {};
    if (Object.keys(seats).length !== ids.length || Object.keys(seats).some(id => !ids.includes(id)) || ids.some(id => !['model', 'scripted'].includes(seats[id]))) throw new Error('混合局控制器必须与势力清单一致');
    if (!ids.some(id => seats[id] === 'model') || !ids.some(id => seats[id] === 'scripted')) throw new Error('混合局至少需要一个模型席位和一个脚本席位');
  } else if (config.factionControllers !== undefined) throw new Error('逐势力控制器仅用于混合局');
  const modelIds = config.controller === 'mixed' ? ids.filter(id => factionController(config, id) === 'model') : ids;
  if (modelIds.some(id => !config.models[id]) || Object.keys(config.models).some(id => !modelIds.includes(id))) throw new Error('模型配置必须与模型席位一致');
  if (config.controller === 'model' && config.scriptStrategy?.startsWith('adaptive-')) throw new Error('模型局不能配置智能脚本');
  if (config.scriptSearchProfile !== undefined && !['adaptive-v3','adaptive-v4','adaptive-v4.1','adaptive-v4.12'].includes(config.scriptStrategy??'')) throw new Error('搜索档位仅用于adaptive-v3/v4');
}

export function configureSeats<Config extends MatchConfig>(config: Config): Config {
  const next = { ...config };
  // Ordinary new-match form changes must not inherit an invisible comparison roster.
  delete next.scriptStrategies;
  if (next.controller === 'mixed') {
    next.factionControllers = Object.fromEntries(next.factionIds.map((id, index) => [id, next.factionControllers?.[id] ?? (index % 2 ? 'scripted' : 'model')]));
  } else delete next.factionControllers;
  next.models = Object.fromEntries(next.factionIds.filter(id => next.controller !== 'mixed' || factionController(next, id) === 'model').map(id => [id, next.models[id] ?? 'grok-4.7']));
  if (next.controller === 'model') {
    delete next.scriptStrategy;
    delete next.scriptSearchProfile;
  } else {
    next.scriptStrategy ??= 'adaptive-v4.12';
    if (['adaptive-v3','adaptive-v4','adaptive-v4.1','adaptive-v4.12'].includes(next.scriptStrategy)) next.scriptSearchProfile ??= 'standard';
    else delete next.scriptSearchProfile;
  }
  return next;
}
