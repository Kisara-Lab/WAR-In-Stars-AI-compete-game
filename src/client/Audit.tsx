import { useEffect, useState } from 'react';
import type { GameState } from '../shared/types.js';

interface RecordView { seq: number; time: string; day: number; round: number; category: string; factionId?: string; systemId?: string; attemptId?: string; committed: boolean | null; hash: string; data: unknown }
interface Page { coverage: string; total: number; matched: number; next: number | null; records: RecordView[] }
export function AuditPanel({ state }: { state: GameState }) {
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [filters, setFilters] = useState({ factionId: '', systemId: '', category: '', attemptId: '', fromDay: '', toDay: '' });
  const [after, setAfter] = useState(0);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    const query = new URLSearchParams({ after: String(after), limit: '40', ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== '')) });
    setBusy(true); setError('');
    fetch(`/api/matches/${state.id}/audit?${query}`, { signal: abort.signal }).then(async response => {
      const value = await response.json();
      if (!response.ok) throw new Error(value.error);
      setPage(value);
    }).catch(error => { if (!abort.signal.aborted) setError(error.message); }).finally(() => { if (!abort.signal.aborted) setBusy(false); });
    return () => abort.abort();
  }, [state.id, state.round, after, filters, refresh]);
  const change = (key: keyof typeof filters, value: string) => { setAfter(0); setFilters(previous => ({ ...previous, [key]: value })); };
  return <section className="audit-panel" aria-label="完整审计日志">
    <div className="audit-controls"><a href={`/api/matches/${state.id}/export/markdown`} download>导出编年史 Markdown</a><a href={`/api/matches/${state.id}/export/jsonl`} download>导出审计 JSONL</a><button onClick={() => setRefresh(value => value + 1)}>刷新日志</button></div>
    <div className="audit-filters"><label>势力<select aria-label="审计势力" value={filters.factionId} onChange={event => change('factionId', event.target.value)}><option value="">全部势力</option>{Object.values(state.factions).map(faction => <option key={faction.id} value={faction.id}>{faction.name}</option>)}</select></label><label>类别<select aria-label="审计类别" value={filters.category} onChange={event => change('category', event.target.value)}><option value="">全部类别</option>{['model.request', 'model.stream', 'model.response', 'model.tool', 'model.failure', 'model.retry', 'decision', 'attempt', 'event', 'event.battle', 'event.policy', 'event.war', 'event.religion', 'event.beacon', 'economy', 'movement', 'runtime', 'round'].map(category => <option key={category}>{category}</option>)}</select></label><label>星系<select aria-label="审计星系" value={filters.systemId} onChange={event => change('systemId', event.target.value)}><option value="">全部星系</option>{state.systems.map(system => <option key={system.id} value={system.id}>{system.name}</option>)}</select></label><label>开始日<input type="number" min="0" value={filters.fromDay} onChange={event => change('fromDay', event.target.value)} /></label><label>结束日<input type="number" min="0" value={filters.toDay} onChange={event => change('toDay', event.target.value)} /></label><label>决策尝试 ID<input aria-label="审计尝试" value={filters.attemptId} onChange={event => change('attemptId', event.target.value)} /></label></div>
    <p>{page?.coverage} · 共 {page?.total ?? 0} 条{busy ? ' · 加载中…' : ''}</p>{error && <p role="alert">{error}</p>}
    <div className="audit-records">{page?.records.map(record => <details className={`audit-record ${record.committed === false ? 'uncommitted' : ''}`} key={record.seq}><summary>#{record.seq} · 第{record.round}轮 / {record.day}日 · {record.category} · {record.factionId ? state.factions[record.factionId]?.name : ''}<strong>{record.committed === true ? '所属回合已提交' : record.committed === false ? '未提交／进行中' : '运行记录'}</strong></summary><p>{record.time} · 尝试 {record.attemptId ?? '无'} · 哈希 {record.hash}</p>{record.attemptId && <button onClick={() => change('attemptId', record.attemptId!)}>查看本次决策全部记录</button>}<p>回合提交标记不代表每条命令都执行；请查看工具结果中的 rejected／rolled_back／accepted 以及最终游戏事件。</p><pre>{JSON.stringify(record.data, null, 2)}</pre></details>)}</div>
    <div className="audit-controls"><button disabled={!after || busy} onClick={() => setAfter(0)}>回到首页</button><button disabled={!page?.next || busy} onClick={() => setAfter(page!.next!)}>下一页</button></div>
  </section>;
}
