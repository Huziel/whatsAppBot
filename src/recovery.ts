export interface RecoverableItem { id:number; jid:string }

export interface RecoveryPage<T extends RecoverableItem> {
  items:T[]
  nextCursor:number
  done:boolean
}

export interface RecoveryOptions<T extends RecoverableItem> {
  throughId:number
  pageSize?:number
  concurrency?:number
  signal?:AbortSignal
  loadPage:(afterId:number,throughId:number,limit:number)=>Promise<RecoveryPage<T>>
  process:(item:T)=>Promise<void>
  releaseSkipped?:(item:T)=>Promise<void>
}

export interface RecoveryStats { scanned:number;processed:number;failed:number;pages:number;cancelled:boolean }

async function runGroups<T extends RecoverableItem>(groups:T[][],concurrency:number,signal:AbortSignal|undefined,process:(item:T)=>Promise<void>,releaseSkipped?:(item:T)=>Promise<void>):Promise<{processed:number;failed:number}>{
  let next=0,processed=0,failed=0
  const worker=async()=>{
    while(next<groups.length){
      const group=groups[next++]
      for(const item of group){
        if(signal?.aborted){if(releaseSkipped)try{await releaseSkipped(item)}catch{failed++};continue}
        try{await process(item);processed++}catch{failed++}
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(concurrency,groups.length)},()=>worker()))
  return {processed,failed}
}

export async function recoverPaginated<T extends RecoverableItem>(options:RecoveryOptions<T>):Promise<RecoveryStats>{
  const pageSize=Math.max(1,Math.min(500,Math.floor(options.pageSize??100)))
  const concurrency=Math.max(1,Math.min(16,Math.floor(options.concurrency??4)))
  const seen=new Set<number>()
  let cursor=0,scanned=0,processed=0,failed=0,pages=0
  while(cursor<options.throughId&&!options.signal?.aborted){
    const page=await options.loadPage(cursor,options.throughId,pageSize)
    pages++
    if(page.nextCursor<=cursor&&!page.done)throw new Error('recovery_cursor_did_not_advance')
    cursor=page.nextCursor
    const groups=new Map<string,T[]>()
    for(const item of page.items){
      scanned++
      if(seen.has(item.id))continue
      seen.add(item.id)
      const group=groups.get(item.jid)??[]
      group.push(item);groups.set(item.jid,group)
    }
    for(const group of groups.values())group.sort((a,b)=>a.id-b.id)
    const batch=await runGroups([...groups.values()],concurrency,options.signal,options.process,options.releaseSkipped)
    processed+=batch.processed;failed+=batch.failed
    if(page.done)break
  }
  return {scanned,processed,failed,pages,cancelled:Boolean(options.signal?.aborted)}
}
