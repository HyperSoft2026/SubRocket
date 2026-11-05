const { Markup } = require("telegraf");
const userStates = new Map();
const adminStates = new Map();

async function migrateV3(pool) {
  const sql = [
    "ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'عام'",
    "ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ",
    "ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS paused BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS min_slots INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS max_slots INTEGER",
    "CREATE TABLE IF NOT EXISTS referrals (id BIGSERIAL PRIMARY KEY,referrer_id BIGINT NOT NULL REFERENCES users(telegram_id),referred_id BIGINT NOT NULL UNIQUE REFERENCES users(telegram_id),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),rewarded_at TIMESTAMPTZ,reward BIGINT NOT NULL DEFAULT 0 CHECK(reward>=0),CHECK(referrer_id<>referred_id))",
    "CREATE INDEX IF NOT EXISTS referrals_referrer_idx ON referrals(referrer_id,created_at DESC)",
    "CREATE TABLE IF NOT EXISTS notifications (id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES users(telegram_id),type TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,read_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id,created_at DESC)",
    "CREATE TABLE IF NOT EXISTS reward_coupons (id BIGSERIAL PRIMARY KEY,code TEXT NOT NULL UNIQUE,points BIGINT NOT NULL CHECK(points>0),max_uses INTEGER NOT NULL CHECK(max_uses>0),uses INTEGER NOT NULL DEFAULT 0 CHECK(uses>=0),expires_at TIMESTAMPTZ,active BOOLEAN NOT NULL DEFAULT TRUE,created_by BIGINT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS coupon_redemptions (id BIGSERIAL PRIMARY KEY,coupon_id BIGINT NOT NULL REFERENCES reward_coupons(id),user_id BIGINT NOT NULL REFERENCES users(telegram_id),points BIGINT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(coupon_id,user_id))",
    "CREATE TABLE IF NOT EXISTS user_achievements (user_id BIGINT NOT NULL REFERENCES users(telegram_id),achievement_key TEXT NOT NULL,awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(user_id,achievement_key))",
    "CREATE TABLE IF NOT EXISTS admin_audit_log (id BIGSERIAL PRIMARY KEY,admin_id BIGINT NOT NULL,action TEXT NOT NULL,target_id BIGINT,details JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS support_tickets (id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES users(telegram_id),message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','answered','closed')),admin_reply TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE INDEX IF NOT EXISTS support_tickets_status_idx ON support_tickets(status,created_at DESC)"
  ];
  for (const q of sql) await pool.query(q);
  await pool.query("INSERT INTO bot_settings(key,value) VALUES ('referral_reward','50') ON CONFLICT(key) DO NOTHING");
}
function menu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("💎 المحفظة","v3:wallet"),Markup.button.callback("🏆 المتصدرون","v3:leaders:all")],
    [Markup.button.callback("🎖️ إنجازاتي","v3:achievements"),Markup.button.callback("🎁 استرداد كود","v3:coupon")],
    [Markup.button.callback("🤝 دعوة الأصدقاء","v3:referrals"),Markup.button.callback("🔔 إشعاراتي","v3:notifications")],
    [Markup.button.callback("🎧 الدعم الفني","v3:support"),Markup.button.callback("⬅️ الرئيسية","home")]
  ]);
}
async function setting(pool,key,fallback) {
  const r=await pool.query("SELECT value FROM bot_settings WHERE key=$1",[key]);
  return r.rowCount?r.rows[0].value:fallback;
}
async function applyReferralOnStart(pool,userId,payload) {
  if(!payload||!/^REF[A-Za-z0-9_-]{1,32}$/.test(payload))return false;
  let referrer;
  try{referrer=BigInt(parseInt(payload.slice(3),36)).toString();}catch{return false;}
  if(!/^\d+$/.test(referrer)||referrer===String(userId))return false;
  const c=await pool.connect();
  try{
    await c.query("BEGIN");
    const owner=await c.query("SELECT 1 FROM users WHERE telegram_id=$1",[referrer]);
    if(!owner.rowCount){await c.query("ROLLBACK");return false;}
    await c.query("INSERT INTO referrals(referrer_id,referred_id) VALUES($1,$2) ON CONFLICT(referred_id) DO NOTHING",[referrer,String(userId)]);
    await c.query("COMMIT");return true;
  }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
}
async function rewardReferral(client,pool,userId) {
  const r=await client.query("SELECT referrer_id FROM referrals WHERE referred_id=$1 AND rewarded_at IS NULL FOR UPDATE",[String(userId)]);
  if(!r.rowCount)return null;
  const reward=await setting(pool,"referral_reward","50");
  if(!/^\d+$/.test(reward)||BigInt(reward)<1n)return null;
  const referrer=String(r.rows[0].referrer_id);
  await client.query("UPDATE users SET points=points+$1,updated_at=NOW() WHERE telegram_id=$2",[reward,referrer]);
  await client.query("INSERT INTO points_ledger(user_id,amount,reason) VALUES($1,$2,'referral_reward')",[referrer,reward]);
  await client.query("UPDATE referrals SET rewarded_at=NOW(),reward=$1 WHERE referred_id=$2",[reward,String(userId)]);
  await client.query("INSERT INTO notifications(user_id,type,title,body) VALUES($1,'referral','مكافأة إحالة',$2)",[referrer,'تمت إضافة '+reward+' نقطة بعد تحقق أول اشتراك للمدعو']);
  return {referrer,reward};
}
async function wallet(ctx,pool) {
  const id=String(ctx.from.id);
  const r=await pool.query("SELECT u.points,COALESCE((SELECT SUM(amount) FROM points_ledger WHERE user_id=u.telegram_id AND amount>0),0)::text earned,COALESCE(-(SELECT SUM(amount) FROM points_ledger WHERE user_id=u.telegram_id AND amount<0),0)::text spent,(SELECT COUNT(*) FROM points_ledger WHERE user_id=u.telegram_id)::int tx FROM users u WHERE u.telegram_id=$1",[id]);
  const s=r.rows[0]||{points:0,earned:"0",spent:"0",tx:0};
  const tx=await pool.query("SELECT amount,reason,created_at FROM points_ledger WHERE user_id=$1 ORDER BY id DESC LIMIT 5",[id]);
  const lines=tx.rows.map(x=>(Number(x.amount)>0?"+":"")+x.amount+" · "+x.reason+" · "+new Date(x.created_at).toLocaleDateString("ar-IQ"));
  await ctx.reply("💎 محفظتك\n\n⭐ الرصيد: "+s.points+"\n📈 المكتسب: "+s.earned+"\n📉 المصروف: "+s.spent+"\n🧾 المعاملات: "+s.tx+"\n\nآخر الحركات:\n"+(lines.join("\n")||"لا توجد معاملات."),menu());
}
async function leaders(ctx,pool,period) {
  const f=period==="week"?"AND l.created_at>=NOW()-INTERVAL '7 days'":period==="month"?"AND l.created_at>=NOW()-INTERVAL '30 days'":"";
  const q=period==="all"?"SELECT telegram_id,first_name,points score FROM users WHERE is_banned=FALSE ORDER BY points DESC LIMIT 10":"SELECT u.telegram_id,u.first_name,COALESCE(SUM(l.amount),0)::text score FROM users u LEFT JOIN points_ledger l ON l.user_id=u.telegram_id "+f+" WHERE u.is_banned=FALSE GROUP BY u.telegram_id ORDER BY SUM(l.amount) DESC NULLS LAST LIMIT 10";
  const r=await pool.query(q);
  const lines=r.rows.map((u,i)=>(i+1)+". "+(u.first_name||"مستخدم")+" — "+u.score+" نقطة"+(String(u.telegram_id)===String(ctx.from.id)?" 👈":""));
  await ctx.reply("🏆 المتصدرون\n\n"+(lines.join("\n")||"لا توجد نتائج.") ,Markup.inlineKeyboard([
    [Markup.button.callback("الكل","v3:leaders:all"),Markup.button.callback("أسبوعي","v3:leaders:week"),Markup.button.callback("شهري","v3:leaders:month")],
    [Markup.button.callback("⬅️ القائمة","v3:menu")]
  ]));
}
async function achievements(ctx,pool) {
  const id=String(ctx.from.id);
  const r=await pool.query("SELECT points,(SELECT COUNT(*) FROM campaign_claims WHERE user_id=$1)::int claims FROM users WHERE telegram_id=$1",[id]);
  const u=r.rows[0]||{points:0,claims:0};
  const level=Number(u.points)>=5000?"أسطوري":Number(u.points)>=2000?"محترف":Number(u.points)>=500?"نشيط":"مبتدئ";
  const list=[["first","أول اشتراك متحقق",1],["ten","جامع الحملات",10],["fifty","خبير الحملات",50]];
  const earned=[];
  for(const [key,label,n] of list)if(Number(u.claims)>=n){await pool.query("INSERT INTO user_achievements(user_id,achievement_key) VALUES($1,$2) ON CONFLICT DO NOTHING",[id,key]);earned.push("🏅 "+label);}
  await ctx.reply("🎖️ إنجازاتك\n\nالمستوى: "+level+"\nالنقاط: "+u.points+"\nالحملات المكتملة: "+u.claims+"\n\n"+(earned.join("\n")||"أكمل حملاتك لتحصل على شارات."),menu());
}
async function notifications(ctx,pool) {
  const r=await pool.query("SELECT title,body FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 10",[String(ctx.from.id)]);
  await pool.query("UPDATE notifications SET read_at=NOW() WHERE user_id=$1 AND read_at IS NULL",[String(ctx.from.id)]);
  await ctx.reply("🔔 مركز الإشعارات\n\n"+(r.rows.map(x=>"• "+x.title+"\n"+x.body).join("\n\n")||"لا توجد إشعارات."),menu());
}
async function handleText(ctx,pool,adminId,bot) {
  const id=String(ctx.from.id),input=(ctx.message.text||"").trim();
  if(id===String(adminId)&&adminStates.has(id)){
    if(input==="إلغاء"){adminStates.delete(id);await ctx.reply("تم الإلغاء.");return true;}
    if(state.type==="support_reply"){
      if(input.length>3000){await ctx.reply("الحد الأقصى 3000 حرف.");return true;}
      const r=await pool.query("UPDATE support_tickets SET admin_reply=$1,status='answered',updated_at=NOW() WHERE id=$2 RETURNING user_id",[input,state.ticketId]);
      if(!r.rowCount){adminStates.delete(id);await ctx.reply("التذكرة غير موجودة.");return true;}
      await pool.query("INSERT INTO admin_audit_log(admin_id,action,target_id,details) VALUES($1,'support_reply',$2,$3::jsonb)",[id,state.ticketId,JSON.stringify({reply_length:input.length})]);
      await pool.query("INSERT INTO notifications(user_id,type,title,body) VALUES($1,'support',$2,$3)",[String(r.rows[0].user_id),"رد على تذكرتك #"+state.ticketId,input]);
      await bot.telegram.sendMessage(String(r.rows[0].user_id),"🎧 رد فريق الدعم على تذكرتك #"+state.ticketId+":\n\n"+input).catch(()=>{});
      adminStates.delete(id);await ctx.reply("تم إرسال الرد للمستخدم.");return true;
    }
    const p=input.split(/\s+/);
    if(p.length!==3||!/^[A-Z0-9_-]{4,32}$/i.test(p[0])||!/^\d+$/.test(p[1])||!/^\d+$/.test(p[2])||Number(p[1])<1||Number(p[2])<1||Number(p[2])>100000){await ctx.reply("الصيغة: CODE POINTS MAX_USES\nمثال: ROCKET100 100 50");return true;}
    await pool.query("INSERT INTO reward_coupons(code,points,max_uses,created_by) VALUES($1,$2,$3,$4)",[p[0].toUpperCase(),p[1],Number(p[2]),id]);
    await pool.query("INSERT INTO admin_audit_log(admin_id,action,details) VALUES($1,'coupon_create',$2::jsonb)",[id,JSON.stringify({code:p[0].toUpperCase(),points:p[1],max_uses:Number(p[2])})]);
    adminStates.delete(id);await ctx.reply("تم إنشاء الكوبون "+p[0].toUpperCase());return true;
  }
  const state=userStates.get(id);if(!state)return false;
  if(input==="إلغاء"){userStates.delete(id);await ctx.reply("تم الإلغاء.");return true;}
  if(state==="coupon"){
    if(!/^[A-Z0-9_-]{4,32}$/i.test(input)){await ctx.reply("الكود غير صحيح.");return true;}
    const c=await pool.connect();
    try{
      await c.query("BEGIN");
      const r=await c.query("SELECT * FROM reward_coupons WHERE code=$1 AND active=TRUE AND (expires_at IS NULL OR expires_at>NOW()) AND uses<max_uses FOR UPDATE",[input.toUpperCase()]);
      if(!r.rowCount){await c.query("ROLLBACK");userStates.delete(id);await ctx.reply("الكود غير صالح أو منتهي أو مستنفد.");return true;}
      const x=r.rows[0];
      await c.query("INSERT INTO coupon_redemptions(coupon_id,user_id,points) VALUES($1,$2,$3)",[x.id,id,x.points]);
      await c.query("UPDATE reward_coupons SET uses=uses+1 WHERE id=$1",[x.id]);
      await c.query("UPDATE users SET points=points+$1,updated_at=NOW() WHERE telegram_id=$2",[x.points,id]);
      await c.query("INSERT INTO points_ledger(user_id,amount,reason,reference_id) VALUES($1,$2,'coupon_reward',$3)",[id,x.points,x.id]);
      await c.query("COMMIT");userStates.delete(id);await ctx.reply("🎁 تم استرداد الكود وإضافة "+x.points+" نقطة.");
    }catch(e){await c.query("ROLLBACK");if(e.code==="23505"){userStates.delete(id);await ctx.reply("سبق واسترددت هذا الكود.");}else throw e;}finally{c.release();}
    return true;
  }
  if(state==="support"){
    if(input.length<5||input.length>3000){await ctx.reply("اكتب تفاصيل من 5 إلى 3000 حرف.");return true;}
    const r=await pool.query("INSERT INTO support_tickets(user_id,message) VALUES($1,$2) RETURNING id",[id,input]);
    userStates.delete(id);await ctx.reply("🎧 استلمنا تذكرتك رقم #"+r.rows[0].id+".");return true;
  }
  return false;
}
function installV3(bot,pool,adminId){
  bot.action("v3:menu",async c=>{await c.answerCbQuery();await c.reply("مركز SubRocket 🚀",menu());});
  bot.action("v3:wallet",async c=>{await c.answerCbQuery();await wallet(c,pool);});
  bot.action(/^v3:leaders:(all|week|month)$/,async c=>{await c.answerCbQuery();await leaders(c,pool,c.match[1]);});
  bot.action("v3:achievements",async c=>{await c.answerCbQuery();await achievements(c,pool);});
  bot.action("v3:notifications",async c=>{await c.answerCbQuery();await notifications(c,pool);});
  bot.action("v3:referrals",async c=>{
    await c.answerCbQuery();
    const username=(await bot.telegram.getMe()).username;
    const code="REF"+BigInt(c.from.id).toString(36);
    const r=await pool.query("SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE rewarded_at IS NOT NULL)::int paid FROM referrals WHERE referrer_id=$1",[String(c.from.id)]);
    await c.reply("🤝 رابط دعوتك:\nhttps://t.me/"+username+"?start="+code+"\n\nإجمالي الدعوات: "+r.rows[0].total+"\nالمكافآت المؤهلة: "+r.rows[0].paid+"\nتُمنح المكافأة بعد أول اشتراك حقيقي متحقق للمدعو.",menu());
  });
  bot.action("v3:coupon",async c=>{await c.answerCbQuery();userStates.set(String(c.from.id),"coupon");await c.reply("🎁 أرسل كود المكافأة أو اكتب إلغاء.");});
  bot.action("v3:support",async c=>{await c.answerCbQuery();userStates.set(String(c.from.id),"support");await c.reply("🎧 اكتب استفسارك أو شكواك (5–3000 حرف). للإلغاء اكتب إلغاء.");});

  bot.action("v3:admin_tickets",async c=>{
    if(String(c.from.id)!==String(adminId)){await c.answerCbQuery().catch(()=>{});return;}
    await c.answerCbQuery();
    const r=await pool.query("SELECT id,user_id,message,status,created_at FROM support_tickets WHERE status<>'closed' ORDER BY created_at ASC LIMIT 20");
    if(!r.rowCount){await c.reply("🎧 لا توجد تذاكر مفتوحة حالياً.",Markup.inlineKeyboard([[Markup.button.callback("⬅️ لوحة المدير","adm:home")]]));return;}
    const rows=r.rows.map(t=>[Markup.button.callback("#"+t.id+" · "+t.status+" · "+String(t.message).slice(0,24),"v3:ticket:"+t.id)]);
    rows.push([Markup.button.callback("⬅️ لوحة المدير","adm:home")]);
    await c.reply("🎧 تذاكر الدعم المفتوحة ("+r.rowCount+")",Markup.inlineKeyboard(rows));
  });
  bot.action(/^v3:ticket:(\d+)$/,async c=>{
    if(String(c.from.id)!==String(adminId)){await c.answerCbQuery().catch(()=>{});return;}
    await c.answerCbQuery();
    const r=await pool.query("SELECT * FROM support_tickets WHERE id=$1",[c.match[1]]);
    if(!r.rowCount){await c.reply("التذكرة غير موجودة.");return;}
    const t=r.rows[0];
    await c.reply("🎧 التذكرة #"+t.id+"\nالمستخدم: "+t.user_id+"\nالحالة: "+t.status+"\nالتاريخ: "+new Date(t.created_at).toLocaleString("ar-IQ")+"\n\nالرسالة:\n"+t.message+(t.admin_reply?"\n\nآخر رد:\n"+t.admin_reply:""),Markup.inlineKeyboard([
      [Markup.button.callback("✉️ الرد على التذكرة","v3:ticket_reply:"+t.id)],
      [Markup.button.callback("🔒 إغلاق التذكرة","v3:ticket_close:"+t.id)],
      [Markup.button.callback("⬅️ قائمة التذاكر","v3:admin_tickets")]
    ]));
  });
  bot.action(/^v3:ticket_reply:(\d+)$/,async c=>{
    if(String(c.from.id)!==String(adminId)){await c.answerCbQuery().catch(()=>{});return;}
    await c.answerCbQuery();adminStates.set(String(adminId),{type:"support_reply",ticketId:Number(c.match[1])});
    await c.reply("أرسل ردك على التذكرة #"+c.match[1]+". للإلغاء أرسل إلغاء.");
  });
  bot.action(/^v3:ticket_close:(\d+)$/,async c=>{
    if(String(c.from.id)!==String(adminId)){await c.answerCbQuery().catch(()=>{});return;}
    await c.answerCbQuery();
    const r=await pool.query("UPDATE support_tickets SET status='closed',updated_at=NOW() WHERE id=$1 RETURNING user_id",[c.match[1]]);
    if(r.rowCount){await pool.query("INSERT INTO admin_audit_log(admin_id,action,target_id) VALUES($1,'support_close',$2)",[adminId,Number(c.match[1])]);await pool.query("INSERT INTO notifications(user_id,type,title,body) VALUES($1,'support',$2,$3)",[String(r.rows[0].user_id),"تم إغلاق تذكرتك #"+c.match[1],"تم إغلاق طلب الدعم الخاص بك."]);}
    await c.reply(r.rowCount?"🔒 تم إغلاق التذكرة.":"التذكرة غير موجودة.");
  });

  bot.action("v3:admin_coupon",async c=>{if(String(c.from.id)!==String(adminId)){await c.answerCbQuery().catch(()=>{});return;}await c.answerCbQuery();adminStates.set(String(adminId),"coupon");await c.reply("أرسل: CODE POINTS MAX_USES\nمثال: ROCKET100 100 50\nللإلغاء: إلغاء");});
  bot.handleText=c=>handleText(c,pool,adminId,bot);
}
module.exports={migrateV3,installV3,applyReferralOnStart,rewardReferral,menu};
