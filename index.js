require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const { Pool } = require("pg");
const { migrateV3, installV3, applyReferralOnStart, rewardReferral } = require("./features-v3");
const { migrateV4 } = require("./platform-v4");
const { createCampaign, cancelCampaign, changeCampaignStatus } = require("./campaign-engine");
const { applyLedgerEntry, recordCampaignEvent } = require("./platform-v4");
const { startPlatformWorkers } = require("./platform-workers");

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminId = String(process.env.TELEGRAM_ADMIN_ID || "");
const databaseUrl = process.env.POSTGRESQL_ADDON_URI || process.env.DATABASE_URL;
if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!databaseUrl) throw new Error("Missing POSTGRESQL_ADDON_URI or DATABASE_URL");
if (!/^\d+$/.test(adminId)) throw new Error("TELEGRAM_ADMIN_ID must be a valid numeric Telegram user ID");

const pool = new Pool({ connectionString: databaseUrl, ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
const bot = new Telegraf(token);
const adminState = new Map();
const userState = new Map();
const DEFAULT_POINTS_PER_MEMBER = Math.max(1, Number.parseInt(process.env.POINTS_PER_MEMBER || "100", 10));

async function initializeDatabase() {
  const statements = [
    "CREATE TABLE IF NOT EXISTS users (telegram_id BIGINT PRIMARY KEY, username TEXT, first_name TEXT, points BIGINT NOT NULL DEFAULT 0 CHECK (points >= 0), is_banned BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT FALSE",
    "CREATE TABLE IF NOT EXISTS campaigns (id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES users(telegram_id), channel_username TEXT NOT NULL, channel_title TEXT, slots_total INTEGER NOT NULL CHECK (slots_total > 0), slots_remaining INTEGER NOT NULL CHECK (slots_remaining >= 0), reward_per_member INTEGER NOT NULL CHECK (reward_per_member > 0), status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS campaign_claims (id BIGSERIAL PRIMARY KEY, campaign_id BIGINT NOT NULL REFERENCES campaigns(id), user_id BIGINT NOT NULL REFERENCES users(telegram_id), reward INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (campaign_id,user_id))",
    "CREATE TABLE IF NOT EXISTS points_ledger (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(telegram_id), amount BIGINT NOT NULL, reason TEXT NOT NULL, reference_id BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS bot_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    "CREATE INDEX IF NOT EXISTS campaigns_active_idx ON campaigns(status,created_at DESC)",
    "CREATE INDEX IF NOT EXISTS points_ledger_user_idx ON points_ledger(user_id,created_at DESC)"
  ];
  for (const statement of statements) await pool.query(statement);
  await pool.query("INSERT INTO bot_settings(key,value) VALUES ('points_per_member',$1),('maintenance_mode','false') ON CONFLICT(key) DO NOTHING", [String(DEFAULT_POINTS_PER_MEMBER)]);
}
async function setting(key, fallback) {
  const r = await pool.query("SELECT value FROM bot_settings WHERE key=$1", [key]);
  return r.rowCount ? r.rows[0].value : fallback;
}
async function setSetting(key, value) {
  await pool.query("INSERT INTO bot_settings(key,value,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()", [key,String(value)]);
}
async function pointsPerMember() {
  const n = Number.parseInt(await setting("points_per_member", String(DEFAULT_POINTS_PER_MEMBER)),10);
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_POINTS_PER_MEMBER;
}
const isAdmin = (ctx) => !!ctx.from && String(ctx.from.id) === adminId;
async function requireAdmin(ctx) {
  if (isAdmin(ctx)) return true;
  if (ctx.callbackQuery) await ctx.answerCbQuery().catch(()=>{});
  return false;
}
async function registerUser(ctx) {
  const u = ctx.from;
  await pool.query(
    "INSERT INTO users(telegram_id,username,first_name) VALUES($1,$2,$3) ON CONFLICT(telegram_id) DO UPDATE SET username=EXCLUDED.username,first_name=EXCLUDED.first_name,updated_at=NOW()",
    [String(u.id),u.username||null,u.first_name||null]
  );
}
async function isChannelAdmin(channel,userId) {
  const m = await bot.telegram.getChatMember(channel,userId);
  return m.status === "administrator" || m.status === "creator";
}
function mainKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⭐ رصيدي","my_points"),Markup.button.callback("🚀 الحملات المتاحة","campaigns")],
    [Markup.button.callback("➕ إنشاء حملة","campaign_help")],
    [Markup.button.callback("📡 قنواتي","owner:channels"),Markup.button.callback("🔖 المفضلة","my:favorites")],
    [Markup.button.callback("💎 مركز المكافآت","v3:menu")],
    [Markup.button.callback("ℹ️ حول SubRocket","help")]
  ]);
}
function adminKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📊 الإحصائيات","adm:stats"),Markup.button.callback("⭐ إدارة النقاط","adm:points")],
    [Markup.button.callback("👥 المستخدمون","adm:users"),Markup.button.callback("📢 إذاعة رسالة","adm:broadcast")],
    [Markup.button.callback("🚀 الحملات","adm:campaigns"),Markup.button.callback("⚙️ إعدادات البوت","adm:settings")],
    [Markup.button.callback("🎟️ إنشاء كود مكافأة","v3:admin_coupon")],
    [Markup.button.callback("🎧 تذاكر الدعم","v3:admin_tickets")],
    [Markup.button.callback("🔄 تحديث اللوحة","adm:home")]
  ]);
}
async function showAdmin(ctx, edit=false) {
  const text = "🛡️ **لوحة تحكم SubRocket**\n\nكل أدوات الإدارة من هنا. هذه اللوحة خاصة بمدير البوت فقط.";
  if (edit && ctx.callbackQuery) return ctx.editMessageText(text,{parse_mode:"Markdown",...adminKeyboard()}).catch(()=>{});
  return ctx.reply(text,{parse_mode:"Markdown",...adminKeyboard()});
}
async function showAdminStats(ctx) {
  const r = await pool.query(`SELECT
    (SELECT COUNT(*)::int FROM users) users,
    (SELECT COUNT(*)::int FROM users WHERE is_banned) banned,
    (SELECT COALESCE(SUM(points),0)::text FROM users) points,
    (SELECT COUNT(*)::int FROM campaigns) campaigns,
    (SELECT COUNT(*)::int FROM campaigns WHERE status='active') active,
    (SELECT COUNT(*)::int FROM campaign_claims) claims`);
  const s=r.rows[0];
  await ctx.editMessageText("📊 **إحصائيات SubRocket**\n\n👥 المستخدمون: "+s.users+"\n🚫 المحظورون: "+s.banned+"\n⭐ مجموع الأرصدة: "+s.points+"\n🚀 كل الحملات: "+s.campaigns+"\n🟢 الحملات النشطة: "+s.active+"\n✅ الاشتراكات المتحققة: "+s.claims,{parse_mode:"Markdown",...Markup.inlineKeyboard([[Markup.button.callback("⬅️ رجوع","adm:home")]])});
}
async function showAdminPoints(ctx) {
  await ctx.editMessageText("⭐ **إدارة النقاط**\n\nاختر العملية، وبعدها أرسل أيدي المستخدم والمبلغ حسب التعليمات.",{parse_mode:"Markdown",...Markup.inlineKeyboard([
    [Markup.button.callback("➕ إضافة نقاط","adm:point_add"),Markup.button.callback("➖ خصم نقاط","adm:point_sub")],
    [Markup.button.callback("🔎 عرض رصيد مستخدم","adm:point_check")],
    [Markup.button.callback("⬅️ رجوع","adm:home")]
  ])});
}
async function showAdminSettings(ctx) {
  const rate=await pointsPerMember();
  const maintenance=await setting("maintenance_mode","false");
  await ctx.editMessageText("⚙️ **إعدادات البوت**\n\n💠 تكلفة تمويل العضو: "+rate+" نقطة\n🛠️ وضع الصيانة: "+(maintenance==="true"?"مفعّل":"متوقف")+"\n\nيمكنك تغيير القيم من الأزرار أدناه.",{parse_mode:"Markdown",...Markup.inlineKeyboard([
    [Markup.button.callback("✏️ تغيير تكلفة العضو","adm:rate")],
    [Markup.button.callback(maintenance==="true"?"🟢 إيقاف الصيانة":"🔴 تفعيل الصيانة","adm:maintenance")],
    [Markup.button.callback("⬅️ رجوع","adm:home")]
  ])});
}
async function showAdminUsers(ctx) {
  const r=await pool.query("SELECT telegram_id,username,first_name,points,is_banned FROM users ORDER BY created_at DESC LIMIT 10");
  const lines=r.rows.map((u,i)=>(i+1)+". "+(u.first_name||"مستخدم")+" · "+u.telegram_id+" · ⭐ "+u.points+(u.is_banned?" · محظور":""));
  await ctx.editMessageText("👥 **آخر 10 مستخدمين**\n\n"+(lines.join("\n")||"لا يوجد مستخدمون بعد.")+"\n\nيمكنك البحث عن مستخدم وإدارة حسابه.",{parse_mode:"Markdown",...Markup.inlineKeyboard([[Markup.button.callback("🔎 البحث عن مستخدم","adm:user_manage")],[Markup.button.callback("⭐ إدارة النقاط","adm:points")],[Markup.button.callback("⬅️ رجوع","adm:home")]])});
}
async function showAdminCampaigns(ctx) {
  const r=await pool.query("SELECT id,channel_username,slots_remaining,reward_per_member,status FROM campaigns ORDER BY created_at DESC LIMIT 10");
  const rows=r.rows.map(c=>[Markup.button.callback("#"+c.id+" "+c.channel_username+" ("+c.status+")","adm:campaign:"+c.id)]);
  rows.push([Markup.button.callback("⬅️ رجوع","adm:home")]);
  await ctx.editMessageText("🚀 **إدارة الحملات**\nاختر حملة لعرض تفاصيلها أو إلغائها وإرجاع المتبقي من رصيدها.",{parse_mode:"Markdown",...Markup.inlineKeyboard(rows)});
}
bot.start(async ctx=>{
  await registerUser(ctx);
  if (ctx.startPayload) await applyReferralOnStart(pool,ctx.from.id,ctx.startPayload).catch(e=>console.error("Referral registration failed:",e.message));
  const user=await pool.query("SELECT is_banned FROM users WHERE telegram_id=$1",[String(ctx.from.id)]);
  if(user.rows[0]?.is_banned) return;
  if ((await setting("maintenance_mode","false"))==="true" && !isAdmin(ctx)) return ctx.reply("الخدمة متوقفة مؤقتاً للصيانة.");
  await ctx.reply("أهلاً بيك في SubRocket 🚀\nمنصة النقاط والحملات للقنوات. استخدم الأزرار أدناه للتحكم بكل شيء.",mainKeyboard());
});
bot.command("adminadmin",async ctx=>{ if(!isAdmin(ctx)) return; await showAdmin(ctx); });
bot.command("help",async ctx=>{
  await ctx.reply("SubRocket 🚀\nكل خدمات البوت متاحة من خلال الأزرار بالأسفل.\n\n⭐ الرصيد: عرض نقاطك.\n🚀 الحملات: استعراض الحملات المتاحة.\n➕ إنشاء حملة: تمويل قناتك بالنقاط.",mainKeyboard());
});
bot.action(/^claim:(\d+)$/,async ctx=>{
  await registerUser(ctx);
  const id=Number(ctx.match[1]),client=await pool.connect();
  try {
    await client.query("BEGIN");
    const r=await client.query("SELECT * FROM campaigns WHERE id=$1 FOR UPDATE",[id]);
    if(!r.rowCount||r.rows[0].status!=="active"||r.rows[0].slots_remaining<1){await client.query("ROLLBACK");return ctx.answerCbQuery("الحملة مكتملة أو غير متاحة.",{show_alert:true});}
    const c=r.rows[0];
    if(String(c.owner_id)===String(ctx.from.id)){await client.query("ROLLBACK");return ctx.answerCbQuery("ما تكدر تجمع نقاط من حملتك.",{show_alert:true});}
    const u=await client.query("SELECT is_banned FROM users WHERE telegram_id=$1",[String(ctx.from.id)]);
    if(u.rows[0]?.is_banned){await client.query("ROLLBACK");return ctx.answerCbQuery("حسابك موقوف.",{show_alert:true});}
    const exists=await client.query("SELECT 1 FROM campaign_claims WHERE campaign_id=$1 AND user_id=$2",[id,String(ctx.from.id)]);
    if(exists.rowCount){await client.query("ROLLBACK");return ctx.answerCbQuery("سبق واستلمت نقاط من هاي الحملة.",{show_alert:true});}
    let m;
    try{m=await bot.telegram.getChatMember(c.channel_username,ctx.from.id);}catch{await client.query("ROLLBACK");return ctx.answerCbQuery("تعذر التحقق. تأكد أن البوت مشرف بالقناة.",{show_alert:true});}
    const joined=["member","administrator","creator"].includes(m.status)||(m.status==="restricted"&&m.is_member);
    if(!joined){await client.query("ROLLBACK");return ctx.answerCbQuery("انضم للقناة أولاً ثم تحقق.",{show_alert:true});}
    const reward=Number(c.reward_per_member),left=Number(c.slots_remaining)-1;
    const retentionSetting=await setting("retention_verification_enabled","false");
    const retentionEnabled=retentionSetting==="true";
    const hoursRaw=Number.parseInt(await setting("retention_hours","24"),10);
    const retentionHours=Number.isInteger(hoursRaw)&&hoursRaw>=1&&hoursRaw<=168?hoursRaw:24;
    const claim=await client.query(
      "INSERT INTO campaign_claims(campaign_id,user_id,reward,verification_status,reward_paid,verification_due_at,verified_at) VALUES($1,$2,$3,CASE WHEN $4 THEN 'pending' ELSE 'verified' END,NOT $4,CASE WHEN $4 THEN NOW()+($5::text||' hours')::interval ELSE NULL END,CASE WHEN $4 THEN NULL ELSE NOW() END) RETURNING id",
      [id,String(ctx.from.id),reward,retentionEnabled,retentionHours]
    );
    await client.query("UPDATE campaigns SET slots_remaining=$1,status=$2,completed_at=CASE WHEN $1=0 THEN NOW() ELSE completed_at END,updated_at=NOW() WHERE id=$3",[left,left===0?"completed":"active",id]);
    if(retentionEnabled){
      await recordCampaignEvent(client,id,ctx.from.id,"claim_pending_retention",{claimId:claim.rows[0].id,userId:String(ctx.from.id),verificationHours:retentionHours});
    }else{
      await applyLedgerEntry(client,{userId:ctx.from.id,amount:String(reward),reason:"campaign_reward",referenceId:id,idempotencyKey:"claim:"+claim.rows[0].id+":instant-reward"});
      await rewardReferral(client,pool,ctx.from.id);
      await recordCampaignEvent(client,id,ctx.from.id,"claim_verified",{claimId:claim.rows[0].id,userId:String(ctx.from.id)});
    }
    await client.query("COMMIT");
    await ctx.answerCbQuery(retentionEnabled?"تم تسجيل اشتراكك. المكافأة بعد التحقق من استمرار العضوية.":"تم التحقق! انضافت "+reward+" نقطة ⭐");
    await ctx.reply(retentionEnabled?"⏳ تم تسجيل مطالبتك للحملة #"+id+". ستُضاف المكافأة بعد "+retentionHours+" ساعة إذا بقيت مشتركاً بالقناة.":"مبروك! حصلت على "+reward+" نقطة من SubRocket 🚀");
  }catch(e){await client.query("ROLLBACK");console.error("Claim failed:",e.message);await ctx.answerCbQuery("صار خطأ أثناء التحقق.",{show_alert:true});}
  finally{client.release();}
});
bot.action("my_points",async ctx=>{await registerUser(ctx);const r=await pool.query("SELECT points FROM users WHERE telegram_id=$1",[String(ctx.from.id)]);await ctx.answerCbQuery();await ctx.reply("رصيدك الحالي: "+r.rows[0].points+" نقطة ⭐");});
bot.action("campaigns",async ctx=>{
  await ctx.answerCbQuery();
  if((await setting("maintenance_mode","false"))==="true"&&!isAdmin(ctx)) return ctx.reply("الخدمة متوقفة مؤقتاً للصيانة.");
  const r=await pool.query("SELECT id,channel_username,slots_total,slots_remaining,reward_per_member,category,description FROM campaigns WHERE status='active' AND slots_remaining>0 AND (expires_at IS NULL OR expires_at>NOW()) ORDER BY created_at DESC LIMIT 12");
  if(!r.rows.length) return ctx.reply("لا توجد حملات متاحة حالياً.",Markup.inlineKeyboard([[Markup.button.callback("⬅️ القائمة الرئيسية","home")]]));
  const rows=[];
  for(const x of r.rows){
    rows.push([Markup.button.callback("📋 "+x.channel_username+" · "+x.category+" · "+x.slots_remaining+" مقعد","campaign:detail:"+x.id)]);
    rows.push([Markup.button.url("📢 فتح القناة","https://t.me/"+x.channel_username.replace(/^@/,"")),Markup.button.callback("⭐ +"+x.reward_per_member,"claim:"+x.id)]);
  }
  rows.push([Markup.button.callback("⬅️ القائمة الرئيسية","home")]);
  return ctx.reply("🚀 الحملات المتاحة\nاختر حملة لعرض تفاصيلها، ثم انضم للقناة واطلب التحقق.",Markup.inlineKeyboard(rows));
});
bot.action(/^campaign:detail:(\d+)$/,async ctx=>{
  await ctx.answerCbQuery();
  const r=await pool.query("SELECT c.*,u.first_name,u.username FROM campaigns c JOIN users u ON u.telegram_id=c.owner_id WHERE c.id=$1",[ctx.match[1]]);
  if(!r.rowCount)return ctx.reply("الحملة غير موجودة.");
  const c=r.rows[0],remaining=Number(c.slots_remaining),completed=Number(c.slots_total)-remaining;
  const fav=await pool.query("SELECT 1 FROM user_favorites WHERE user_id=$1 AND campaign_id=$2",[String(ctx.from.id),c.id]);
  const owner=c.first_name||c.username||String(c.owner_id);
  const text="🚀 تفاصيل الحملة #"+c.id+"\n\n📢 القناة: "+c.channel_username+"\n👤 صاحب الحملة: "+owner+"\n🏷️ التصنيف: "+c.category+"\n📝 الوصف: "+(c.description||"لا يوجد وصف إضافي.")+"\n\n🎯 المقاعد المطلوبة: "+c.slots_total+"\n✅ المطالبات المسجلة: "+completed+"\n🪑 المقاعد المتبقية: "+remaining+"\n💎 مكافأة الاشتراك: "+c.reward_per_member+" نقطة\n📅 تاريخ الإنشاء: "+new Date(c.created_at).toLocaleString("ar-IQ")+"\n⏳ الانتهاء: "+(c.expires_at?new Date(c.expires_at).toLocaleString("ar-IQ"):"بدون موعد انتهاء")+"\n📌 الحالة: "+c.status;
  const rows=[[Markup.button.url("📢 فتح القناة","https://t.me/"+c.channel_username.replace(/^@/,""))],[Markup.button.callback("تحقق واستلم +"+c.reward_per_member+" ⭐","claim:"+c.id)],[Markup.button.callback(fav.rowCount?"🔖 إزالة من المفضلة":"🔖 حفظ بالمفضلة","campaign:favorite:"+c.id)],[Markup.button.callback("⬅️ الحملات","campaigns")]];
  await ctx.reply(text,Markup.inlineKeyboard(rows));
});
bot.action(/^campaign:favorite:(\d+)$/,async ctx=>{
  await ctx.answerCbQuery();
  const id=String(ctx.from.id),campaignId=Number(ctx.match[1]);
  const removed=await pool.query("DELETE FROM user_favorites WHERE user_id=$1 AND campaign_id=$2 RETURNING campaign_id",[id,campaignId]);
  if(!removed.rowCount)await pool.query("INSERT INTO user_favorites(user_id,campaign_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[id,campaignId]);
  await ctx.reply(removed.rowCount?"تمت إزالة الحملة من المفضلة.":"تم حفظ الحملة في المفضلة. يمكنك الرجوع إليها من القائمة الرئيسية.");
});
bot.action("my:favorites",async ctx=>{
  await ctx.answerCbQuery();
  const r=await pool.query("SELECT c.id,c.channel_username,c.reward_per_member,c.slots_remaining,c.category FROM user_favorites f JOIN campaigns c ON c.id=f.campaign_id WHERE f.user_id=$1 ORDER BY f.created_at DESC LIMIT 20",[String(ctx.from.id)]);
  const rows=r.rows.map(c=>[Markup.button.callback("🔖 "+c.channel_username+" · "+c.category+" · +"+c.reward_per_member,"campaign:detail:"+c.id)]);
  rows.push([Markup.button.callback("⬅️ الرئيسية","home")]);
  await ctx.reply("🔖 حملاتي المفضلة\n"+(r.rowCount?"اختر حملة لعرض تفاصيلها.":"لا توجد حملات محفوظة حالياً."),Markup.inlineKeyboard(rows));
});
bot.action("campaign_help",async ctx=>{
  await ctx.answerCbQuery();
  if((await setting("maintenance_mode","false"))==="true"&&!isAdmin(ctx)) return ctx.reply("الخدمة متوقفة مؤقتاً للصيانة.");
  const channels=await pool.query("SELECT id,username,title FROM channel_owners WHERE owner_id=$1 AND verified=TRUE ORDER BY created_at DESC",[String(ctx.from.id)]);
  if(channels.rowCount){
    const rows=channels.rows.map(ch=>[Markup.button.callback("📢 "+ch.title+" · "+(ch.username||ch.chat_id),"owner:use:"+ch.id)]);
    rows.push([Markup.button.callback("➕ إضافة قناة جديدة","owner:add")],[Markup.button.callback("إلغاء","campaign_cancel")]);
    return ctx.reply("اختر قناة محفوظة لإنشاء الحملة:",Markup.inlineKeyboard(rows));
  }
  userState.set(String(ctx.from.id),{type:"campaign_channel"});
  await ctx.reply("➕ إنشاء حملة جديدة\nأرسل معرف قناتك العامة مثل @MyChannel. يجب أن تكون مشرفاً بالقناة وأن تضيف البوت مشرفاً.",Markup.inlineKeyboard([[Markup.button.callback("إلغاء","campaign_cancel")]]));
});
bot.action("owner:channels",async ctx=>{
  await ctx.answerCbQuery();
  const r=await pool.query("SELECT id,username,title,verified,created_at FROM channel_owners WHERE owner_id=$1 ORDER BY created_at DESC",[String(ctx.from.id)]);
  const lines=r.rows.map((ch,i)=>(i+1)+". "+ch.title+" · "+(ch.username?"@"+ch.username:"قناة خاصة")+" · "+(ch.verified?"موثقة":"غير موثقة"));
  await ctx.reply("📡 قنواتي\n\n"+(lines.join("\n")||"لم تحفظ أي قناة بعد.")+"\n\nيمكنك حفظ القنوات بعد التحقق من ملكيتك وإضافة البوت مشرفاً.",Markup.inlineKeyboard([[Markup.button.callback("➕ إضافة قناة","owner:add")],[Markup.button.callback("⬅️ الرئيسية","home")]]));
});
bot.action("owner:add",async ctx=>{
  await ctx.answerCbQuery();
  userState.set(String(ctx.from.id),{type:"channel_add"});
  await ctx.reply("أرسل معرف القناة العامة مثل @MyChannel. يجب أن تكون مالكاً أو مشرفاً بالقناة، وأن يكون البوت مشرفاً أيضاً. للإلغاء أرسل إلغاء.");
});
bot.action(/^owner:use:(\d+)$/,async ctx=>{
  await ctx.answerCbQuery();
  const r=await pool.query("SELECT username,title FROM channel_owners WHERE id=$1 AND owner_id=$2 AND verified=TRUE",[ctx.match[1],String(ctx.from.id)]);
  if(!r.rowCount)return ctx.reply("القناة غير موجودة أو لم تعد موثقة.");
  userState.set(String(ctx.from.id),{type:"campaign_slots",channel:r.rows[0].username});
  await ctx.reply("تم اختيار قناة "+r.rows[0].title+". كم عدد الأعضاء المطلوبين؟ أرسل رقماً من 1 إلى 10000.");
});
bot.action(/^owner:use-latest:(-?\d+)$/,async ctx=>{
  await ctx.answerCbQuery();
  const r=await pool.query("SELECT id,username FROM channel_owners WHERE owner_id=$1 AND chat_id=$2 AND verified=TRUE",[String(ctx.from.id),String(ctx.match[1])]);
  if(!r.rowCount)return ctx.reply("القناة غير محفوظة.");
  userState.set(String(ctx.from.id),{type:"campaign_slots",channel:"@"+r.rows[0].username});
  await ctx.reply("كم عدد الأعضاء المطلوبين؟ أرسل رقماً من 1 إلى 10000.");
});
bot.action("campaign_cancel",async ctx=>{userState.delete(String(ctx.from.id));await ctx.answerCbQuery("تم الإلغاء.");return ctx.reply("تم إلغاء العملية.",mainKeyboard());});
bot.action("home",async ctx=>{await ctx.answerCbQuery();return ctx.reply("القائمة الرئيسية 🚀",mainKeyboard());});
bot.action("help",async ctx=>{await ctx.answerCbQuery();return ctx.reply("SubRocket 🚀\nكل التحكم من الأزرار. اختر الرصيد أو الحملات أو إنشاء حملة.",mainKeyboard());});

bot.action(/^adm:/,async ctx=>{
  if(!(await requireAdmin(ctx))) return;
  await ctx.answerCbQuery().catch(()=>{});
  const action=ctx.callbackQuery.data;
  try {
    if(action==="adm:home") return showAdmin(ctx,true);
    if(action==="adm:stats") return showAdminStats(ctx);
    if(action==="adm:points") return showAdminPoints(ctx);
    if(action==="adm:users") return showAdminUsers(ctx);
    if(action==="adm:user_manage") {adminState.set(adminId,{type:"user_manage"});return ctx.reply("أرسل أيدي تيليجرام الرقمي للمستخدم الذي تريد إدارته. أرسل إلغاء للإلغاء.");}
    if(action==="adm:settings") return showAdminSettings(ctx);
    if(action==="adm:campaigns") return showAdminCampaigns(ctx);
    if(action==="adm:point_add"||action==="adm:point_sub"||action==="adm:point_check") {
      adminState.set(adminId,{type:action==="adm:point_add"?"point_add":action==="adm:point_sub"?"point_sub":"point_check",step:"user"});
      return ctx.reply("أرسل أيدي المستخدم الرقمي"+(action==="adm:point_check"?" لعرض رصيده.":" ثم المبلغ بالنقاط، مثال: 123456789 500."));
    }
    if(action==="adm:rate") {adminState.set(adminId,{type:"rate"});return ctx.reply("أرسل تكلفة تمويل العضو الواحد بالنقاط (رقم صحيح أكبر من صفر).");}
    if(action==="adm:maintenance") {
      const current=await setting("maintenance_mode","false");
      await setSetting("maintenance_mode",current==="true"?"false":"true");
      return showAdminSettings(ctx);
    }
    if(action==="adm:broadcast") {adminState.set(adminId,{type:"broadcast"});return ctx.reply("أرسل نص الرسالة التي تريد إرسالها لجميع المستخدمين. أرسل إلغاء للإلغاء.");}
    const banMatch=action.match(/^adm:(ban|unban):(\d+)$/);
    if(banMatch) {
      const banned=banMatch[1]==="ban", userId=banMatch[2];
      if(userId===adminId) return ctx.reply("لا يمكن حظر حساب المدير.");
      const result=await pool.query("UPDATE users SET is_banned=$1,updated_at=NOW() WHERE telegram_id=$2 RETURNING first_name,points",[banned,userId]);
      if(!result.rowCount) return ctx.reply("المستخدم غير موجود.");
      return ctx.reply((banned?"تم إيقاف":"تم تفعيل")+" حساب "+userId+".");
    }
    const match=action.match(/^adm:campaign:(\d+)$/);
    if(match) {
      const r=await pool.query("SELECT c.*,u.username,u.first_name FROM campaigns c JOIN users u ON u.telegram_id=c.owner_id WHERE c.id=$1",[Number(match[1])]);
      if(!r.rowCount) return ctx.reply("الحملة غير موجودة.");
      const c=r.rows[0];
      const kb=c.status==="active"?[[Markup.button.callback("⛔ إلغاء الحملة وإرجاع المتبقي","adm:cancel_campaign:"+c.id)],[Markup.button.callback("⬅️ الحملات","adm:campaigns")]]:[[Markup.button.callback("⬅️ الحملات","adm:campaigns")]];
      return ctx.reply("🚀 الحملة #"+c.id+"\nالقناة: "+c.channel_username+"\nالمالك: "+c.first_name+" ("+c.owner_id+")\nالمتبقي: "+c.slots_remaining+"\nمكافأة العضو: "+c.reward_per_member+"\nالحالة: "+c.status,Markup.inlineKeyboard(kb));
    }
    const cancel=action.match(/^adm:cancel_campaign:(\d+)$/);
    if(cancel) {
      const client=await pool.connect();
      try {
        await client.query("BEGIN");
        const result=await cancelCampaign(client,Number(cancel[1]),adminId,"admin_cancelled");
        if(!result.cancelled){await client.query("ROLLBACK");return ctx.reply(result.reason==="not_found"?"الحملة غير موجودة.":"الحملة غير نشطة أو لا يمكن إلغاؤها.");}
        await client.query("COMMIT");
        await ctx.reply("تم إلغاء الحملة #"+cancel[1]+" وإرجاع "+result.refund+" نقطة إلى صاحبها.");
      }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
      return showAdminCampaigns(ctx);
    }
  } catch(e){console.error("Admin action failed:",e.message);await ctx.reply("تعذر تنفيذ العملية. راجع سجل التطبيق.");}
});

bot.on("text",async ctx=>{
  if (await bot.handleText?.(ctx)) return;
  if(!isAdmin(ctx)) {
    const state=userState.get(String(ctx.from.id));
    if(!state) return;
    const input=(ctx.message.text||"").trim();
    if(input==="إلغاء"){userState.delete(String(ctx.from.id));return ctx.reply("تم إلغاء العملية.",mainKeyboard());}
    if(state.type==="channel_add"){
      if(!/^@[A-Za-z0-9_]{5,32}$/.test(input))return ctx.reply("معرف القناة غير صحيح. أرسله بصيغة @ChannelName.");
      try{
        const chat=await bot.telegram.getChat(input);
        if(chat.type!=="channel")return ctx.reply("هذا المعرف لا يعود إلى قناة Telegram.");
        const me=await bot.telegram.getMe();
        if(!(await isChannelAdmin(input,me.id)))return ctx.reply("يجب إضافة البوت مشرفاً بالقناة أولاً.");
        if(!(await isChannelAdmin(input,ctx.from.id)))return ctx.reply("يجب أن تكون مالكاً أو مشرفاً بالقناة حتى تحفظها.");
        await pool.query("INSERT INTO channel_owners(owner_id,chat_id,username,title,verified,verified_at) VALUES($1,$2,$3,$4,TRUE,NOW()) ON CONFLICT(owner_id,chat_id) DO UPDATE SET username=EXCLUDED.username,title=EXCLUDED.title,verified=TRUE,verified_at=NOW()",[String(ctx.from.id),String(chat.id),chat.username||input.replace(/^@/,""),chat.title||input]);
        userState.delete(String(ctx.from.id));
        return ctx.reply("✅ تم حفظ القناة والتحقق من صلاحياتك: "+(chat.title||input),Markup.inlineKeyboard([[Markup.button.callback("➕ إنشاء حملة بهذه القناة","owner:use-latest:"+chat.id)],[Markup.button.callback("📡 قنواتي","owner:channels")]]));
      }catch(e){console.error("Channel verification failed:",e.description||e.message);return ctx.reply("تعذر التحقق من القناة. تأكد من المعرف وصلاحيات البوت.");}
    }
    if(state.type==="campaign_channel"){
      if(!/^@[A-Za-z0-9_]{5,32}$/.test(input)) return ctx.reply("معرف القناة غير صحيح. أرسله بصيغة @ChannelName.");
      state.channel=input;state.type="campaign_slots";userState.set(String(ctx.from.id),state);
      return ctx.reply("كم عدد الأعضاء الذين تريدهم؟ أرسل رقماً من 1 إلى 10000.");
    }
    if(state.type==="campaign_slots"){
      if(!/^\d+$/.test(input)||Number(input)<1||Number(input)>10000) return ctx.reply("أرسل عدداً صحيحاً بين 1 و10000.");
      const slots=Number(input),channel=state.channel;userState.delete(String(ctx.from.id));let client;
      try{
        const chat=await bot.telegram.getChat(channel);
        if(chat.type!=="channel") return ctx.reply("المعرف لا يعود إلى قناة عامة.",mainKeyboard());
        const me=await bot.telegram.getMe();
        if(!(await isChannelAdmin(channel,me.id))) return ctx.reply("أضف البوت مشرفاً بالقناة أولاً ثم أعد المحاولة.",mainKeyboard());
        if(!(await isChannelAdmin(channel,ctx.from.id))) return ctx.reply("يجب أن تكون مالكاً أو مشرفاً بالقناة لإنشاء حملة لها.",mainKeyboard());
        await pool.query("INSERT INTO channel_owners(owner_id,chat_id,username,title,verified,verified_at) VALUES($1,$2,$3,$4,TRUE,NOW()) ON CONFLICT(owner_id,chat_id) DO UPDATE SET username=EXCLUDED.username,title=EXCLUDED.title,verified=TRUE,verified_at=NOW()",[String(ctx.from.id),String(chat.id),chat.username||channel.replace(/^@/,""),chat.title||channel]);
        const rate=await pointsPerMember(),cost=BigInt(slots)*BigInt(rate);client=await pool.connect();await client.query("BEGIN");
        const campaign=await createCampaign(client,{ownerId:ctx.from.id,channelUsername:channel,channelTitle:chat.title||channel,slots,rewardPerMember:rate});
        await client.query("COMMIT");
        return ctx.reply("تم إنشاء حملتك بنجاح 🚀\nرقم الحملة: #"+campaign.id+"\nالقناة: "+channel+"\nعدد المقاعد: "+slots+"\nالنقاط المحجوزة: "+cost,mainKeyboard());
      }catch(e){if(client)await client.query("ROLLBACK").catch(()=>{});console.error("Campaign wizard failed:",e.message);return ctx.reply("تعذر إنشاء الحملة. تحقق من القناة وصلاحيات البوت ثم حاول مجدداً.",mainKeyboard());}
      finally{if(client)client.release();}
    }
    return;
  }
  const state=adminState.get(adminId);
  if(!state) return;
  const input=(ctx.message.text||"").trim();
  if(input==="إلغاء"){adminState.delete(adminId);return ctx.reply("تم إلغاء العملية.");}
  try {
    if(state.type==="user_manage") {
      if(!/^\d+$/.test(input)) return ctx.reply("أرسل أيدي تيليجرام رقمي صحيح.");
      const r=await pool.query("SELECT telegram_id,username,first_name,points,is_banned,created_at FROM users WHERE telegram_id=$1",[input]);
      if(!r.rowCount) return ctx.reply("المستخدم غير مسجل في البوت.");
      const u=r.rows[0];adminState.delete(adminId);
      const action=u.is_banned?"unban":"ban";
      return ctx.reply("👤 المستخدم: "+(u.first_name||"—")+"\nالأيدي: "+u.telegram_id+"\nالمعرف: "+(u.username?"@"+u.username:"—")+"\nالرصيد: "+u.points+" نقطة\nالحالة: "+(u.is_banned?"محظور":"نشط"),Markup.inlineKeyboard([[Markup.button.callback(u.is_banned?"🟢 إلغاء الحظر":"🚫 حظر المستخدم","adm:"+action+":"+u.telegram_id)],[Markup.button.callback("⭐ إدارة النقاط","adm:points")],[Markup.button.callback("⬅️ المستخدمون","adm:users")]]));
    }
    if(state.type==="rate") {
      if(!/^\d+$/.test(input)||!Number.isSafeInteger(Number(input))||Number(input)<1||Number(input)>1000000) return ctx.reply("أرسل رقماً صحيحاً بين 1 و1,000,000.");
      await setSetting("points_per_member",input);adminState.delete(adminId);
      return ctx.reply("تم تحديث تكلفة العضو إلى "+input+" نقطة. التغيير يطبق على الحملات الجديدة.");
    }
    if(state.type==="broadcast") {
      if(!input||input.length>4000) return ctx.reply("الرسالة فارغة أو أطول من الحد المسموح.");
      adminState.delete(adminId);
      const users=await pool.query("SELECT telegram_id FROM users WHERE is_banned=FALSE");
      let sent=0,failed=0;
      for(const u of users.rows){try{await bot.telegram.sendMessage(String(u.telegram_id),input);sent++;}catch{failed++;}}
      return ctx.reply("📢 انتهى الإرسال.\nتم الإرسال: "+sent+"\nتعذر الإرسال: "+failed);
    }
    if(state.type==="point_add"||state.type==="point_sub"||state.type==="point_check") {
      if(state.step==="user") {
        const parts=input.split(/\s+/);
        if(!/^\d+$/.test(parts[0])) return ctx.reply("أرسل أيدي تيليجرام الرقمي فقط.");
        const user=await pool.query("SELECT telegram_id,points,first_name FROM users WHERE telegram_id=$1",[parts[0]]);
        if(!user.rowCount) return ctx.reply("هذا المستخدم غير مسجل في البوت.");
        if(state.type==="point_check") {adminState.delete(adminId);return ctx.reply("المستخدم: "+(user.rows[0].first_name||"—")+"\nالأيدي: "+parts[0]+"\nالرصيد: "+user.rows[0].points+" نقطة.");}
        if(parts.length===2&&/^\d+$/.test(parts[1])) state.amount=parts[1];
        else {state.userId=parts[0];state.step="amount";adminState.set(adminId,state);return ctx.reply("تم تحديد المستخدم. أرسل عدد النقاط الآن.");}
        state.userId=parts[0];
      } else if(state.step==="amount") {
        if(!/^\d+$/.test(input)) return ctx.reply("أرسل مبلغاً رقمياً صحيحاً.");
        state.amount=input;
      }
      const amount=BigInt(state.amount);
      if(amount<1n||amount>1000000000000n) return ctx.reply("المبلغ يجب أن يكون بين 1 و1,000,000,000,000.");
      const client=await pool.connect();
      try {
        await client.query("BEGIN");
        const u=await client.query("SELECT points FROM users WHERE telegram_id=$1 FOR UPDATE",[state.userId]);
        if(!u.rowCount) {await client.query("ROLLBACK");adminState.delete(adminId);return ctx.reply("المستخدم غير موجود.");}
        if(state.type==="point_sub"&&BigInt(u.rows[0].points)<amount){await client.query("ROLLBACK");return ctx.reply("رصيد المستخدم أقل من المبلغ المطلوب خصمه.");}
        const delta=state.type==="point_add"?amount:-amount;
        await client.query("UPDATE users SET points=points+$1,updated_at=NOW() WHERE telegram_id=$2",[delta.toString(),state.userId]);
        await client.query("INSERT INTO points_ledger(user_id,amount,reason) VALUES($1,$2,$3)",[state.userId,delta.toString(),state.type==="point_add"?"admin_credit":"admin_debit"]);
        await client.query("COMMIT");
        adminState.delete(adminId);
        return ctx.reply((state.type==="point_add"?"تمت إضافة ":"تم خصم ")+amount+" نقطة للمستخدم "+state.userId+".");
      }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
    }
  }catch(e){console.error("Admin text action failed:",e.message);adminState.delete(adminId);await ctx.reply("تعذر تنفيذ العملية. حاول مرة ثانية.");}
});
bot.catch(e=>console.error("Telegram update error:",e));
async function main(){
  await initializeDatabase();
  await migrateV3(pool);
  await migrateV4(pool,adminId);
  installV3(bot,pool,adminId);
  startPlatformWorkers(pool,bot,rewardReferral);
  console.log("PostgreSQL connected; SubRocket v0.0.4 schema and workers are ready.");
  await bot.launch();
  await bot.telegram.setMyCommands([{command:"start",description:"بدء استخدام SubRocket"},{command:"help",description:"المساعدة"}],{scope:{type:"default"}});
  await bot.telegram.setMyCommands([{command:"start",description:"بدء استخدام SubRocket"},{command:"help",description:"المساعدة"},{command:"adminadmin",description:"لوحة تحكم المدير"}],{scope:{type:"chat",chat_id:Number(adminId)}});
  console.log("SubRocket v0.0.4 platform foundation is running; legacy data preserved.");
}
main().catch(e=>{console.error("Startup failed:",e);process.exit(1);});
process.once("SIGINT",()=>bot.stop("SIGINT"));
process.once("SIGTERM",()=>bot.stop("SIGTERM"));
