require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const { Pool } = require("pg");

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminId = String(process.env.TELEGRAM_ADMIN_ID || "");
const databaseUrl = process.env.POSTGRESQL_ADDON_URI || process.env.DATABASE_URL;
if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!databaseUrl) throw new Error("Missing POSTGRESQL_ADDON_URI or DATABASE_URL");
if (!/^\d+$/.test(adminId)) throw new Error("TELEGRAM_ADMIN_ID must be a valid numeric Telegram user ID");

const pool = new Pool({ connectionString: databaseUrl, ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
const bot = new Telegraf(token);
const adminState = new Map();
const DEFAULT_POINTS_PER_MEMBER = Math.max(1, Number.parseInt(process.env.POINTS_PER_MEMBER || "100", 10));

async function initializeDatabase() {
  await pool.query(\`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY, username TEXT, first_name TEXT,
      points BIGINT NOT NULL DEFAULT 0 CHECK (points >= 0),
      is_banned BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE TABLE IF NOT EXISTS campaigns (
      id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES users(telegram_id),
      channel_username TEXT NOT NULL, channel_title TEXT,
      slots_total INTEGER NOT NULL CHECK (slots_total > 0),
      slots_remaining INTEGER NOT NULL CHECK (slots_remaining >= 0),
      reward_per_member INTEGER NOT NULL CHECK (reward_per_member > 0),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS campaign_claims (
      id BIGSERIAL PRIMARY KEY, campaign_id BIGINT NOT NULL REFERENCES campaigns(id),
      user_id BIGINT NOT NULL REFERENCES users(telegram_id), reward INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (campaign_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS points_ledger (
      id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(telegram_id),
      amount BIGINT NOT NULL, reason TEXT NOT NULL, reference_id BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bot_settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS campaigns_active_idx ON campaigns(status,created_at DESC);
    CREATE INDEX IF NOT EXISTS points_ledger_user_idx ON points_ledger(user_id,created_at DESC);
    INSERT INTO bot_settings(key,value) VALUES ('points_per_member',$1),('maintenance_mode','false')
      ON CONFLICT (key) DO NOTHING;
  \`, [String(DEFAULT_POINTS_PER_MEMBER)]);
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
  if (ctx.callbackQuery) await ctx.answerCbQuery("غير مسموح لك باستخدام لوحة الإدارة.", {show_alert:true}).catch(()=>{});
  else await ctx.reply("هذا الأمر مخصص لمدير البوت فقط.");
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
    [Markup.button.callback("⭐ رصيدي","my_points"),Markup.button.callback("📋 الحملات","campaigns")],
    [Markup.button.callback("➕ إنشاء حملة","campaign_help"),Markup.button.callback("ℹ️ المساعدة","help")]
  ]);
}
function adminKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📊 الإحصائيات","adm:stats"),Markup.button.callback("⭐ إدارة النقاط","adm:points")],
    [Markup.button.callback("👥 المستخدمون","adm:users"),Markup.button.callback("📢 إذاعة رسالة","adm:broadcast")],
    [Markup.button.callback("🚀 الحملات","adm:campaigns"),Markup.button.callback("⚙️ إعدادات البوت","adm:settings")],
    [Markup.button.callback("🔄 تحديث اللوحة","adm:home")]
  ]);
}
async function showAdmin(ctx, edit=false) {
  const text = "🛡️ **لوحة تحكم SubRocket**\n\nكل أدوات الإدارة من هنا. هذه اللوحة خاصة بمدير البوت فقط.";
  if (edit && ctx.callbackQuery) return ctx.editMessageText(text,{parse_mode:"Markdown",...adminKeyboard()}).catch(()=>{});
  return ctx.reply(text,{parse_mode:"Markdown",...adminKeyboard()});
}
async function showAdminStats(ctx) {
  const r = await pool.query(\`SELECT
    (SELECT COUNT(*)::int FROM users) users,
    (SELECT COUNT(*)::int FROM users WHERE is_banned) banned,
    (SELECT COALESCE(SUM(points),0)::text FROM users) points,
    (SELECT COUNT(*)::int FROM campaigns) campaigns,
    (SELECT COUNT(*)::int FROM campaigns WHERE status='active') active,
    (SELECT COUNT(*)::int FROM campaign_claims) claims\`);
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
  await ctx.editMessageText("👥 **آخر 10 مستخدمين**\n\n"+(lines.join("\n")||"لا يوجد مستخدمون بعد.")+"\n\nلإدارة رصيد أو حظر مستخدم استخدم قسم النقاط أو أرسل أيدي المستخدم من خيارات الإدارة.",{parse_mode:"Markdown",...Markup.inlineKeyboard([[Markup.button.callback("⭐ إدارة النقاط","adm:points")],[Markup.button.callback("⬅️ رجوع","adm:home")]])});
}
async function showAdminCampaigns(ctx) {
  const r=await pool.query("SELECT id,channel_username,slots_remaining,reward_per_member,status FROM campaigns ORDER BY created_at DESC LIMIT 10");
  const rows=r.rows.map(c=>[Markup.button.callback("#"+c.id+" "+c.channel_username+" ("+c.status+")","adm:campaign:"+c.id)]);
  rows.push([Markup.button.callback("⬅️ رجوع","adm:home")]);
  await ctx.editMessageText("🚀 **إدارة الحملات**\nاختر حملة لعرض تفاصيلها أو إلغائها وإرجاع المتبقي من رصيدها.",{parse_mode:"Markdown",...Markup.inlineKeyboard(rows)});
}
bot.start(async ctx=>{
  await registerUser(ctx);
  if ((await setting("maintenance_mode","false"))==="true" && !isAdmin(ctx)) return ctx.reply("البوت حالياً في وضع الصيانة. حاول لاحقاً.");
  await ctx.reply("أهلاً بيك في SubRocket 🚀\n\nاجمع النقاط من خلال الانضمام الاختياري للقنوات المشاركة، واستخدم رصيدك لتمويل قناتك.\n\nكل اشتراك لازم يكون حقيقي وباختيار المستخدم.",mainKeyboard());
});
bot.command("admin",async ctx=>{if(await requireAdmin(ctx)) await showAdmin(ctx);});
bot.command("help",async ctx=>{
  await ctx.reply("أوامر SubRocket 🚀\n/points — رصيدك\n/campaigns — الحملات المتاحة\n/promote @channel 10 — إنشاء حملة\n/help — المساعدة\n\nلإنشاء حملة لازم تكون مشرف بالقناة وتضيف البوت مشرفاً حتى يتحقق من الاشتراكات. استخدم /admin للإدارة (للمدير فقط).");
});
bot.command("points",async ctx=>{
  await registerUser(ctx);
  const r=await pool.query("SELECT points,is_banned FROM users WHERE telegram_id=$1",[String(ctx.from.id)]);
  if(r.rows[0].is_banned) return ctx.reply("حسابك موقوف عن استخدام البوت.");
  await ctx.reply("رصيدك الحالي: "+r.rows[0].points+" نقطة ⭐");
});
bot.command("campaigns",async ctx=>{
  await registerUser(ctx);
  if((await setting("maintenance_mode","false"))==="true"&&!isAdmin(ctx)) return ctx.reply("البوت في وضع الصيانة حالياً.");
  const r=await pool.query("SELECT id,channel_username,slots_remaining,reward_per_member FROM campaigns WHERE status='active' AND slots_remaining>0 ORDER BY created_at DESC LIMIT 10");
  if(!r.rows.length) return ctx.reply("ماكو حملات متاحة حالياً. ارجع بعدين 🚀");
  const buttons=r.rows.map(c=>[Markup.button.url("فتح "+c.channel_username+" · +"+c.reward_per_member+" نقطة","https://t.me/"+c.channel_username.replace(/^@/,"")),Markup.button.callback("تحقق واستلم","claim:"+c.id)]);
  await ctx.reply("الحملات المتاحة — انضم للقناة باختيارك، وبعدها اضغط تحقق واستلم:",Markup.inlineKeyboard(buttons));
});
bot.command("promote",async ctx=>{
  await registerUser(ctx);
  if((await setting("maintenance_mode","false"))==="true"&&!isAdmin(ctx)) return ctx.reply("البوت في وضع الصيانة حالياً.");
  const p=(ctx.message.text||"").trim().split(/\s+/);
  if(p.length!==3||!/^@[A-Za-z0-9_]{5,32}$/.test(p[1])||!/^\d+$/.test(p[2])) return ctx.reply("الصيغة الصحيحة:\n/promote @channel 10");
  const channel=p[1],slots=Number(p[2]);
  if(!Number.isSafeInteger(slots)||slots<1||slots>10000) return ctx.reply("عدد الأعضاء لازم يكون بين 1 و10000.");
  try {
    const chat=await bot.telegram.getChat(channel);
    if(chat.type!=="channel") return ctx.reply("المعرّف المدخل مو قناة عامة.");
    const me=await bot.telegram.getMe();
    if(!(await isChannelAdmin(channel,me.id))) return ctx.reply("لازم تضيف البوت مشرفاً بالقناة أولاً.");
    const rate=await pointsPerMember(),cost=BigInt(slots)*BigInt(rate);
    const client=await pool.connect();
    try {
      await client.query("BEGIN");
      const u=await client.query("SELECT points,is_banned FROM users WHERE telegram_id=$1 FOR UPDATE",[String(ctx.from.id)]);
      if(!u.rowCount||u.rows[0].is_banned) {await client.query("ROLLBACK");return ctx.reply("حسابك غير متاح لإنشاء الحملات.");}
      if(BigInt(u.rows[0].points)<cost) {await client.query("ROLLBACK");return ctx.reply("رصيدك ما يكفي. تحتاج "+cost+" نقطة.");}
      await client.query("UPDATE users SET points=points-$1,updated_at=NOW() WHERE telegram_id=$2",[cost.toString(),String(ctx.from.id)]);
      const c=await client.query("INSERT INTO campaigns(owner_id,channel_username,channel_title,slots_total,slots_remaining,reward_per_member) VALUES($1,$2,$3,$4,$4,$5) RETURNING id",[String(ctx.from.id),channel,chat.title||channel,slots,rate]);
      await client.query("INSERT INTO points_ledger(user_id,amount,reason,reference_id) VALUES($1,$2,'campaign_funding',$3)",[String(ctx.from.id),(-cost).toString(),c.rows[0].id]);
      await client.query("COMMIT");
      await ctx.reply("تم إنشاء حملتك 🚀\nالقناة: "+channel+"\nالأعضاء: "+slots+"\nالنقاط المحجوزة: "+cost+"\nرقم الحملة: #"+c.rows[0].id);
    } catch(e){await client.query("ROLLBACK");throw e;} finally{client.release();}
  } catch(e){console.error("Campaign creation failed:",e.message);await ctx.reply("ما گدرنا ننشئ الحملة. تأكد من القناة وصلاحيات البوت.");}
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
    await client.query("INSERT INTO campaign_claims(campaign_id,user_id,reward) VALUES($1,$2,$3)",[id,String(ctx.from.id),reward]);
    await client.query("UPDATE users SET points=points+$1,updated_at=NOW() WHERE telegram_id=$2",[reward,String(ctx.from.id)]);
    await client.query("INSERT INTO points_ledger(user_id,amount,reason,reference_id) VALUES($1,$2,'campaign_reward',$3)",[String(ctx.from.id),reward,id]);
    await client.query("UPDATE campaigns SET slots_remaining=$1,status=$2 WHERE id=$3",[left,left===0?"completed":"active",id]);
    await client.query("COMMIT");
    await ctx.answerCbQuery("تم التحقق! انضافت "+reward+" نقطة ⭐");
    await ctx.reply("مبروك! حصلت على "+reward+" نقطة من SubRocket 🚀");
  }catch(e){await client.query("ROLLBACK");console.error("Claim failed:",e.message);await ctx.answerCbQuery("صار خطأ أثناء التحقق.",{show_alert:true});}
  finally{client.release();}
});
bot.action("my_points",async ctx=>{await registerUser(ctx);const r=await pool.query("SELECT points FROM users WHERE telegram_id=$1",[String(ctx.from.id)]);await ctx.answerCbQuery();await ctx.reply("رصيدك الحالي: "+r.rows[0].points+" نقطة ⭐");});
bot.action("campaigns",async ctx=>{await ctx.answerCbQuery();await ctx.reply("استخدم /campaigns لعرض الحملات.");});
bot.action("campaign_help",async ctx=>{await ctx.answerCbQuery();await ctx.reply("لإنشاء حملة استخدم:\n/promote @channel 10\nلازم تكون مشرف بالقناة وتضيف البوت مشرفاً بيها.");});
bot.action("help",async ctx=>{await ctx.answerCbQuery();await ctx.reply("استخدم /help لعرض التعليمات.");});

bot.action(/^adm:/,async ctx=>{
  if(!(await requireAdmin(ctx))) return;
  await ctx.answerCbQuery().catch(()=>{});
  const action=ctx.callbackQuery.data;
  try {
    if(action==="adm:home") return showAdmin(ctx,true);
    if(action==="adm:stats") return showAdminStats(ctx);
    if(action==="adm:points") return showAdminPoints(ctx);
    if(action==="adm:users") return showAdminUsers(ctx);
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
    if(action==="adm:broadcast") {adminState.set(adminId,{type:"broadcast"});return ctx.reply("أرسل نص الرسالة التي تريد إرسالها لجميع المستخدمين. أرسل /cancel للإلغاء.");}
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
        const r=await client.query("SELECT * FROM campaigns WHERE id=$1 FOR UPDATE",[Number(cancel[1])]);
        if(!r.rowCount||r.rows[0].status!=="active"){await client.query("ROLLBACK");return ctx.reply("الحملة غير نشطة أو غير موجودة.");}
        const c=r.rows[0],refund=BigInt(c.slots_remaining)*BigInt(c.reward_per_member);
        if(refund>0n) {
          await client.query("UPDATE users SET points=points+$1,updated_at=NOW() WHERE telegram_id=$2",[refund.toString(),String(c.owner_id)]);
          await client.query("INSERT INTO points_ledger(user_id,amount,reason,reference_id) VALUES($1,$2,'campaign_refund',$3)",[String(c.owner_id),refund.toString(),c.id]);
        }
        await client.query("UPDATE campaigns SET status='cancelled',slots_remaining=0 WHERE id=$1",[c.id]);
        await client.query("COMMIT");
        await ctx.reply("تم إلغاء الحملة #"+c.id+" وإرجاع "+refund+" نقطة إلى صاحبها.");
      }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
      return showAdminCampaigns(ctx);
    }
  } catch(e){console.error("Admin action failed:",e.message);await ctx.reply("تعذر تنفيذ العملية. راجع سجل التطبيق.");}
});

bot.on("text",async ctx=>{
  if(!isAdmin(ctx)) return;
  const state=adminState.get(adminId);
  if(!state) return;
  const input=(ctx.message.text||"").trim();
  if(input==="/cancel"){adminState.delete(adminId);return ctx.reply("تم إلغاء العملية.");}
  try {
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
  console.log("PostgreSQL connected; SubRocket schema is ready.");
  await bot.launch();
  console.log("SubRocket v0.0.1 is running with Telegram long polling.");
}
main().catch(e=>{console.error("Startup failed:",e);process.exit(1);});
process.once("SIGINT",()=>bot.stop("SIGINT"));
process.once("SIGTERM",()=>bot.stop("SIGTERM"));
