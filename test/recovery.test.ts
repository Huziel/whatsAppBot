import test from 'node:test'
import assert from 'node:assert/strict'
import { recoverPaginated } from '../src/recovery'

test('recuperación pagina un backlog y limita concurrencia conservando orden por chat',async()=>{
  const items=Array.from({length:137},(_,index)=>({id:index+1,jid:`chat-${index%9}`}))
  let active=0,maxActive=0
  const byChat=new Map<string,number[]>()
  const stats=await recoverPaginated({throughId:items.length,pageSize:17,concurrency:3,
    loadPage:async(after,through,limit)=>{
      const page=items.filter(item=>item.id>after&&item.id<=through).slice(0,limit)
      return {items:page,nextCursor:page.at(-1)?.id??through,done:(page.at(-1)?.id??through)>=through}
    },
    process:async item=>{active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,1));const values=byChat.get(item.jid)??[];values.push(item.id);byChat.set(item.jid,values);active--},
  })
  assert.equal(stats.processed,137)
  assert.ok(stats.pages>1)
  assert.ok(maxActive<=3)
  for(const values of byChat.values())assert.deepEqual(values,[...values].sort((a,b)=>a-b))
})

test('recuperación no procesa dos veces un turno repetido y se detiene al abortar',async()=>{
  const controller=new AbortController(),processed:number[]=[],released:number[]=[]
  const stats=await recoverPaginated({throughId:5,pageSize:3,concurrency:1,signal:controller.signal,
    loadPage:async after=>after===0
      ?{items:[{id:1,jid:'a'},{id:1,jid:'a'},{id:2,jid:'a'}],nextCursor:2,done:false}
      :{items:[{id:3,jid:'b'},{id:4,jid:'b'}],nextCursor:4,done:false},
    process:async item=>{processed.push(item.id);if(item.id===2)controller.abort()},
    releaseSkipped:async item=>{released.push(item.id)},
  })
  assert.deepEqual(processed,[1,2])
  assert.deepEqual(released,[])
  assert.equal(stats.cancelled,true)
})

test('una nueva recuperación puede continuar después de cancelar la generación anterior',async()=>{
  const firstController=new AbortController(),first:number[]=[],released:number[]=[],second:number[]=[]
  const items=[{id:1,jid:'a'},{id:2,jid:'a'},{id:3,jid:'b'}]
  const loadPage=async(after:number,through:number,limit:number)=>{const page=items.filter(item=>item.id>after&&item.id<=through).slice(0,limit);return {items:page,nextCursor:page.at(-1)?.id??through,done:(page.at(-1)?.id??through)>=through}}
  await recoverPaginated({throughId:3,pageSize:3,concurrency:1,signal:firstController.signal,loadPage,releaseSkipped:async item=>{released.push(item.id)},process:async item=>{first.push(item.id);firstController.abort()}})
  await recoverPaginated({throughId:3,pageSize:2,concurrency:2,loadPage,process:async item=>{if(!first.includes(item.id))second.push(item.id)}})
  assert.deepEqual(first,[1])
  assert.deepEqual(released,[2,3])
  assert.deepEqual(second.sort((a,b)=>a-b),[2,3])
})

test('un turno fallido no libera la barrera antes de terminar los demás grupos',async()=>{
  const completed:number[]=[]
  const stats=await recoverPaginated({throughId:2,pageSize:2,concurrency:2,
    loadPage:async()=>({items:[{id:1,jid:'a'},{id:2,jid:'b'}],nextCursor:2,done:true}),
    process:async item=>{if(item.id===1)throw new Error('fallo aislado');await new Promise(resolve=>setTimeout(resolve,10));completed.push(item.id)},
  })
  assert.deepEqual(completed,[2]);assert.equal(stats.failed,1);assert.equal(stats.processed,1)
})
