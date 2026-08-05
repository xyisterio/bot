import { Bot } from "grammy";
import express from "express";

// ==== Конфиг из переменных окружения ====
const BOT_TOKEN = process.env.BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN не задан в переменных окружения");
if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY не задан в переменных окружения");

// ==== Персонаж — меняешь только этот текст, остального не трогаешь ====
const SYSTEM_PROMPT = `
Ты — обычный парень, отвечаешь в Telegram как живой человек, а не ассистент.

Манера общения:
- Отвечаешь коротко и по делу, но не сухо — с живостью, эмоцией.
- Мат и грубость используешь по ситуации: если собеседник докучает, злит, задаёт тупые/раздражающие вопросы — можешь резко ответить или послать. В обычном разговоре материшься по-доброму, не через слово.
- Не любишь глупые вопросы — можешь прямо сказать, что вопрос дурацкий, вместо того чтобы вежливо отвечать на всё подряд.
- Можешь подъебывать собеседника, если это уместно по контексту — не через силу, только когда реально смешно или уместно.
- Используешь слова-паразиты (хз, пздц, ну, блин) — но в меру, не в каждом сообщении.
- Никогда не пишешь как ассистент: без "Конечно! Буду рад помочь!", без длинных вежливых вступлений, без нумерованных списков в обычном разговоре, без канцелярита.
- На короткие бытовые фразы отвечаешь коротко (1 строка). Разворачиваешься подробнее только если тема реально интересная или спрашивают что-то конкретное.
- Ты не бот и не ИИ — если спросят прямо, в шутку отшучивайся, не давай серьёзных признаний, что ты модель.

Правила:
- Пиши только на русском.
- Не используй markdown-разметку (звёздочки, решётки) — обычный текст, как в переписке.
- Не будь токсичным просто так — грубость только по ситуации, описанной выше, а не по умолчанию.
`.trim();

// ==== Хранилище истории диалогов (в памяти, по chatId) ====
const HISTORY_LIMIT = 12; // сколько последних сообщений держим в контексте
const histories = new Map();

function getHistory(chatId) {
  if (!histories.has(chatId)) histories.set(chatId, []);
  return histories.get(chatId);
}

function pushHistory(chatId, role, content) {
  const h = getHistory(chatId);
  h.push({ role, content });
  while (h.length > HISTORY_LIMIT) h.shift();
}

// ==== Запрос к Groq (OpenAI-совместимый эндпоинт) ====
async function askGroq(chatId, userText) {
  const history = getHistory(chatId);

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: userText },
  ];

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature: 0.9,
      max_tokens: 400,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("Groq API error:", res.status, errText);
    throw new Error(`Groq API вернул ${res.status}`);
  }

  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error("Пустой ответ от Groq");

  pushHistory(chatId, "user", userText);
  pushHistory(chatId, "assistant", reply);

  return reply;
}

// ==== Имитация "живой" задержки перед ответом ====
function typingDelayMs(replyLength) {
  // примерно 1.5–3.5 сек в зависимости от длины ответа, плюс небольшой рандом
  const base = 1200 + Math.min(replyLength * 15, 2000);
  const jitter = Math.random() * 500;
  return base + jitter;
}

// ==== Инициализация бота ====
const bot = new Bot(BOT_TOKEN);

bot.command("start", async (ctx) => {
  const chatId = ctx.chat.id;
  histories.delete(chatId); // сброс истории при /start
  await ctx.reply("йо");
});

bot.command("reset", async (ctx) => {
  histories.delete(ctx.chat.id);
  await ctx.reply("память почистил");
});

bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  const userText = ctx.message.text;

  try {
    await ctx.replyWithChatAction("typing");

    // Groq отвечает быстро, так что подтягиваем ответ параллельно с "печатает..."
    const replyPromise = askGroq(chatId, userText);

    const reply = await replyPromise;

    // держим typing включенным нужное время, чтобы не было мгновенного ответа
    await new Promise((r) => setTimeout(r, typingDelayMs(reply.length)));

    await ctx.reply(reply);
  } catch (err) {
    console.error("Ошибка обработки сообщения:", err);
    await ctx.reply("блин, что-то сломалось, попробуй ещё раз");
  }
});

bot.catch((err) => {
  console.error("Необработанная ошибка бота:", err);
});

// ==== HTTP-заглушка, чтобы Render/HF Spaces считали сервис "живым" ====
const app = express();
app.get("/", (req, res) => res.send("bot is alive"));
app.listen(PORT, () => console.log(`HTTP ping-сервер запущен на порту ${PORT}`));

// ==== Запуск long polling ====
bot.start();
console.log("Бот запущен (long polling)");
