export type DeliveryResult =
  | { status:'sent'; externalId:string; attempts:number }
  | { status:'uncertain'; attempts:number }

export async function deliverWithStableId(
  messageId:string,
  send:(messageId:string)=>Promise<{ id:string|null }>,
  options:{ maxAttempts?:number; retryDelayMs?:number; attemptTimeoutMs?:number; sleep?:(ms:number)=>Promise<void> }={},
):Promise<DeliveryResult>{
  // Ambiguous transport failures are not retried automatically: WhatsApp may
  // already have accepted the stable ID even when the acknowledgement was lost.
  const maxAttempts=Math.max(1,Math.min(5,options.maxAttempts??1))
  const sleep=options.sleep??(ms=>new Promise<void>(resolve=>setTimeout(resolve,ms)))
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    try{
      const timeoutMs=Math.max(1,Math.min(120_000,options.attemptTimeoutMs??30_000))
      let timer:NodeJS.Timeout|undefined
      const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('send_timeout')),timeoutMs);timer.unref()})
      const result=await Promise.race([send(messageId),timeout]).finally(()=>{if(timer)clearTimeout(timer)})
      if(result.id)return {status:'sent',externalId:result.id,attempts:attempt}
    }catch{/* An error may occur after WhatsApp accepted the stable message ID. */}
    if(attempt<maxAttempts)await sleep(options.retryDelayMs??500)
  }
  return {status:'uncertain',attempts:maxAttempts}
}
