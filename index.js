require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const { Pool } = require("pg");

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminId = Number(process.env.TELEGRAM_ADMIN_ID);
const databaseUrl = process.env.POSTGRESQL_ADDON_URI || process.env.DATABASE_URL;
const pointsPerMember = Math.max(1, Number.parseInt(process.env.POINTS_PER_MEMBER || "100", 10));
if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!databaseUrl) throw new Error("Missing POSTGRESQL_ADDON_URI or DATABASE_URL");
if (!Number.isSafeInteger(adminId) || adminId <= 0) throw new Error("TELEGRAM_ADMIN_ID must be a valid numeric Telegram user ID");

const pool = new Pool({ connectionString: databaseUrl, ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
const bot = new Telegraf(token);

async function initializeDatabase() {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS users (telegram_id BIGINT PRIMARY KEY, username TEXT, first_name TEXT, points BIGINT NOT NULL DEFAULT 0 CHECK (points >= 0), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());" +
    "CREATE TABLE IF NOT EXISTS campaigns (id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES users(telegram_id), channel_username TEXT NOT NULL, channel_title TEXT, slots_total INTEGER NOT NULL CHECK (slots_total > 0), slots_remaining INTEGER NOT NULL CHECK (slots_remaining >= 0), reward_per_member INTEGER NOT NULL CHECK (reward_per_member > 0), status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());" +
    "CREATE TABLE IF NOT EXISTS campaign_claims (id BIGSERIAL PRIMARY KEY, campaign_id BIGINT NOT NULL REFERENCES campaigns(id), user_id BIGINT NOT NULL REFERENCES users(telegram_id), reward INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (campaign_id, user_id));" +
    "CREATE TABLE IF NOT EXISTS points_ledger (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(telegram_id), amount BIGINT NOT NULL, reason TEXT NOT NULL, reference_id BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());" +
    "CREATE INDEX IF NOT EXISTS campaigns_active_idx ON campaigns(status, created_at DESC);" +
    "CREATE INDEX IF NOT EXISTS points_ledger_user_idx ON points_ledger(user_id, created_at DESC)"
  );
}
async function registerUser(ctx) {
  const u = ctx.from;
  await pool.query("INSERT INTO users (telegram_id, username, first_name) VALUES ($1,$2,$3) ON CONFLICT (telegram_id) DO UPDATE SET username=EXCLUDED.username, first_name=EXCLUDED.first_name, updated_at=NOW()", [String(u.id), u.username || null, u.first_name || null]);
}
async function isChannelAdmin(channel, userId) {
  const m = await bot.telegram.getChatMember(channel, userId);
  return m.status === "administrator" || m.status === "creator";
}
function mainKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⭐ رصيدي", "my_points"), Markup.button.callback("📋 الحملات", "campaigns")],
    [Markup.button.callback("➕ إنشاء حملة", "campaign_help"), Markup.button.callback("ℹ️ المساعدة", "help")]
  ]);
}
bot.start(async (ctx) => {
  await registerUser(ctx);
  await ctx.reply("أهلاً بيك في SubRocket 🚀\n\nاجمع النقاط من خلال الانضمام الاختياري للقنوات المشاركة، واستخدم رصيدك لتمويل قناتك.\n\nكل مشترك لازم يكون حقيقي وباختياره.", mainKeyboard());
});
bot.command("help", async (ctx) => {
  await ctx.reply("أوامر SubRocket 🚀\n/points — رصيدك\n/campaigns — الحملات المتاحة\n/promote @channel 10 — إنشاء حملة لـ 10 أعضاء\n\nلإنشاء حملة: لازم تكون مشرف بالقناة وتضيف البوت مشرفاً حتى يگدر يتحقق من الاشتراكات. تكلفة العضو الواحد: " + pointsPerMember + " نقطة.");
});
bot.command("points", async (ctx) => {
  await registerUser(ctx);
  const r = await pool.query("SELECT points FROM users WHERE telegram_id=$1", [String(ctx.from.id)]);
  await ctx.reply("رصيدك الحالي: " + r.rows[0].points + " نقطة ⭐");
});
bot.command("campaigns", async (ctx) => {
  await registerUser(ctx);
  const r = await pool.query("SELECT id,channel_username,slots_remaining,reward_per_member FROM campaigns WHERE status='active' AND slots_remaining>0 ORDER BY created_at DESC LIMIT 10");
  if (!r.rows.length) return ctx.reply("ماكو حملات متاحة حالياً. ارجع بعدين 🚀");
  const buttons = r.rows.map(c => [
    Markup.button.url("فتح " + c.channel_username + " · +" + c.reward_per_member + " نقطة", "https://t.me/" + c.channel_username.replace(/^@/, "")),
    Markup.button.callback("تحقق واستلم", "claim:" + c.id)
  ]);
  await ctx.reply("الحملات المتاحة — انضم للقناة باختيارك، وبعدها اضغط تحقق واستلم:", Markup.inlineKeyboard(buttons));
});
bot.command("promote", async (ctx) => {
  await registerUser(ctx);
  const p = (ctx.message.text || "").trim().split(/\s+/);
  if (p.length !== 3 || !/^@[A-Za-z0-9_]{5,32}$/.test(p[1]) || !/^\d+$/.test(p[2])) return ctx.reply("الصيغة الصحيحة:\n/promote @channel 10\nاستبدل channel بمعرّف قناتك وعدد الأعضاء المطلوب.");
  const channel = p[1], slots = Number(p[2]);
  if (!Number.isSafeInteger(slots) || slots < 1 || slots > 10000) return ctx.reply("عدد الأعضاء لازم يكون بين 1 و 10000.");
  try {
    const chat = await bot.telegram.getChat(channel);
    if (chat.type !== "channel") return ctx.reply("الرابط المدخل مو قناة تيليجرام عامة.");
    const me = await bot.telegram.getMe();
    if (!(await isChannelAdmin(channel, me.id))) return ctx.reply("لازم تضيف البوت مشرفاً بالقناة أولاً حتى نتحقق من الاشتراكات الحقيقية.");
    const cost = slots * pointsPerMember;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const u = await client.query("SELECT points FROM users WHERE telegram_id=$1 FOR UPDATE", [String(ctx.from.id)]);
      if (!u.rowCount || BigInt(u.rows[0].points) < BigInt(cost)) {
        await client.query("ROLLBACK");
        return ctx.reply("رصيدك ما يكفي. تحتاج " + cost + " نقطة لإنشاء الحملة (" + slots + " عضو).");
      }
      await client.query("UPDATE users SET points=points-$1, updated_at=NOW() WHERE telegram_id=$2", [cost, String(ctx.from.id)]);
      const c = await client.query("INSERT INTO campaigns (owner_id,channel_username,channel_title,slots_total,slots_remaining,reward_per_member) VALUES ($1,$2,$3,$4,$4,$5) RETURNING id", [String(ctx.from.id), channel, chat.title || channel, slots, pointsPerMember]);
      await client.query("INSERT INTO points_ledger (user_id,amount,reason,reference_id) VALUES ($1,$2,'campaign_funding',$3)", [String(ctx.from.id), -cost, c.rows[0].id]);
      await client.query("COMMIT");
      await ctx.reply("تم إنشاء حملتك بنجاح 🚀\nالقناة: " + channel + "\nالأعضاء المطلوبون: " + slots + "\nالتكلفة المحجوزة: " + cost + " نقطة\nرقم الحملة: #" + c.rows[0].id);
    } catch (e) { await client.query("ROLLBACK"); throw e; }
    finally { client.release(); }
  } catch (e) {
    console.error("Campaign creation failed:", e.message);
    await ctx.reply("ما گدرنا ننشئ الحملة. تأكد من اسم القناة وأن البوت مشرف بيها، وحاول مرة ثانية.");
  }
});
bot.action(/^claim:(\d+)$/, async (ctx) => {
  await registerUser(ctx);
  const id = Number(ctx.match[1]), client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query("SELECT * FROM campaigns WHERE id=$1 FOR UPDATE", [id]);
    if (!r.rowCount || r.rows[0].status !== "active" || r.rows[0].slots_remaining < 1) { await client.query("ROLLBACK"); return ctx.answerCbQuery("الحملة مكتملة أو غير متاحة.", {show_alert:true}); }
    const c = r.rows[0];
    if (String(c.owner_id) === String(ctx.from.id)) { await client.query("ROLLBACK"); return ctx.answerCbQuery("ما تكدر تجمع نقاط من حملتك الخاصة.", {show_alert:true}); }
    const exists = await client.query("SELECT 1 FROM campaign_claims WHERE campaign_id=$1 AND user_id=$2", [id, String(ctx.from.id)]);
    if (exists.rowCount) { await client.query("ROLLBACK"); return ctx.answerCbQuery("سبق واستلمت نقاط من هاي الحملة.", {show_alert:true}); }
    let m;
    try { m = await bot.telegram.getChatMember(c.channel_username, ctx.from.id); }
    catch { await client.query("ROLLBACK"); return ctx.answerCbQuery("تعذر التحقق. تأكد أن البوت مشرف بالقناة وحاول مجدداً.", {show_alert:true}); }
    const joined = ["member","administrator","creator"].includes(m.status) || (m.status === "restricted" && m.is_member);
    if (!joined) { await client.query("ROLLBACK"); return ctx.answerCbQuery("انضم للقناة أولاً، وبعدها اضغط تحقق واستلم.", {show_alert:true}); }
    const reward = Number(c.reward_per_member), left = Number(c.slots_remaining)-1;
    await client.query("INSERT INTO campaign_claims (campaign_id,user_id,reward) VALUES ($1,$2,$3)", [id, String(ctx.from.id), reward]);
    await client.query("UPDATE users SET points=points+$1, updated_at=NOW() WHERE telegram_id=$2", [reward, String(ctx.from.id)]);
    await client.query("INSERT INTO points_ledger (user_id,amount,reason,reference_id) VALUES ($1,$2,'campaign_reward',$3)", [String(ctx.from.id), reward, id]);
    await client.query("UPDATE campaigns SET slots_remaining=$1,status=$2 WHERE id=$3", [left, left === 0 ? "completed" : "active", id]);
    await client.query("COMMIT");
    await ctx.answerCbQuery("تم التحقق! انضافت " + reward + " نقطة لرصيدك ⭐");
    await ctx.reply("مبروك! حصلت على " + reward + " نقطة من SubRocket 🚀");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Campaign claim failed:", e.message);
    await ctx.answerCbQuery("صار خطأ أثناء التحقق. حاول مرة ثانية.", {show_alert:true});
  } finally { client.release(); }
});
bot.action("my_points", async (ctx) => {
  await registerUser(ctx);
  const r = await pool.query("SELECT points FROM users WHERE telegram_id=$1", [String(ctx.from.id)]);
  await ctx.answerCbQuery();
  await ctx.reply("رصيدك الحالي: " + r.rows[0].points + " نقطة ⭐");
});
bot.action("campaigns", async (ctx) => { await ctx.answerCbQuery(); await ctx.reply("استخدم /campaigns لعرض الحملات المتاحة."); });
bot.action("campaign_help", async (ctx) => { await ctx.answerCbQuery(); await ctx.reply("لإنشاء حملة استخدم:\n/promote @channel 10\nلازم تكون مشرف بالقناة وتضيف البوت مشرفاً بيها."); });
bot.action("help", async (ctx) => { await ctx.answerCbQuery(); await ctx.reply("استخدم /help لعرض شرح الأوامر."); });
bot.command("admin", async (ctx) => {
  if (ctx.from.id !== adminId) return ctx.reply("هذا الأمر مخصص للإدارة فقط.");
  const r = await pool.query("SELECT (SELECT COUNT(*) FROM users)::int AS users,(SELECT COALESCE(SUM(points),0)::text FROM users) AS points,(SELECT COUNT(*) FROM campaigns)::int AS campaigns,(SELECT COUNT(*) FROM campaigns WHERE status='active')::int AS active_campaigns");
  const s = r.rows[0];
  await ctx.reply("لوحة الإدارة — SubRocket 🚀\nالمستخدمون: " + s.users + "\nمجموع أرصدة النقاط: " + s.points + "\nكل الحملات: " + s.campaigns + "\nالحملات النشطة: " + s.active_campaigns);
});
bot.catch((e) => console.error("Telegram update error:", e));
async function main() {
  await initializeDatabase();
  console.log("PostgreSQL connected; SubRocket schema is ready.");
  await bot.launch();
  console.log("SubRocket v0.0.0 is running with Telegram long polling.");
}
main().catch((e) => { console.error("Startup failed:", e); process.exit(1); });
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
