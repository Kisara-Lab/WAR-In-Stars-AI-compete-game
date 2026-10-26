import { readdir, readFile, access } from 'node:fs/promises';
import { dirname, join, resolve, relative, sep } from 'node:path';

const root=process.cwd(), files=[];
async function walk(dir){
 for(const entry of await readdir(dir,{withFileTypes:true})){
  if(['node_modules','dist','.data','.git','test-results','coverage','playwright-report'].includes(entry.name))continue;
  const path=join(dir,entry.name);
  if(entry.isDirectory())await walk(path);else if(path.endsWith('.md'))files.push(path);
 }
}
await walk(root);
const errors=[];
for(const file of files){
 const markdown=(await readFile(file,'utf8')).replace(/```[\s\S]*?```/g,'');
 for(const match of markdown.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g)){
  const link=match[1].split(/\s+"/)[0].replace(/^<|>$/g,'');
  if(/^(https?:|mailto:|#)/i.test(link))continue;
  const path=decodeURIComponent(link.split('#')[0]);if(!path)continue;
  const target=resolve(dirname(file),path),rel=relative(root,target);
  if(rel==='..'||rel.startsWith('..'+sep)){errors.push(relative(root,file)+': link escapes repository');continue;}
  try{await access(target);}catch{errors.push(relative(root,file)+': missing '+link);}
 }
}
for(const path of ['README.md','README.en.md']){
 const value=await readFile(path,'utf8');
 if(!value.includes('8192')||!value.includes('48')||!value.includes('571'))errors.push(path+': current rules or case usage missing');
 if(/(?:C:[/\\]VSC|AI-Center|github_pat_|ghp_[A-Za-z0-9]{20})/.test(value))errors.push(path+': local or credential material found');
}
if(errors.length){console.error(errors.join('\n'));process.exitCode=1;}else console.log(`Checked local links in ${files.length} Markdown files and both README rule values.`);
