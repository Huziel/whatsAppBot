export type DeliveryResult =
  | { status:'sent'; externalId:string; attempts:number }
  | { status:'uncertain'; attempts:number }

export async function deliverWithStableId(
  messageId:string,
  send:(messageId:string)=>Promise<{ id:string|null }>,
  options:{ maxAttempts?:number; retryDelayMs?:number; sleep?:(ms:number)=>Promise<void> }={},
):Promise<DeliveryResult>{
  const maxAttempts=Math.max(1,Math.min(5,options.maxAttempts??2))
  const sleep=options.sleep??(ms=>new Promise<void>(resolve=>setTimeout(resolve,ms)))
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    try{const result=await send(messageId);if(result.id)return {status:'sent',externalId:result.id,attempts:attempt}}catch{/* An error may occur after WhatsApp accepted the stable message ID. */}
    if(attempt<maxAttempts)await sleep(options.retryDelayMs??500)
  }
  return {status:'uncertain',attempts:maxAttempts}
}
