import { serialize } from 'node:v8';

export class PlanningCache<T> {
  private entries=new Map<string,{value:T;bytes:number}>();
  bytes=0;
  hits=0;
  misses=0;
  evictions=0;
  constructor(readonly limitBytes:number) {}
  get(key:string) {
    const entry=this.entries.get(key);
    if(!entry){this.misses++;return undefined;}
    this.hits++;this.entries.delete(key);this.entries.set(key,entry);return entry.value;
  }
  set(key:string,value:T) {
    const bytes=serialize(value).byteLength+Buffer.byteLength(key);
    const old=this.entries.get(key);if(old){this.bytes-=old.bytes;this.entries.delete(key);}
    if(bytes>this.limitBytes)return;
    while(this.bytes+bytes>this.limitBytes&&this.entries.size) {
      const first=this.entries.keys().next().value!;
      this.bytes-=this.entries.get(first)!.bytes;this.entries.delete(first);this.evictions++;
    }
    this.entries.set(key,{value,bytes});this.bytes+=bytes;
  }
  clear(){this.entries.clear();this.bytes=0;}
}
