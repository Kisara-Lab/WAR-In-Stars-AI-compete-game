import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const secrets = new Set<string>();
export function registerSecret(secret: string) { if (secret) secrets.add(secret); }
export function sanitize<Value>(value: Value): Value {
  const clean = (input: unknown): unknown => {
    if (typeof input === 'string') {
      let output = input;
      for (const secret of secrets) output = output.replaceAll(secret, '[密钥已隐藏]');
      output = output.replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [已隐藏]').replace(/sk-[A-Za-z0-9_-]{8,}/g, '[已隐藏]');
      if (/^[\s]*[\[{]/.test(output)) { try { return JSON.stringify(clean(JSON.parse(output))); } catch { return output; } }
      return output;
    }
    if (Array.isArray(input)) return input.filter(item => !(item && typeof item === 'object' && ['reasoning', 'analysis'].includes(item.type))).map(clean);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).filter(([key]) => !/^(authorization|headers|api[_-]?key|key|secret|password|encrypted_content|reasoning_content|hidden_reasoning|chain_of_thought)$/i.test(key)).map(([key, item]) => [key, clean(item)]));
    return input;
  };
  return clean(value) as Value;
}
export interface AuditInput { category: string; day: number; round: number; attemptId?: string; factionId?: string; systemId?: string; data: unknown }
export interface AuditRecord extends AuditInput { seq: number; time: string; previousHash: string; hash: string }
export type AuditCallback = (category: string, data: unknown) => Promise<void>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function readJournal(path: string, include: (record:AuditRecord)=>boolean = ()=>true): Promise<AuditRecord[]> {
  let size=0;
  try {const handle=await open(path,'r');try{size=(await handle.stat()).size;if(size){const tail=Buffer.alloc(1);await handle.read(tail,0,1,size-1);if(tail[0]!==10)throw new Error('审计日志尾部不完整，请保留文件检查；比赛已停止');}}finally{await handle.close();}}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
  if(!size)return [];
  const stream=createReadStream(path,{encoding:'utf8',end:size-1}),lines=createInterface({input:stream,crlfDelay:Infinity}),records:AuditRecord[]=[];
  let previousHash='',seq=0;
  try{for await(const line of lines){if(!line)continue;const record=JSON.parse(line) as AuditRecord;const {hash,...body}=record;
    if(record.seq!==++seq||record.previousHash!==previousHash||digest(body)!==hash)throw new Error(`审计日志哈希链损坏，序号 ${seq}`);
    previousHash=hash;if(include(record))records.push(record);
  }}finally{lines.close();stream.destroy();}
  return records;
}

export class AuditJournal {
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private hash = '';
  private initialized = false;
  constructor(readonly path: string) {}
  async append(input: AuditInput): Promise<AuditRecord> { return (await this.appendMany([input]))[0]; }
  appendMany(inputs: AuditInput[]): Promise<AuditRecord[]> {
    const operation = this.queue.then(async () => {
      if (!this.initialized) {
        let last:AuditRecord|undefined;await readJournal(this.path,record=>{last=record;return false;});
        this.seq = last?.seq??0; this.hash = last?.hash ?? ''; this.initialized = true;
      }
      let sequence = this.seq;
      let previousHash = this.hash;
      const records = inputs.map(input => {
        const body = { ...sanitize(input), seq: ++sequence, time: new Date().toISOString(), previousHash };
        const record = { ...body, hash: digest(body) };
        previousHash = record.hash;
        return record;
      });
      const handle = await open(this.path, 'a');
      try { await handle.writeFile(records.map(record => JSON.stringify(record) + '\n').join(''), 'utf8'); await handle.sync(); } finally { await handle.close(); }
      this.seq = sequence; this.hash = previousHash;
      return records;
    });
    this.queue = operation;
    return operation;
  }
  read(include?: (record:AuditRecord)=>boolean): Promise<AuditRecord[]> {
    const operation = this.queue.then(() => readJournal(this.path,include));
    this.queue = operation;
    return operation;
  }
  async flush() { await this.queue; }
  snapshotSize(): Promise<number | null> {
    const operation = this.queue.then(async () => {
      await readJournal(this.path, () => false);
      let handle;
      try {
        handle = await open(this.path, 'r');
        return (await handle.stat()).size;
      } catch(error) {
        if((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      } finally { await handle?.close(); }
    });
    this.queue = operation;
    return operation;
  }
}
