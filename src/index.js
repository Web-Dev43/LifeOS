import { sendPushNotification } from "@mmmike/web-push/send";
import { generateVapidKeys } from "@mmmike/web-push/vapid";

const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8"}});
function corsHeaders(){return {"access-control-allow-origin":"*","access-control-allow-methods":"GET,POST,PATCH,DELETE,OPTIONS","access-control-allow-headers":"content-type"}}
function jsonCors(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8",...corsHeaders()}})}
function deviceIdFrom(request,body){return String(request.headers.get("x-device-id")||body?.deviceId||"").trim().slice(0,120)}
function smartPriority(title,dueDate){
 const text=String(title||"").toLowerCase().replace(/\s+/g," ").trim();
 const due=new Date(dueDate+"T23:59:59"), now=new Date();
 const days=Math.ceil((due-now)/86400000);

 // Urgency comes from the deadline. Importance comes from what the user says.
 let urgency=days<0?6:days<=0?5:days===1?4:days<=3?3:days<=7?1:0;
 const high=["exam","test","final","quiz","midterm","project","presentation","application","interview","deadline","essay","report","paper","payment","bill","appointment","meeting","urgent","critical","asap","must do","must-do","very important"];
 const low=["optional","extra credit","when you can","someday","practice","not important","unimportant","not urgent","low priority","doesn't matter","does not matter","not critical","not urgent"];
 const hasLow=low.some(s=>text.includes(s));
 const hasHigh=high.some(s=>text.includes(s));

 // Explicit "not important" style language wins over generic importance.
 let importance=hasLow?-3:hasHigh?2:0;
 let score=urgency+importance;

 // A clearly urgent task should never become low just because it says "not important".
 if((text.includes("urgent")||text.includes("asap")||text.includes("critical")) && score<3)score=3;

 return score>=6?"high":score>=3?"medium":"low";
}
function dateInTimeZone(date,timeZone){return new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit"}).format(date)}
function hourInTimeZone(date,timeZone){return Number(new Intl.DateTimeFormat("en-US",{timeZone,hour:"2-digit",hour12:false}).format(date))}
async function getVapid(env){
 const existing=await env.DB.prepare("SELECT public_key, private_key FROM vapid_keys WHERE id = 1").first();
 if(existing)return {subject:"mailto:lifeos@example.com",publicKey:existing.public_key,privateKey:existing.private_key};
 const keys=await generateVapidKeys();
 await env.DB.prepare("INSERT OR IGNORE INTO vapid_keys (id, public_key, private_key) VALUES (1, ?, ?)").bind(keys.publicKey,keys.privateKey).run();
 const saved=await env.DB.prepare("SELECT public_key, private_key FROM vapid_keys WHERE id = 1").first();
 return {subject:"mailto:lifeos@example.com",publicKey:saved.public_key,privateKey:saved.private_key};
}
async function sendToSubscription(env,row,payload){
 const v=await getVapid(env);
 return sendPushNotification({endpoint:row.endpoint,keys:{p256dh:row.p256dh,auth:row.auth},expirationTime:null},payload,v,{ttl:86400,urgency:"normal"});
}
function isDeadPushSubscription(error){
 const status=Number(error?.status||error?.response?.status||0);
 return status===404||status===410||/\b(?:404|410)\b/.test(String(error?.message||""));
}
async function removePushSubscription(env,endpoint){
 try{await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint=?").bind(endpoint).run()}catch(error){console.error("Push subscription cleanup failed",error?.message||error)}
}
async function runReminderSweep(env){
 const now=new Date(),subs=await env.DB.prepare("SELECT id,device_id,endpoint,p256dh,auth,timezone FROM push_subscriptions").all();
 for(const sub of subs.results||[]){
  let localDate,localHour;try{localDate=dateInTimeZone(now,sub.timezone||"UTC");localHour=hourInTimeZone(now,sub.timezone||"UTC")}catch{localDate=dateInTimeZone(now,"UTC");localHour=hourInTimeZone(now,"UTC")}
  if(![9,18].includes(localHour))continue;
  const target=new Date(now);target.setUTCDate(target.getUTCDate()+(localHour===9?1:0));
  const tomorrow=dateInTimeZone(target,sub.timezone||"UTC");
  const tasks=await env.DB.prepare("SELECT id,title,due_date,priority,priority_auto FROM tasks WHERE device_id=? AND completed=0 AND due_date<=? ORDER BY due_date ASC,id DESC LIMIT 3").bind(sub.device_id,tomorrow).all();
  for(const task of tasks.results||[]){
   const priority=task.priority_auto?smartPriority(task.title,task.due_date):task.priority;
   const kind=task.due_date<localDate?"overdue":task.due_date===localDate?"due-today":"due-tomorrow";
   const already=await env.DB.prepare("SELECT id FROM notification_log WHERE subscription_id=? AND task_id=? AND kind=? AND reminder_date=? LIMIT 1").bind(sub.id,task.id,kind,localDate).first();
   if(already)continue;
   const title=kind==="overdue"?"You’ve got an overdue task":kind==="due-today"?"Due today":"Due tomorrow";
   const body=kind==="overdue"?task.title+" is overdue. Want to knock it out today?":kind==="due-today"?task.title+" is due today. Start with a small step now.":task.title+" is due tomorrow. A little progress today beats the midnight boss battle.";
   try{
    const delivered=await sendToSubscription(env,sub,{title,body,url:"/?tool=deadline",tag:"task-"+task.id+"-"+kind});
    if(delivered!==false)await env.DB.prepare("INSERT OR IGNORE INTO notification_log (subscription_id,task_id,kind,reminder_date) VALUES (?,?,?,?)").bind(sub.id,task.id,kind,localDate).run();
   }catch(e){
    console.error("Push send failed",e?.message||e);
    if(isDeadPushSubscription(e))await removePushSubscription(env,sub.endpoint);
   }
  }
 }
}
function buildPlan(tasks,timeZone="UTC"){
 const now=new Date(), localDate=dateInTimeZone(now,timeZone), localHour=hourInTimeZone(now,timeZone);
 const parts=new Intl.DateTimeFormat("en-US",{timeZone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).formatToParts(now);
 const get=n=>Number(parts.find(p=>p.type===n)?.value||0);
 let year=get("year"),month=get("month"),day=get("day"),hour=get("hour"),minute=get("minute");
 let cursorMinutes=hour*60+minute;
 cursorMinutes=Math.ceil(cursorMinutes/5)*5;
 const endToday=22*60;
 const open=tasks.filter(t=>!t.completed).map(t=>{
  const due=new Date(t.due_date+"T23:59:59"),days=Math.ceil((due-now)/86400000),priority=t.priority_auto?smartPriority(t.title,t.due_date):t.priority;
  const urgency=days<0?100:days===0?90:days===1?80:days<=3?65:days<=7?40:20;
  const importance=priority==="high"?30:priority==="medium"?18:8;
  const score=urgency+importance;
  const minutes=priority==="high"?30:priority==="medium"?20:15;
  const reason=days<0?"Overdue":days===0?"Due today":days===1?"Due tomorrow":days<=3?"Due soon":priority==="high"?"Important":"Can wait";
  return {...t,priority,days,minutes,score,reason};
 }).sort((a,b)=>b.score-a.score||a.due_date.localeCompare(b.due_date));
 const items=[];
 let dayOffset=0;
 for(const task of open.slice(0,5)){
  if(dayOffset===0 && cursorMinutes+task.minutes>endToday){dayOffset=1;cursorMinutes=9*60}
  if(dayOffset===1 && task.days<1) continue;
  const total=cursorMinutes, hh=Math.floor(total/60), mm=total%60;
  const date=new Date(Date.UTC(year,month-1,day+dayOffset));
  const scheduledDate=date.toISOString().slice(0,10);
  const scheduledTime=String(hh).padStart(2,"0")+":"+String(mm).padStart(2,"0");
  items.push({...task,scheduledDate,scheduledTime,scheduledLabel:new Intl.DateTimeFormat("en-US",{timeZone:"UTC",month:"short",day:"numeric"}).format(date)});
  cursorMinutes+=task.minutes+5;
 }
 return {items,totalMinutes:items.reduce((n,t)=>n+t.minutes,0),timeZone,localDate,currentTime:now.toISOString()};
}
export default{
 async fetch(request,env){
  const url=new URL(request.url);
  if(request.method==="OPTIONS")return new Response(null,{status:204,headers:corsHeaders()});
  if(url.pathname.startsWith("/api/")){
   try{
    if(request.method==="GET"&&url.pathname==="/api/push/config"){const v=await getVapid(env);return jsonCors({publicKey:v.publicKey})}
    if(request.method==="POST"&&url.pathname==="/api/push/subscribe"){const body=await request.json(),deviceId=deviceIdFrom(request,body),sub=body.subscription||body,endpoint=String(sub?.endpoint||"").trim(),p256dh=String(sub?.keys?.p256dh||"").trim(),auth=String(sub?.keys?.auth||"").trim(),timezone=String(body.timezone||"UTC").trim();if(!deviceId||!endpoint||!p256dh||!auth)return jsonCors({error:"Invalid push subscription."},400);await env.DB.prepare("INSERT INTO push_subscriptions (device_id,endpoint,p256dh,auth,timezone) VALUES (?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET device_id=excluded.device_id,p256dh=excluded.p256dh,auth=excluded.auth,timezone=excluded.timezone,updated_at=CURRENT_TIMESTAMP").bind(deviceId,endpoint,p256dh,auth,timezone).run();return jsonCors({ok:true})}
    if(request.method==="DELETE"&&url.pathname==="/api/push/subscribe"){const body=await request.json();const endpoint=String(body.endpoint||"").trim();if(endpoint)await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint=?").bind(endpoint).run();return jsonCors({ok:true})}
    if(request.method==="POST"&&url.pathname==="/api/push/test"){
      const body=await request.json(),deviceId=deviceIdFrom(request,body);
      const {results}=await env.DB.prepare("SELECT id,endpoint,p256dh,auth FROM push_subscriptions WHERE device_id=?").bind(deviceId).all();
      if(!(results||[]).length)return jsonCors({error:"No active phone subscription."},404);
      let delivered=0,failed=0;
      for(const sub of results||[]){
        try{
          const ok=await sendToSubscription(env,sub,{title:"LifeOS is locked in 🔔",body:"Notifications are working. We’ll remind you when it actually matters.",url:"/?tool=deadline",tag:"lifeos-test"});
          if(ok!==false)delivered++;else failed++;
        }catch(e){
          failed++;
          console.error("Test push failed",e?.message||e);
          if(isDeadPushSubscription(e))await removePushSubscription(env,sub.endpoint);
        }
      }
      return jsonCors({ok:delivered>0,delivered,failed},delivered>0?200:503);
    }
    if(request.method==="GET"&&url.pathname==="/api/tasks"){const deviceId=String(url.searchParams.get("deviceId")||"").trim(),q=deviceId?"SELECT id,title,due_date,priority,priority_auto,completed,created_at FROM tasks WHERE device_id=? ORDER BY completed ASC,due_date ASC,id DESC":"SELECT id,title,due_date,priority,priority_auto,completed,created_at FROM tasks ORDER BY completed ASC,due_date ASC,id DESC",stmt=deviceId?env.DB.prepare(q).bind(deviceId):env.DB.prepare(q),{results}=await stmt.all();return jsonCors({tasks:(results||[]).map(t=>t.priority_auto?{...t,priority:smartPriority(t.title,t.due_date)}:t)})}
    if(request.method==="GET"&&url.pathname==="/api/plan"){const deviceId=String(url.searchParams.get("deviceId")||"").trim(),timeZone=String(url.searchParams.get("timeZone")||"UTC").trim();if(!deviceId)return jsonCors({error:"Device ID required."},400);const {results}=await env.DB.prepare("SELECT id,title,due_date,priority,priority_auto,completed FROM tasks WHERE device_id=? AND completed=0").bind(deviceId).all();return jsonCors(buildPlan(results||[],timeZone))}
    if(request.method==="POST"&&url.pathname==="/api/tasks"){const body=await request.json(),title=String(body.title||"").trim(),dueDate=String(body.dueDate||"").trim(),deviceId=deviceIdFrom(request,body);if(!title||!dueDate||!deviceId)return jsonCors({error:"Task details are required."},400);const p=smartPriority(title,dueDate);const result=await env.DB.prepare("INSERT INTO tasks (title,due_date,priority,priority_auto,device_id) VALUES (?,?,?,?,?)").bind(title,dueDate,p,1,deviceId).run();return jsonCors({id:result.meta.last_row_id},201)}
    const id=Number(url.pathname.split("/").pop());
    if(request.method==="PATCH"&&url.pathname.startsWith("/api/tasks/")&&Number.isInteger(id)){const body=await request.json(),deviceId=deviceIdFrom(request,body),updates=[],values=[];if(typeof body.completed!=="undefined"){updates.push("completed=?");values.push(body.completed?1:0)}if(body.priorityAuto===true)updates.push("priority_auto=1");else if(["low","medium","high"].includes(body.priority)){updates.push("priority=?,priority_auto=0");values.push(body.priority)}if(updates.length){values.push(id,deviceId);await env.DB.prepare("UPDATE tasks SET "+updates.join(", ")+" WHERE id=? AND device_id=?").bind(...values).run()}if(body.priorityAuto===true){const task=await env.DB.prepare("SELECT title,due_date FROM tasks WHERE id=? AND device_id=?").bind(id,deviceId).first();if(task)await env.DB.prepare("UPDATE tasks SET priority=? WHERE id=? AND device_id=?").bind(smartPriority(task.title,task.due_date),id,deviceId).run()}return jsonCors({ok:true})}
    if(request.method==="DELETE"&&url.pathname.startsWith("/api/tasks/")&&Number.isInteger(id)){const body=await request.json().catch(()=>({})),deviceId=deviceIdFrom(request,body);await env.DB.prepare("DELETE FROM tasks WHERE id=? AND device_id=?").bind(id,deviceId).run();return jsonCors({ok:true})}
    return jsonCors({error:"Not found"},404)
   }catch(error){console.error(error);return jsonCors({error:"Something went wrong.",detail:error.message},500)}
  }
  return env.ASSETS.fetch(request)
 },
 async scheduled(controller,env,ctx){ctx.waitUntil(runReminderSweep(env))}
};