/** Lossless structural sharing of repeated objects. Values remain in the payload once.
 * References use explicit paths, not model-inferred abbreviations. No list truncation. */
export function compactDecisionInput(input: unknown) {
  const definitions: Record<string,unknown>={}, seen=new Map<string,string>();
  let count=0;
  const visit=(value:unknown):unknown=>{
    if(value===null||typeof value!=='object')return value;
    const serialized=JSON.stringify(value);
    if(serialized.length>=160) {
      const previous=seen.get(serialized);
      if(previous)return {$ref:`definitions.${previous}`};
    }
    const output=Array.isArray(value)?value.map(visit):Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).map(([k,v])=>[k,visit(v)]));
    // Only move repeated values to the dictionary on their second occurrence.
    if(serialized.length>=160) {const id=`d${count++}`;seen.set(serialized,id);definitions[id]=output;return {$ref:`definitions.${id}`};}
    return output;
  };
  const data=visit(input);
  // Inline entries referenced once. Keep reusable fleet/project/option facts with every timestamp.
  const uses=new Map<string,number>();
  const scan=(v:any)=>{if(!v||typeof v!=='object')return;if(v.$ref){uses.set(v.$ref,(uses.get(v.$ref)??0)+1);return;}Object.values(v).forEach(scan);};
  scan(data);Object.values(definitions).forEach(scan);
  const expand=(v:any):any=>{
    if(!v||typeof v!=='object')return v;
    if(v.$ref&&uses.get(v.$ref)===1)return expand(definitions[v.$ref.slice('definitions.'.length)]);
    return Array.isArray(v)?v.map(expand):Object.fromEntries(Object.entries(v).map(([k,x])=>[k,expand(x)]));
  };
  return {...expand(data),encoding:'共享对象通过$ref引用definitions；每个事实、目标、阻碍和日期均完整保留。不同时间的情报不合并为同一快照。',definitions:Object.fromEntries(Object.entries(definitions).filter(([k])=>(uses.get(`definitions.${k}`)??0)>1).map(([k,v])=>[k,expand(v)]))};
}
