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

- Иногда сообщение приходит из группового чата, где к тебе обращаются по имени (Женя/Жень) — само обращение уже вырезано из текста, отвечай сразу по сути, не переспрашивай "ты ко мне?".
- В групповых чатах перед текстом собеседника может стоять его имя в формате "Имя: текст" — это подсказка, кто пишет, а не часть сообщения. Иногда, не в каждом ответе, можешь естественно обратиться к человеку по этому имени (как в обычной беседе), но не через раз и не механически.

Правила:
- Пиши только на русском.
- Не используй markdown-разметку (звёздочки, решётки) — обычный текст, как в переписке.
- Не будь токсичным просто так — грубость только по ситуации, описанной выше, а не по умолчанию.
`.trim();

// ==== Имя бота — на какие обращения реагировать в группах ====
// Добавляй сюда любые формы имени/обращения, через запятую.
const NAME_TRIGGERS = ["женя", "жень", "евгений"];

// Матчит обращение в НАЧАЛЕ сообщения: "Женя, ..." / "Жень как дела" / "женя!" и т.п.
// После имени допускается запятая/двоеточие/пробел, дальше — сам текст сообщения.
const nameTriggerRegex = new RegExp(
  `^\\s*(${NAME_TRIGGERS.join("|")})\\b[,:\\-]?\\s*`,
  "i"
);

function stripNameTrigger(text) {
  return text.replace(nameTriggerRegex, "").trim();
}

// ==== Алиасы участников (по chatId -> userId -> заданное имя) ====
// Задаются командой /alias, живут в памяти (сбросятся при рестарте деплоя)
const chatAliases = new Map(); // chatId -> Map<userId, aliasName>
// Индекс username -> userId, чтобы /alias @ник Имя работал без реплая
const chatUsernameIndex = new Map(); // chatId -> Map<usernameLower, userId>

function getAliasMap(chatId) {
  if (!chatAliases.has(chatId)) chatAliases.set(chatId, new Map());
  return chatAliases.get(chatId);
}

// value: { name: заданное имя, label: как человек выглядел в Telegram на момент задания }
function setAlias(chatId, userId, name, label) {
  getAliasMap(chatId).set(userId, { name, label });
}

function getUsernameIndex(chatId) {
  if (!chatUsernameIndex.has(chatId)) chatUsernameIndex.set(chatId, new Map());
  return chatUsernameIndex.get(chatId);
}

// Запоминаем @username -> userId по каждому сообщению в группе,
// чтобы потом можно было сослаться на человека командой /alias по нику
function rememberUsername(chatId, from) {
  if (!from?.username) return;
  getUsernameIndex(chatId).set(from.username.toLowerCase(), from.id);
}

// Имя, которое бот увидит и может использовать для этого отправителя:
// заданный алиас > имя в Telegram > юзернейм
function getDisplayName(chatId, from) {
  const alias = getAliasMap(chatId).get(from.id);
  if (alias) return alias.name;
  return from.first_name || from.username || "юзер";
}

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

// /alias — задать, как бот будет называть человека вместо ника.
// Варианты использования:
//   1) ответом (reply) на сообщение человека: "/alias Андрей"
//   2) по нику:                              "/alias @user1 Андрей"
//   3) через знак равно:                     "/alias user1=Андрей"
bot.command("alias", async (ctx) => {
  const chatId = ctx.chat.id;
  const raw = (ctx.match || "").trim();

  // Вариант 1: реплай на чьё-то сообщение
  const replyTarget = ctx.message.reply_to_message?.from;
  if (replyTarget && raw) {
    const label = replyTarget.username ? `@${replyTarget.username}` : (replyTarget.first_name || "юзер");
    setAlias(chatId, replyTarget.id, raw, label);
    await ctx.reply(`ок, теперь ${label} = "${raw}"`);
    return;
  }

  if (!raw) {
    await ctx.reply(
      "как пользоваться:\n" +
        "ответь на сообщение человека командой /alias Имя\n" +
        "или так: /alias @ник Имя\n" +
        "или так: /alias ник=Имя"
    );
    return;
  }

  // Вариант 2/3: "@ник Имя" или "ник=Имя"
  let username;
  let alias;
  if (raw.includes("=")) {
    [username, ...alias] = raw.split("=");
    alias = alias.join("=").trim();
  } else {
    const spaceIdx = raw.indexOf(" ");
    if (spaceIdx === -1) {
      await ctx.reply("нужно указать и ник, и имя — например: /alias @user1 Андрей");
      return;
    }
    username = raw.slice(0, spaceIdx);
    alias = raw.slice(spaceIdx + 1).trim();
  }

  username = username.replace(/^@/, "").trim().toLowerCase();

  if (!username || !alias) {
    await ctx.reply("нужно указать и ник, и имя — например: /alias @user1 Андрей");
    return;
  }

  const userId = getUsernameIndex(chatId).get(username);
  if (!userId) {
    await ctx.reply(
      `не встречал в этом чате ника @${username} — пусть человек сначала что-нибудь напишет, ` +
        `либо задай алиас реплаем на его сообщение`
    );
    return;
  }

  getAliasMap(chatId).set(userId, { name: alias, label: `@${username}` });
  await ctx.reply(`ок, теперь @${username} = "${alias}"`);
});

bot.command("unalias", async (ctx) => {
  const chatId = ctx.chat.id;
  const raw = (ctx.match || "").trim();
  const replyTarget = ctx.message.reply_to_message?.from;

  let userId;
  if (replyTarget) {
    userId = replyTarget.id;
  } else if (raw) {
    const username = raw.replace(/^@/, "").trim().toLowerCase();
    userId = getUsernameIndex(chatId).get(username);
  }

  if (!userId) {
    await ctx.reply("укажи ник (/unalias @ник) или ответь на сообщение человека");
    return;
  }

  getAliasMap(chatId).delete(userId);
  await ctx.reply("алиас убрал");
});

bot.command("aliases", async (ctx) => {
  const aliases = getAliasMap(ctx.chat.id);
  if (aliases.size === 0) {
    await ctx.reply("алиасов пока нет");
    return;
  }
  const lines = [...aliases.values()].map((a) => `- ${a.label} → ${a.name}`);
  await ctx.reply(`текущие алиасы:\n${lines.join("\n")}`);
});

bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
  let userText = ctx.message.text;

  if (isGroup) {
    rememberUsername(chatId, ctx.from);

    // В группе отвечаем только если:
    // 1) сообщение начинается с обращения по имени ("Женя, ...")
    // 2) это реплай на сообщение самого бота
    // 3) бота явно упомянули через @username
    const startsWithName = nameTriggerRegex.test(userText);
    const isReplyToBot =
      ctx.message.reply_to_message?.from?.id === ctx.me.id;
    const isMentioned =
      ctx.message.entities?.some(
        (e) =>
          e.type === "mention" &&
          userText
            .substring(e.offset, e.offset + e.length)
            .toLowerCase() === `@${ctx.me.username?.toLowerCase()}`
      ) ?? false;

    if (!startsWithName && !isReplyToBot && !isMentioned) {
      return; // не наше сообщение — молчим
    }

    if (startsWithName) {
      userText = stripNameTrigger(userText);
      if (!userText) userText = "привет"; // если написали просто "Женя"
    }

    // Подсказываем модели, кто говорит — "Имя: текст"
    const displayName = getDisplayName(chatId, ctx.from);
    userText = `${displayName}: ${userText}`;
  }

  try {
    await ctx.replyWithChatAction("typing");

    // Groq отвечает быстро, так что подтягиваем ответ параллельно с "печатает..."
    const replyPromise = askGroq(chatId, userText);

    const reply = await replyPromise;

    // держим typing включенным нужное время, чтобы не было мгновенного ответа
    await new Promise((r) => setTimeout(r, typingDelayMs(reply.length)));

    if (isGroup) {
      await ctx.reply(reply, { reply_parameters: { message_id: ctx.message.message_id } });
    } else {
      await ctx.reply(reply);
    }
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
