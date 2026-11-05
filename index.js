require("dotenv").config();

const { Telegraf } = require("telegraf");
const { Pool } = require("pg");

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminId = Number(process.env.TELEGRAM_ADMIN_ID);
const databaseUrl = process.env.POSTGRESQL_ADDON_URI || process.env.DATABASE_URL;

if (!token) {
  console.error("Missing required environment variable: TELEGRAM_BOT_TOKEN");
  process.exit(1);
}
if (!databaseUrl) {
  console.error("Missing PostgreSQL connection variable: POSTGRESQL_ADDON_URI (or DATABASE_URL)");
  process.exit(1);
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }
});

const bot = new Telegraf(token);

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      points BIGINT NOT NULL DEFAULT 0 CHECK (points >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

bot.start(async (ctx) => {
  const from = ctx.from;
  await pool.query(
    `INSERT INTO users (telegram_id, username, first_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id) DO UPDATE SET
       username = EXCLUDED.username,
       first_name = EXCLUDED.first_name,
       updated_at = NOW()`,
    [String(from.id), from.username || null, from.first_name || null]
  );
  await ctx.reply(
    `أهلاً بيك في SubRocket 🚀\n\nهنا تگدر تجمع النقاط وتستخدمها لطلبات تمويل قناتك أو كروبك.\n\nالأوامر المتاحة:\n/points - رصيد نقاطك\n/help - المساعدة`
  );
});

bot.command("points", async (ctx) => {
  const result = await pool.query(
    "SELECT points FROM users WHERE telegram_id = $1",
    [String(ctx.from.id)]
  );
  const points = result.rowCount ? result.rows[0].points : 0;
  await ctx.reply(`رصيدك الحالي: ${points} نقطة ⭐`);
});

bot.help(async (ctx) => {
  await ctx.reply("استخدم /start لبدء الاستخدام و /points لمعرفة رصيد نقاطك.");
});

bot.command("admin", async (ctx) => {
  if (!Number.isSafeInteger(adminId) || ctx.from.id !== adminId) {
    return ctx.reply("هذا الأمر مخصص للإدارة فقط.");
  }
  const result = await pool.query("SELECT COUNT(*)::int AS users, COALESCE(SUM(points), 0)::text AS points FROM users");
  await ctx.reply(
    `لوحة الإدارة - SubRocket 🚀\nعدد المستخدمين: ${result.rows[0].users}\nمجموع النقاط: ${result.rows[0].points}`
  );
});

bot.catch((error) => {
  console.error("Telegram bot error:", error);
});

async function main() {
  await initializeDatabase();
  console.log("PostgreSQL connected and database schema initialized.");
  await bot.launch();
  console.log("SubRocket Telegram bot is running (long polling).");
}

main().catch((error) => {
  console.error("Startup failed:", error);
  process.exit(1);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
