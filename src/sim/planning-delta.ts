import { serialize } from 'node:v8';

export interface StateChange { path:(string|number)[];value?:unknown;remove?:true }
export function stateChanges(before:unknown,after:unknown,path:(string|number)[]=[]):StateChange[] {
  if(Object.is(before,after))return [];
  if(before===null||after===null||typeof before!=='object'||typeof after!=='object')return [{path,value:after}];
  if(serialize(before).equals(serialize(after)))return [];
  if(Array.isArray(before)!==Array.isArray(after)||Array.isArray(before)&&before.length!==(after as unknown[]).length)return [{path,value:after}];
  const first=before as Record<string,unknown>,second=after as Record<string,unknown>;
  return [...new Set([...Object.keys(first),...Object.keys(second)])].flatMap(key=>{
    const next=[...path,Array.isArray(before)?Number(key):key];
    if(!Object.hasOwn(second,key))return [{path:next,remove:true as const}];
    if(!Object.hasOwn(first,key))return [{path:next,value:second[key]}];
    return stateChanges(first[key],second[key],next);
  });
}
export function applyStateChanges<T>(original:T,changes:StateChange[]):T {
  let result:unknown=original;
  for(const change of changes) {
    const replace=(current:unknown,index:number):unknown=>{
      if(index===change.path.length)return change.value;
      const source=current as Record<string|number,unknown>,copy=Array.isArray(current)?[...current]:{...source},key=change.path[index];
      if(index===change.path.length-1&&change.remove)delete (copy as Record<string|number,unknown>)[key];
      else (copy as Record<string|number,unknown>)[key]=replace(source[key],index+1);
      return copy;
    };
    result=replace(result,0);
  }
  return result as T;
}
