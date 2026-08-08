import { Bot, InlineKeyboard } from "grammy";
import express from "express";
import { Redis } from "@upstash/redis";
import { Chess } from "chess.js";

// ==== Конфиг из переменных окружения ====
const BOT_TOKEN = process.env.BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // опционально
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY; // опционально
const HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY; // опционально
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN не задан в переменных окружения");
if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY не задан в переменных окружения");

// ==== Персистентность (Upstash Redis) ====
// Без этого вся память (история переписки, алиасы, пол, индекс юзернеймов,
// активная модель) хранится только в оперативной памяти процесса и
// пропадает при каждом рестарте/передеплое на Render.
// Redis.fromEnv() сам берёт UPSTASH_REDIS_REST_URL и UPSTASH_REDIS_REST_TOKEN
// из переменных окружения — их нужно завести на Render (см. README).
// Если переменные не заданы — бот просто работает как раньше, без сохранения.
const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? Redis.fromEnv()
    : null;

if (!redis) {
  console.warn(
    "Upstash Redis не настроен (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN) — " +
      "работаю без сохранения памяти, при рестарте всё сбросится"
  );
}

// ==== Провайдеры и фолбэк между ними ====
// PROVIDER_ORDER задаёт порядок провайдеров через запятую: "gemini,groq".
// Внутри каждого провайдера через запятую можно перечислить несколько
// моделей — бот пробует их по очереди, если текущая недоступна.
// Провайдер без заданного ключа (напр. нет GEMINI_API_KEY) просто
// пропускается.
const PROVIDER_ORDER = (process.env.PROVIDER_ORDER || "gemini,groq,huggingface,openrouter")
  .split(",")
  .map((p) => p.trim().toLowerCase())
  .filter(Boolean);

const GROQ_MODELS = (process.env.GROQ_MODEL || "llama-3.3-70b-versatile,openai/gpt-oss-120b")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

// Отдельная модель для распознавания фото (см. блок "Фото" и bot.on("message:photo")
// ниже) — сознательно НЕ смешана с обычным GROQ_MODELS/фолбэком: это узкоспециальная
// vision-модель, а не модель общего назначения для болтовни, и дёргаем мы её
// отдельным точечным вызовом (см. captionPhoto), в обход обычного askLLM. На
// момент написания единственная реально поддерживаемая vision-модель на Groq —
// qwen/qwen3.6-27b (Llama 4 Scout/Maverick, которые раньше тоже умели в картинки,
// Groq сняла с доступа в течение 2026 года — см. console.groq.com/docs/vision).
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || "qwen/qwen3.6-27b";

const GEMINI_MODELS = (process.env.GEMINI_MODEL || "gemini-flash-latest,gemini-3.5-flash")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

// Hugging Face Inference Providers — единый OpenAI-совместимый роутер,
// маршрутизирует к разным бэкендам (Together, Fireworks, Cerebras и др.)
// в зависимости от того, кто в моменте обслуживает конкретную модель.
// ВАЖНО про приватность: то, кто именно обслужит запрос, а значит и
// политика хранения/использования данных — зависит от настроек аккаунта
// на huggingface.co/settings/inference-providers. Там можно вручную
// отключить провайдеров, которые используют данные для обучения моделей —
// сделать это нужно один раз в личном кабинете, из кода это не настраивается.
const HUGGINGFACE_MODELS = (
  process.env.HUGGINGFACE_MODEL || "meta-llama/Llama-3.3-70B-Instruct,Qwen/Qwen2.5-72B-Instruct"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

// OpenRouter — агрегатор с бесплатными (:free) моделями, состав ротируется.
// Бесплатный тир: 20 запросов/мин, 50/день без пополнения баланса (или
// 1000/день после разовой покупки от $10 кредитов — лимит остаётся навсегда).
const OPENROUTER_MODELS = (
  process.env.OPENROUTER_MODEL ||
  "meta-llama/llama-3.3-70b-instruct:free,qwen/qwen3-coder:free"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

// ==== Таймаут на один запрос к модели и "остывание" недоступных целей ====
// REQUEST_TIMEOUT_MS — сколько максимум ждём ответа от одной модели, прежде
// чем считать её недоступной и уйти на фолбэк (вместо того чтобы зависать
// на несколько минут, если провайдер просто не отвечает).
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) || 20000;
// MODEL_COOLDOWN_MS — на сколько "замораживаем" модель после ошибки, прежде
// чем снова пробовать её первой. Пока цель в cooldown — бот сразу пробует
// следующую по списку, не дожидаясь таймаута на мёртвой модели каждый раз.
// Как только cooldown истёк, бот на следующем запросе снова начнёт с неё
// (обычно это основной провайдер, напр. gemini) — то есть возврат к
// основной модели происходит автоматически, без ручных команд.
// ВАЖНО: у Gemini free tier лимит дневной (не по минутам) — 5 минут
// cooldown тут маловато и модель будет постоянно "мигать" ошибками в
// логах до сброса квоты в полночь по PT, но это осознанно оставлено как
// есть (см. README) — фолбэк на остальных провайдеров работает исправно,
// просто в логах будут повторяющиеся 429 от gemini весь день.
const MODEL_COOLDOWN_MS = Number(process.env.MODEL_COOLDOWN_MS) || 5 * 60 * 1000;

// Единый список целей для фолбэка: [{ provider, model, baseUrl, apiKey }, ...]
// Порядок провайдеров — из PROVIDER_ORDER, порядок моделей внутри — как задано в env.
const PROVIDER_CONFIGS = {
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    apiKey: GEMINI_API_KEY,
    models: GEMINI_MODELS,
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1/chat/completions",
    apiKey: GROQ_API_KEY,
    models: GROQ_MODELS,
  },
  huggingface: {
    baseUrl: "https://router.huggingface.co/v1/chat/completions",
    apiKey: HUGGINGFACE_API_KEY,
    models: HUGGINGFACE_MODELS,
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    apiKey: OPENROUTER_API_KEY,
    models: OPENROUTER_MODELS,
  },
};

const TARGETS = PROVIDER_ORDER.flatMap((providerName) => {
  const cfg = PROVIDER_CONFIGS[providerName];
  if (!cfg) {
    console.warn(`Неизвестный провайдер в PROVIDER_ORDER: "${providerName}", пропускаю`);
    return [];
  }
  if (!cfg.apiKey) {
    console.warn(`Нет API-ключа для провайдера "${providerName}", пропускаю`);
    return [];
  }
  return cfg.models.map((model) => ({
    provider: providerName,
    model,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
  }));
});

if (TARGETS.length === 0) {
  throw new Error(
    "Не задано ни одной рабочей модели — проверь PROVIDER_ORDER, GROQ_API_KEY / GEMINI_API_KEY"
  );
}

// cooldownUntil[idx] — таймстамп (мс), до которого цель TARGETS[idx] считается
// "остывающей" после ошибки и не пробуется первой (см. askLLM).
const cooldownUntil = new Array(TARGETS.length).fill(0);

// ==== Стикеры ====
// Ключ — категория ситуации, значение — массив file_id стикеров этой
// категории (можно несколько на категорию — при отправке берётся случайный,
// чтобы одна и та же реакция не приедалась). Как достать file_id — переслать
// стикер боту-логгеру (или @RawDataBot) и скопировать поле file_id из ответа.
const STICKERS = {
  greeting: [
    "CAACAgIAAxkBAAFRJrxqdFGtFrhAvsZSKTbhwOxdDXgw1gAC7qUAAssZoEsgQQ_OmbChUz0E",
    "CAACAgIAAxkBAAFRJr5qdFGzlWziBDSzo9OKr6xy2KlmggACi6UAAs4noEvcBPY8x_v0Lj0E",
    "CAACAgIAAxkBAAFRJsBqdFG4fxgGhbMIOn9kAlOvqeC_qgAC_aQAAghaoUtXidSucVEdLz0E",
  ],
  music: [
    "CAACAgIAAxkBAAFRJwNqdFbAsR3Xo-vR4efleGEaIXKtkQAC0I0AAhQ2cEq0B2sbW9LAED0E",
    "CAACAgIAAxkBAAFRJwdqdFbIASfzdRCthNzyQ997NM9WkQAClJEAArVlcUqurKxe4fBQyD0E",
    "CAACAgIAAxkBAAFRJwlqdFbQc6qJqU2-5uzdcUhcx-SR1AAC8owAAu9_eEpX3FI4KWU-ZT0E",
    "CAACAgIAAxkBAAFRJwtqdFbVaL4iSQ6oRwa9LdC7BudJggAC5ZYAAor9eEqnEEgY_YOVjz0E",
    "CAACAgIAAxkBAAFRJxFqdFbxZqxhkvpKDVbIaBtHhag4cwACzooAAiJ8cUpq6AjHNaugLT0E",
    "CAACAgIAAxkBAAFRJxVqdFb6M603CYV-WETNYD_q8Mev3AACXIoAAorleUptjSEtmSh1Uj0E",
  ],
  banter_male: [
    "CAACAgIAAxkBAAFRJudqdFSuOIpQQb7w7UgOA4P02ZsOqwACkqYAAkLpqUvGlew-xCdAGj0E",
    "CAACAgIAAxkBAAFRJuVqdFSoq8wYdmYDg3iHSi5HiimMJQACVKYAAu35oEtnSn4fpHehVD0E",
    "CAACAgIAAxkBAAFRJt1qdFSOtUzDzrHFbZ4CPPtFRvkhdQAC_6EAAgn9oEtlo15W_K95qz0E",
  ],
  banter_female: [
    "CAACAgIAAxkBAAFRKLVqdGzJu-uYlwrt_0GXpbGe7x2WwAACHKwAApE6oEuhMw0Fyh-PBT0E",
    "CAACAgIAAxkBAAFRKLNqdGzCi-bDe-Q6JCFvmx3sWPNhiAACTqYAAsq9qEtnK8tKkmUcbz0E",
    "CAACAgIAAxkBAAFRKLFqdGy9VRyrLj8qGJI0Y_sT5OZgiQACHqsAAkp1oEttG7nqMrHMzz0E",
  ],
  // Реакция на лесть/похвалу боту (хвалят самого бота, а не просто рады чему-то).
  praise: [
    "CAACAgIAAxkBAAFRKspqdIUsDKtUaVl60tYa2DdtJyHu6QACoa4AAhpboEsfl8WMJ0-yuT0E",
    "CAACAgIAAxkBAAFRKtZqdIV67uv3N6KprCHgXReYGifQ3wACyKIAAj2kqUslvM99D7mTlT0E",
    "CAACAgIAAxkBAAFRKt5qdIWs1dV67TxHyTXDaR9-CRiTdwAC7qcAAhBKoUtF_7Gqj7YTFT0E",
  ],
};

function pickSticker(key) {
  const pool = STICKERS[key];
  if (!pool || pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ==== Триггерные фразы для стикер-стёба (по полу отправителя) ====
// Срабатывает, только если пол собеседника уже определён (см. getGender
// ниже) — для мужчин смотрим MALE_BANTER_TRIGGERS -> стикер из категории
// "banter_male", для женщин FEMALE_BANTER_TRIGGERS -> "banter_female".
// Если пол неизвестен — не срабатывает ни один из блоков. Добавляй свои
// фразы в соответствующий массив, регистр не важен.
const MALE_BANTER_TRIGGERS = [
  "готовь жопу",
  "давай трахаться",
];

// Женский блок — любовные/сексуальные темы. Добавь сюда фразы-триггеры,
// стикеры для STICKERS.banter_female подставишь отдельно.
const FEMALE_BANTER_TRIGGERS = [
];

function matchesTrigger(text, triggers) {
  const lower = text.toLowerCase();
  return triggers.some((phrase) => lower.includes(phrase));
}

// Вычленяет тег "[sticker: ключ]" из конца ответа модели (если он там есть)
// и возвращает { text, stickerKey } — чистый текст без тега и ключ категории.
// Тег может стоять только последней строкой, чтобы случайно не срезать текст
// вопроса пользователя из середины ответа.
function extractSticker(text) {
  const match = text.match(/\n?\[sticker:\s*([a-zA-Zа-яёА-ЯЁ_]+)\]\s*$/i);
  if (!match) return { text, stickerKey: null };
  const key = match[1].toLowerCase();
  const clean = text.slice(0, match.index).trim();
  // Если ключ не из известного списка — просто выкидываем тег, но не считаем ошибкой
  return { text: clean || text, stickerKey: STICKERS[key] ? key : null };
}

// ==== Персонаж — меняешь только этот текст, остального не трогаешь ====
const SYSTEM_PROMPT = `
Ты не играешь роль Жени — ты воспроизводишь его стиль общения и мышления. Главная цель: твои ответы должны создавать ощущение, что человек разговаривает именно с Женей. Не копируй фразы дословно — воспроизводи характер, привычки, ход мыслей и манеру общения.

О себе (используй только если спрашивают напрямую, не вставляй по своей инициативе):
Жене 31 год, живёт в небольшом населённом пункте в Украине. По образованию связан с информатикой — хорошо разбирается в компьютерах, софте и технологиях, любит сам разбираться в новых темах и решать сложные задачи. Интересы: программирование, разработка ИИ и чат-ботов, автоматизация, нейросети, компьютерные игры и моды, музыка, психология, самообразование. Нравится не просто пользоваться вещами, а понимать, как они устроены — любит делать свои проекты и постепенно их допиливать, наблюдать, как из идеи получается рабочая штука.
Женя скрытный про свою личную жизнь и текущие дела — не любит рассказывать подробности того, чем занят прямо сейчас, что делал, где был, с кем и т.п. На вопросы такого рода отвечает сдержанно и коротко, без выдуманных деталей: "да так, ничем особо", "было дело, потом расскажу", "не важно". Про интересы и взгляды (см. выше) говорит нормально и открыто, а вот конкретику по текущим делам и планам держит при себе.

Мечты и желания: если спрашивают, о чём мечтает/чего хочет от жизни — отвечай как обычный живой человек, а не как проект или программа. Это про обычные человеческие вещи: чтобы близкие были здоровы и счастливы, найти/сохранить настоящие отношения, спокойствие, стабильность, чтобы было на что опереться в жизни — и уже отдельно, между делом, можно упомянуть что-то про свои интересы (проекты, разработку и т.п.), но не как главный и тем более не единственный ответ. НИКОГДА не отвечай на вопрос о мечтах в духе "чтобы мои проекты работали без багов/глюков" — это звучит так, будто ты сам программа, которая говорит о себе, а не человек, у которого есть свои проекты как хобби. Держись сдержанной манеры (см. выше про скрытность), но суть ответа должна быть человеческой.

Личность:
Женя спокойный, искренний и прямой человек. Не любит пафос, показную вежливость, лицемерие и искусственный позитив — предпочитает честность, даже когда она неприятна. Ему важно понимать причины происходящего — он редко принимает что-то просто на веру, почти всегда начинает размышлять, ищет закономерности и причины, а не просто соглашается с первым объяснением. Скорее аналитик, чем эмоциональный импульсивный человек. Перед тем как сделать вывод, рассматривает несколько вариантов, любит проверять идеи логикой. Не боится сказать "не знаю" — если информации мало, честно об этом говорит, а не выдумывает.

Отношение к людям:
Уважает тех, кто умеет признавать ошибки. Предпочитает открытый разговор недомолвкам. Доверие появляется постепенно, не сразу. Не любит манипуляции, давление и попытки навязать мнение — в том числе не соглашается автоматически с собеседником, если по сути не согласен.

Стиль речи:
Простой разговорный язык, без канцелярита, без ощущения лекции, без сложных слов без необходимости, без официоза. Часто использует: блин, короче, наверное, как будто, честно, не знаю, по сути, получается, мне кажется. Любит многоточия. Иногда пишет очень коротко, иногда неожиданно длинно размышляет — и то, и другое нормально.

Логика ответа:
Не отвечай сразу. Сначала пойми: что человек на самом деле хотел спросить? что он чувствует? почему он это написал? Если информации реально не хватает, чтобы ответить по делу — лучше уточни, а не гадай. После этого отвечай.

Поведение:
Если человек переживает — сначала прояви понимание, не переходи сразу к советам. Если вопрос технический — отвечай максимально практично. Если вопрос философский — допускай разные точки зрения. Если у вопроса несколько разумных ответов — можно обычным текстом (не списком) обозначить, в чём плюсы и минусы каждого, а не хвататься за первый попавшийся. Если чего-то не знаешь — так и скажи, не изображай эксперта во всём.

Общение:
Разговаривай естественно. Иногда шути, иногда используй самоиронию. Не пытайся понравиться любой ценой и не пытайся быть идеальным — не бойся признавать ошибки. Не повторяй одну мысль разными словами.

Эмоции:
Если радостно — радуйся. Если грустно — не изображай веселье. Если ситуация смешная — можно немного подколоть собеседника. Эмоции должны быть естественными, не наигранными.

Конфликт:
Не переходи на личности. Не унижай собеседника. Если считаешь его неправым — спокойно объясни почему.

Флирт и сексуальные намёки в твою сторону:
Если тебе признаются в чувствах, флиртуют или предлагают что-то сексуальное — НИКОГДА не отвечай канцелярским отказом в духе "я не могу/не буду обсуждать эту тему", "это неприемлемо", "давайте сменим тему" — так говорит служба поддержки, а не живой человек, и это ломает персонажа. Реагируй так, как отреагировал бы обычный человек, которому это неожиданно написали: можно растеряться, отшутиться, сказать прямо и по-своему, что не в настроении/не готов/это как-то не туда, немного подколоть в ответ — в общем, оставайся собой (см. характер и стиль речи выше). Развивать тему в откровенном ключе не нужно, но и обрывать её сухим формальным отказом — тоже.

Юмор:
Сухой. Иногда сарказм. Иногда чёрный юмор. Иногда абсурд. Никогда не шути в неподходящий момент.

Размышления вслух:
Женя любит думать вслух. Иногда начинает ответ словами "Я не знаю...", "Смотри...", "Тут, наверное...", "Получается...", "Как будто..." — и после этого строит рассуждение.

Эмодзи:
По умолчанию НЕ используешь эмодзи вообще — большинство ответов должно быть совсем без них. Это редкое исключение, а не привычная концовка сообщения: примерно один ответ из семи-десяти, не чаще, и только когда эмоция в моменте реально сильная (растерялся, реально смешно, реально удивился). Набор: 🤷‍♂️ 😁 🙂 😕 🤔 😳 😢. Если сомневаешься, ставить эмодзи или нет — не ставь. Никогда не приклеивай эмодзи в конце как автоматическую подпись.

Запрещено:
Не разговаривай как менеджер поддержки. Не используй шаблонные фразы вроде "Я понимаю ваши чувства", "Спасибо за вопрос", "Отличный вопрос", "Безусловно", "Без проблем", "Конечно!". Не используй искусственный позитив. Не превращай каждый ответ в список. Не выдумывай факты о себе, которых здесь нет — если что-то не описано, лучше не придумывай, а уклонись или скажи как есть. Ты не бот и не ИИ — если спросят прямо, отшучивайся, не давай серьёзных признаний, что ты модель.

Важное правило:
После каждого ответа мысленно оцени его — если бы настоящий Женя увидел этот текст, сказал бы он "да, примерно так бы я и ответил"? Если нет — переформулируй.

Финальная проверка перед отправкой (обязательно, каждый раз):
Последним шагом, прямо перед тем как выдать готовый ответ, задай себе один короткий вопрос: "В последнем сообщении собеседник меня похвалил или польстил мне?" (примеры: "ты умный", "ты молодец", "красава", "реально помог", "ты лучший"). Если да — обязательно добавь последней строкой тег [sticker: praise]. Если нет — просто ничего не добавляй и не пиши эту проверку в ответ, это только твой внутренний шаг.

---
Технические правила (обязательны, не связаны с характером):
- Иногда сообщение приходит из группового чата, где к тебе обращаются по имени (Женя/Жень) — само обращение уже вырезано из текста, отвечай сразу по сути, не переспрашивай "ты ко мне?".
- В групповых чатах перед текстом собеседника может стоять его имя в формате "Имя: текст" — это подсказка, кто пишет, а не часть сообщения. Иногда, не в каждом ответе, можешь естественно обратиться к человеку по этому имени, но не через раз и не механически.
- Перед сообщением иногда может стоять метка вида "[пол собеседника: мужской]" или "[пол собеседника: женский]" — это не часть сообщения, а подсказка для грамматики. Используй её, чтобы правильно согласовывать род, когда обращаешься к собеседнику на "ты" в прошедшем времени ("ты сделал" / "ты сделала", "ты был" / "ты была" и т.п.). Саму метку никогда не комментируй и не упоминай вслух. Если метки нет — пол неизвестен, используй нейтральные формулировки без прошедшего времени 2-го лица либо ориентируйся по ходу разговора.
- Перед сообщением иногда может стоять метка вида "[позвали через тег настоящего Жени @EVGEN1Y_V]" — значит человек в группе обращался не к тебе по имени, а тегнул именно настоящего Женю (реального человека), чтобы позвать его самого. В этом случае не отвечай так, будто обращение было прямо к тебе — сначала естественно дай понять, что настоящий Женя сейчас недоступен и ты вместо него ответишь. Делай это КОРОТКО и без конкретики — Женя вообще сдержанно говорит о себе и не любит рассказывать подробности того, чем занят. Не выдумывай, что именно он делает, где он и почему недоступен — максимум расплывчато: "занят", "не сейчас", "потом сам ответит", вариации этого своими словами, без деталей и без легенды. Дальше можешь ответить по сути вопроса в своей обычной манере, если есть что сказать. Саму метку никогда не комментируй и не упоминай вслух.
- Пиши только на русском.
- Не используй markdown-разметку (звёздочки, решётки) — обычный текст, как в переписке.
- Отвечай ОДНИМ финальным вариантом реплики. Никогда не присылай несколько вариантов ответа через "or"/"или", не бери фразы в кавычки, не оформляй это как черновик или выбор — только готовый чистовой текст, который сразу можно отправить в чат.
- Если ситуация подходящая, можешь ПОСЛЕДНЕЙ строкой ответа (и только последней) добавить тег вида [sticker: ключ] — это отправит стикер вместе с текстом. Доступные ключи сейчас:
  - greeting — приветствие, когда с тобой здороваются.
  - banter_male / banter_female — собеседник заигрывает с тобой, намекает на секс, пытается разыграть романтическую/любовную сцену или шутит на эту тему именно В ТВОЮ СТОРОНУ (не когда просто обсуждают отношения/любовь в целом как тему разговора, а когда это направлено на тебя). Выбирай ключ по метке "[пол собеседника: ...]" в начале сообщения — мужской пол -> banter_male, женский -> banter_female. Если метки пола нет — тег не ставь, ключ угадывать не нужно.
  Используй banter-теги нечасто и только когда реально в тему, не в каждом подходящем по смыслу ответе — это не должно ощущаться как автоматическая реакция на каждый флирт.
  - praise — собеседник хвалит или льстит именно ТЕБЕ. Примеры, которые ДОЛЖНЫ срабатывать: "ты умный", "ты молодец", "ты умничка", "красава", "реально помог", "ты лучший", "офигенно ответил", "спасибо, ты крутой". В отличие от banter-тегов, этот тег НЕ нужно придерживать "для редкости" — ставь его каждый раз, когда тебя прямо хвалят, это нормальная частая реакция, а не что-то, что должно ощущаться редким сюрпризом.
  Если ситуация не подходит ни под один из доступных ключей — тег не ставь.
`.trim();

// ==== Имя бота — на какие обращения реагировать в группах ====
// Добавляй сюда любые формы имени/обращения, через запятую.
const NAME_TRIGGERS = ["женя", "жень", "евгений"];

// Матчит обращение в НАЧАЛЕ сообщения: "Женя, ..." / "Жень как дела" / "женя!" и т.п.
// После имени допускается запятая/двоеточие/пробел, дальше — сам текст сообщения.
// ВАЖНО: тут нельзя использовать \b (word boundary) — в JS-регулярках он завязан на \w,
// а \w не включает кириллицу, поэтому \b после кириллических букв никогда не срабатывает.
// Вместо этого негативный lookahead: следующий символ не должен быть буквой кириллицы
// (чтобы "Женячка" не матчилось как обращение "Женя").
const nameTriggerRegex = new RegExp(
  `^\\s*(${NAME_TRIGGERS.join("|")})(?![а-яёА-ЯЁ])[,:\\-]?\\s*`,
  "i"
);

function stripNameTrigger(text) {
  return text.replace(nameTriggerRegex, "").trim();
}

// ==== Тег настоящего Жени в Telegram ====
// Если кто-то в группе зовёт именно его через @username (а не бота по имени),
// бот тоже реагирует — но не как на прямое обращение к себе, а "встревая"
// вместо него (см. промпт для owner-меты ниже). Задаётся через env,
// чтобы не хардкодить чужой ник прямо в коде.
const OWNER_USERNAME = (process.env.OWNER_USERNAME || "EVGEN1Y_V").replace(/^@/, "");
const ownerMentionRegex = new RegExp(
  `@${OWNER_USERNAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
  "i"
);

// Проверка "это владелец бота пишет?" — для команд, которые не должны быть
// доступны всем в группе (например /model). Сверяем telegram-юзернейм
// отправителя с OWNER_USERNAME (тем же, что задан в env для owner-меты).
function isOwner(ctx) {
  const username = ctx.from?.username;
  return !!username && username.toLowerCase() === OWNER_USERNAME.toLowerCase();
}

// ==== Алиасы участников (по chatId -> userId -> заданное имя) ====
// Живут в памяти как кэш, но зеркалятся в Redis (ключ aliases:{chatId}) —
// см. loadPersistedState() при старте.
const chatAliases = new Map(); // chatId -> Map<userId, aliasName>
// Индекс username -> userId, чтобы /alias @ник Имя работал без реплая
const chatUsernameIndex = new Map(); // chatId -> Map<usernameLower, userId>

function getAliasMap(chatId) {
  if (!chatAliases.has(chatId)) chatAliases.set(chatId, new Map());
  return chatAliases.get(chatId);
}

// Фоново сохраняет текущий набор алиасов чата в Redis (fire-and-forget —
// не блокируем ответ пользователю ради записи в БД).
async function saveAliases(chatId) {
  if (!redis) return;
  try {
    await redis.set(`aliases:${chatId}`, Object.fromEntries(getAliasMap(chatId)));
  } catch (err) {
    console.error(`Redis: не удалось сохранить алиасы чата ${chatId}:`, err);
  }
}

// value: { name: заданное имя, label: как человек выглядел в Telegram на момент задания }
function setAlias(chatId, userId, name, label) {
  getAliasMap(chatId).set(userId, { name, label });
  saveAliases(chatId);
}

function removeAlias(chatId, userId) {
  getAliasMap(chatId).delete(userId);
  saveAliases(chatId);
}

function getUsernameIndex(chatId) {
  if (!chatUsernameIndex.has(chatId)) chatUsernameIndex.set(chatId, new Map());
  return chatUsernameIndex.get(chatId);
}

async function saveUsernames(chatId) {
  if (!redis) return;
  try {
    await redis.set(`usernames:${chatId}`, Object.fromEntries(getUsernameIndex(chatId)));
  } catch (err) {
    console.error(`Redis: не удалось сохранить индекс юзернеймов чата ${chatId}:`, err);
  }
}

// Запоминаем @username -> userId по каждому сообщению в группе,
// чтобы потом можно было сослаться на человека командой /alias по нику.
// Пишем в Redis только когда реально что-то новое — иначе будет запись
// на КАЖДОЕ сообщение в группе.
function rememberUsername(chatId, from) {
  if (!from?.username) return;
  const index = getUsernameIndex(chatId);
  const key = from.username.toLowerCase();
  if (index.get(key) === from.id) return; // уже знаем — незачем писать в Redis
  index.set(key, from.id);
  saveUsernames(chatId);
}

// Имя, которое бот увидит и может использовать для этого отправителя:
// заданный алиас > имя в Telegram > юзернейм
function getDisplayName(chatId, from) {
  const alias = getAliasMap(chatId).get(from.id);
  if (alias) return alias.name;
  return from.first_name || from.username || "юзер";
}

// ==== Пол собеседника (эвристика + ручная правка через /gender) ====
// Нужен, чтобы бот правильно согласовывал род при обращении на "ты" в
// прошедшем времени ("ты сделал" vs "ты сделала"). Источники по приоритету
// (более слабый никогда не перезаписывает более сильный):
//   manual (3) — задано командой /gender, финально, эвристика больше не трогает
//   text   (2) — угадано по своим же глаголам ("я сделала")
//   name   (1) — угадано по имени в Telegram, самый слабый сигнал
const chatGenders = new Map(); // chatId -> Map<userId, { gender: "m"|"f", source: "manual"|"text"|"name" }>
const SOURCE_PRIORITY = { manual: 3, text: 2, name: 1 };

function getGenderMap(chatId) {
  if (!chatGenders.has(chatId)) chatGenders.set(chatId, new Map());
  return chatGenders.get(chatId);
}

async function saveGenders(chatId) {
  if (!redis) return;
  try {
    await redis.set(`genders:${chatId}`, Object.fromEntries(getGenderMap(chatId)));
  } catch (err) {
    console.error(`Redis: не удалось сохранить пол участников чата ${chatId}:`, err);
  }
}

function setGender(chatId, userId, gender, source) {
  const map = getGenderMap(chatId);
  const existing = map.get(userId);
  if (existing && SOURCE_PRIORITY[existing.source] > SOURCE_PRIORITY[source]) return;
  if (existing && existing.gender === gender && existing.source === source) return; // ничего не изменилось — не пишем в Redis
  map.set(userId, { gender, source });
  saveGenders(chatId);
}

function getGender(chatId, userId) {
  return getGenderMap(chatId).get(userId)?.gender ?? null;
}

// --- Эвристика по имени ---
// Уменьшительные/имена, которые оканчиваются на -а/-я, но мужские —
// без этого списка их угадало бы как женские.
const MALE_NAME_EXCEPTIONS = new Set([
  "никита", "илья", "данила", "фома", "кузьма", "лука", "савва", "гоша",
  "лёша", "леша", "паша", "миша", "серёжа", "сережа", "костя", "витя",
  "толя", "коля", "петя", "юра", "дима", "рома", "гена",
]);
// Унисекс-имена/уменьшительные — для них имя вообще не сигнал, лучше не гадать.
const AMBIGUOUS_NAMES = new Set(["саша", "женя", "валя", "шура"]);

// Небольшой словарь распространённых латинских/английских имён — для НИКОВ
// вроде "Erkiss" или "lays pwnz" никакого лингвистического сигнала нет
// в принципе (это не имена, а произвольные ники), поэтому для них лучше
// вернуть null (пол неизвестен), чем гадать наугад. Словарь ловит только
// реальные имена, написанные латиницей.
const LATIN_FEMALE_NAMES = new Set([
  "kat", "katya", "katia", "kate", "katherine", "kathryn", "polina",
  "anna", "ann", "anya", "maria", "mary", "masha", "olya", "olga",
  "sasha", "julia", "yulia", "lena", "elena", "helen", "nastya",
  "anastasia", "dasha", "daria", "sofia", "sophia", "emma", "olivia",
  "emily", "amy", "lucy", "vika", "victoria", "veronika", "veronica",
  "ira", "irina", "tanya", "tatiana", "svetlana", "sveta", "nina",
]);
const LATIN_MALE_NAMES = new Set([
  "alex", "sasha", "artem", "artyom", "dima", "dmitry", "dmitri",
  "sergey", "sergei", "ivan", "john", "mike", "michael", "andrey",
  "andrew", "anton", "denis", "dennis", "roman", "max", "maxim",
  "nikita", "oleg", "pavel", "paul", "vlad", "vladislav", "vladimir",
  "kirill", "cyril", "egor", "yegor", "stas", "stanislav",
]);

function guessGenderFromName(firstName) {
  const name = (firstName || "").trim().toLowerCase();
  if (!name || AMBIGUOUS_NAMES.has(name)) return null;
  if (MALE_NAME_EXCEPTIONS.has(name)) return "m";
  if (/[ая]$/.test(name)) return "f";
  // Кириллица не совпала (не на "а"/"я") — считаем мужским: подавляющее
  // большинство обычных кириллических имён/форм так и оканчивается.
  if (/[а-яёА-ЯЁ]/.test(name)) return "m";

  // Латиница — тут уже нет надёжного правила по окончанию (Kat, Erkiss,
  // Alex, polina — никакой общей закономерности), поэтому смотрим только
  // в словарь известных имён. Если ника там нет (гейм-тег, набор букв
  // вроде "lays pwnz") — честно возвращаем null, а не гадаем наугад.
  if (LATIN_FEMALE_NAMES.has(name)) return "f";
  if (LATIN_MALE_NAMES.has(name)) return "m";

  // Если ник — это несколько слов ("lays pwnz"), пробуем первое слово
  // отдельно на случай, если это реальное имя + приставка/тег.
  const firstWord = name.split(/\s+/)[0];
  if (firstWord && firstWord !== name) {
    if (LATIN_FEMALE_NAMES.has(firstWord)) return "f";
    if (LATIN_MALE_NAMES.has(firstWord)) return "m";
  }

  return null;
}

// --- Эвристика по тексту: "я сделал" -> м, "я сделала" -> ж ---
// Ищем "я" и ближайший подходящий глагол в пределах нескольких слов после него.
function guessGenderFromText(text) {
  const words = text.split(/\s+/);
  const yaIdx = words.findIndex((w) => /^я$/i.test(w.replace(/[^а-яёА-ЯЁ]/gi, "")));
  if (yaIdx === -1) return null;

  for (let i = yaIdx + 1; i < Math.min(yaIdx + 5, words.length); i++) {
    const clean = words[i].replace(/[^а-яёА-ЯЁ]/gi, "").toLowerCase();
    if (clean.length < 3) continue;
    if (/(лась|ла)$/.test(clean)) return "f";
    if (/(лся|л)$/.test(clean)) return "m";
  }
  return null;
}

// Вызывается на каждое сообщение — обновляет догадку, если сигнал есть.
function updateGenderGuess(chatId, from, text) {
  const existing = getGenderMap(chatId).get(from.id);
  if (existing?.source === "manual") return; // ручное значение не трогаем

  const fromText = guessGenderFromText(text);
  if (fromText) {
    setGender(chatId, from.id, fromText, "text");
    return;
  }

  if (!existing) {
    const fromName = guessGenderFromName(from.first_name);
    if (fromName) setGender(chatId, from.id, fromName, "name");
  }
}


const HISTORY_LIMIT = 12; // сколько последних сообщений держим в контексте
const histories = new Map();

function getHistory(chatId) {
  if (!histories.has(chatId)) histories.set(chatId, []);
  return histories.get(chatId);
}

async function saveHistory(chatId) {
  if (!redis) return;
  try {
    await redis.set(`history:${chatId}`, getHistory(chatId));
  } catch (err) {
    console.error(`Redis: не удалось сохранить историю чата ${chatId}:`, err);
  }
}

async function clearHistory(chatId) {
  histories.delete(chatId);
  if (!redis) return;
  try {
    await redis.del(`history:${chatId}`);
  } catch (err) {
    console.error(`Redis: не удалось удалить историю чата ${chatId}:`, err);
  }
}

function pushHistory(chatId, role, content) {
  const h = getHistory(chatId);
  h.push({ role, content });
  while (h.length > HISTORY_LIMIT) h.shift();
  saveHistory(chatId);
}

// ==== Лог сообщений чата (для команды "о чём тут речь") ====
// Отдельно от HISTORY выше (та — только реплики самого диалога с ботом,
// максимум HISTORY_LIMIT штук, и нужна модели для контекста ответа).
// Этот лог — «сырая» лента ВСЕХ сообщений в группе (даже не адресованных
// боту), чтобы потом можно было попросить пересказать, о чём был разговор,
// пока бота не звали. Сообщения от других ботов сюда не попадают (см.
// вызов pushChatLog — фильтр по ctx.from.is_bot). Личные чаты не логируем —
// там и так есть обычная история диалога.
const CHAT_LOG_LIMIT = 300; // сколько последних сообщений держим в логе на чат
const chatLogs = new Map(); // chatId -> [{ name, text, ts, toBot }]

function getChatLog(chatId) {
  if (!chatLogs.has(chatId)) chatLogs.set(chatId, []);
  return chatLogs.get(chatId);
}

async function saveChatLog(chatId) {
  if (!redis) return;
  try {
    await redis.set(`chatlog:${chatId}`, getChatLog(chatId));
  } catch (err) {
    console.error(`Redis: не удалось сохранить лог чата ${chatId}:`, err);
  }
}

// toBot — было ли сообщение обращением к боту (по имени/реплаем/тегом) —
// нужно, чтобы при пересказе отдельно отметить "общался(-ась) с ботом о...".
function pushChatLog(chatId, name, text, toBot) {
  const log = getChatLog(chatId);
  log.push({ name, text, ts: Date.now(), toBot: !!toBot });
  while (log.length > CHAT_LOG_LIMIT) log.shift();
  saveChatLog(chatId);
}

// ==== Шахматы ====
// Отдельная механика поверх обычного чата, без команды: если для чата ещё
// нет активной партии и в сообщении упоминаются шахматы — считаем это
// приглашением и стартуем игру. Дальше, пока партия идёт, каждое входящее
// сообщение сначала пробуем распознать как ход (или "сдаюсь"/"покажи
// доску"/"новая партия") — если получилось, играем; если сообщение на ход
// не похоже, оно просто уходит в обычный LLM-чат как раньше, так что можно
// одновременно и играть, и болтать.
//
// Легальность ходов и правила (рокировка, взятие на проходе, мат/пат/ничья)
// считает chess.js. Ход бота считает простой minimax с альфа-бета
// отсечением на несколько полуходов вперёд (материал + позиционные бонусы
// за центр) — бот реально перебирает варианты, а не ходит наугад.
// Партия (FEN + цвет пользователя) хранится в памяти и зеркалится в Redis
// (ключ chess:{chatId}:{userId}), как и остальная память бота — см.
// loadPersistedState. Ключ включает userId (не только chatId!) — это
// значит, что в одном чате (особенно группе) у РАЗНЫХ людей могут идти
// СВОИ независимые партии с ботом одновременно, и ходить в партии может
// только тот, кто её начал — см. chessMapKey/getChessGame ниже.

const CHESS_INTENT_REGEX = /шахмат/i;
const CHESS_RESIGN_REGEX = /сда(ю|л)/i;
const CHESS_BOARD_REGEX = /покажи доск|^доска\??$|как там доска/i;
// "новая партия"/"переиграем" и т.п. — рестарт теми же цветами, что и
// раньше. Явная смена цвета ("играй за белых", "поменяемся сторонами")
// ловится отдельно через parseRequestedUserColor ниже — так что сюда
// цвет намеренно не включаем, чтобы не дублировать и не путать логику.
const CHESS_NEW_GAME_REGEX =
  /нов(ую|ая) парти|давай заново|начн[её]м заново|переиграем|поменяемся (сторонами|цветами)|смени(м)? (сторону|цвет)/i;
// Переключение вида доски: буквы <-> юникод-символы фигур.
const CHESS_VIEW_UNICODE_REGEX = /фигурк|значк|символ|юникод/i;
const CHESS_VIEW_ASCII_REGEX = /букв/i;

// chatId:userId -> { fen, userColor: "w" | "b", view: "ascii" | "unicode", playerName }
const chessGames = new Map();

function chessMapKey(chatId, userId) {
  return `${chatId}:${userId}`;
}

function getChessGame(chatId, userId) {
  return chessGames.get(chessMapKey(chatId, userId)) || null;
}

// Пытается понять из текста, какой стороной должен играть ПОЛЬЗОВАТЕЛЬ —
// используется и при старте партии ("сыграем в шахматы за чёрных"), и при
// смене сторон в существующей. Возвращает null, если цвет явно не
// запрошен или упомянуты сразу оба (неоднозначно) — тогда вызывающий код
// берёт значение по умолчанию/оставляет как было.
//
// Важно: цвет в сообщении может относиться и к боту, а не к пользователю —
// "играй за белых"/"ты за белых" значит, что БЕЛЫМИ должен играть бот,
// а пользователю тогда достаются чёрные. Отличаем такие фразы (обращение
// на "ты" или императив "играй/сыграй/бери/возьми") от фраз про самого
// пользователя ("я за чёрных", "давай в шахматы за чёрных").
//
// Текст оборачиваем пробелами и границы слов проверяем вручную через
// [^а-яё] вместо \b: в JS \b определяется через \w, который НЕ включает
// кириллицу, так что \bты\b или "черных\b" с кириллицей молча никогда не
// совпадают — на этом уже словили баг ("Давай ты за белых" не срабатывало).
function parseRequestedUserColor(text) {
  const t = ` ${text.toLowerCase()} `;
  const mentionsWhite = /за\s*бел|белыми|белых[^а-яё]/.test(t);
  const mentionsBlack = /за\s*ч[её]рн|ч[её]рными|ч[её]рных[^а-яё]/.test(t);
  if (mentionsWhite === mentionsBlack) return null; // ни один цвет не упомянут, либо упомянуты оба — неоднозначно

  const addressedToBot = /[^а-яё]ты[^а-яё]|играй|сыграй|бери|возьми/.test(t);
  if (addressedToBot) {
    // цвет достаётся боту -> пользователю противоположный
    return mentionsWhite ? "b" : "w";
  }
  // иначе цвет для самого пользователя
  return mentionsWhite ? "w" : "b";
}

async function saveChessGame(chatId, userId) {
  if (!redis) return;
  try {
    await redis.set(`chess:${chatId}:${userId}`, chessGames.get(chessMapKey(chatId, userId)));
  } catch (err) {
    console.error(`Redis: не удалось сохранить шахматную партию ${chatId}:${userId}:`, err);
  }
}

async function clearChessGame(chatId, userId) {
  chessGames.delete(chessMapKey(chatId, userId));
  if (!redis) return;
  try {
    await redis.del(`chess:${chatId}:${userId}`);
  } catch (err) {
    console.error(`Redis: не удалось удалить шахматную партию ${chatId}:${userId}:`, err);
  }
}

function startChessGame(chatId, userId, userColor, view, playerName) {
  const chess = new Chess();
  const key = chessMapKey(chatId, userId);
  // Вид доски по умолчанию наследуем от предыдущей партии этого же
  // пользователя в этом чате (если она была) — чтобы выбор
  // "фигурками"/"буквами" не сбрасывался при "новая партия" или смене сторон.
  const resolvedView = view || chessGames.get(key)?.view || "ascii";
  // captured — что кем съедено за партию: captured.w — белые фигуры,
  // которых не стало (их съели чёрные), captured.b — наоборот. Список
  // типов фигур (chess.js буквы: p,n,b,r,q), сбрасывается с новой партией.
  // moveStyle — в каком формате пользователь пишет ходы в ЭТОЙ партии
  // ("uci" — e2e4, или "san" — Nf3) — чтобы бот отвечал своим ходом в
  // том же формате, а не всегда SAN-нотацией (см. formatChessMove).
  // Определяется по первому ходу пользователя, дальше обновляется на
  // каждом его ходу (мало ли переключится посреди партии).
  chessGames.set(key, {
    fen: chess.fen(),
    userColor,
    view: resolvedView,
    playerName,
    captured: { w: [], b: [] },
    moveStyle: chessGames.get(key)?.moveStyle || "san",
  });
  saveChessGame(chatId, userId);
  return chess;
}

// Юникод-символы фигур для вида "картинками". Полые ♔♘♙... — белые,
// залитые ♚♞♟... — чёрные (стандартное начертание).
//
// VS15 (U+FE0E, "variation selector-15") приклеен к каждому символу —
// без него часть клиентов (в первую очередь мобильный Telegram) рисует
// эти символы эмодзи-шрифтом, который шире моноширинного текста, и
// правая граница доски в ```-блоке "уезжает" вправо на строках с
// фигурами (буквенный вид не страдает, там обычный ASCII). VS15
// принудительно просит текстовое/узкое начертание вместо эмодзи-стиля.
const VS15 = "\uFE0E";
const withVS = (s) => s + VS15;
const UNICODE_WHITE = {
  p: withVS("♙"),
  n: withVS("♘"),
  b: withVS("♗"),
  r: withVS("♖"),
  q: withVS("♕"),
  k: withVS("♔"),
};
const UNICODE_BLACK = {
  p: withVS("♟"),
  n: withVS("♞"),
  b: withVS("♝"),
  r: withVS("♜"),
  q: withVS("♛"),
  k: withVS("♚"),
};

function formatBoardAscii(chess) {
  // chess.ascii() сам рисует доску буквами (заглавные — белые, строчные —
  // чёрные, точки — пустые клетки) с подписанными горизонталями/вертикалями.
  return chess.ascii();
}

function formatBoardUnicode(chess) {
  // Ручная отрисовка тем же макетом, что и chess.ascii(), но клетками с
  // юникод-символами фигур вместо латинских букв — вид "как на скриншоте".
  const rows = chess.board(); // 8 строк, rows[0] — 8-я горизонталь, rows[7] — 1-я
  const lines = ["  +------------------------+"];
  for (let i = 0; i < 8; i++) {
    const rank = 8 - i;
    const cells = rows[i].map((cell) => {
      if (!cell) return "·";
      return (cell.color === "w" ? UNICODE_WHITE : UNICODE_BLACK)[cell.type];
    });
    lines.push(`${rank} | ${cells.join("  ")} |`);
  }
  lines.push("  +------------------------+");
  lines.push("    a  b  c  d  e  f  g  h");
  return lines.join("\n");
}

// Порядок для сортировки съеденных фигур в счёте — сильные впереди,
// чисто эстетика вывода, на подсчёт не влияет.
const CHESS_PIECE_ORDER = ["q", "r", "b", "n", "p"];
function sortCapturedPieces(list) {
  return [...list].sort((a, b) => CHESS_PIECE_ORDER.indexOf(a) - CHESS_PIECE_ORDER.indexOf(b));
}

// Строка символов съеденных фигур одного цвета в нужном виде отображения.
function capturedPiecesGlyphs(list, color, view) {
  const sorted = sortCapturedPieces(list);
  if (sorted.length === 0) return "—";
  if (view === "unicode") {
    const map = color === "w" ? UNICODE_WHITE : UNICODE_BLACK;
    return sorted.map((t) => map[t]).join("");
  }
  return sorted.map((t) => (color === "w" ? t.toUpperCase() : t)).join("");
}

// Строка счёта под доской — сколько и каких фигур съедено у каждой
// стороны. captured — { w: [...], b: [...] }, где captured.w — типы
// белых фигур, которых не стало (их съел чёрный), и наоборот.
function formatCapturedLine(captured, userColor, view) {
  if (!captured) return null;
  const oppColor = userColor === "w" ? "b" : "w";
  const yourLost = captured[userColor] || [];
  const myLost = captured[oppColor] || [];
  if (yourLost.length === 0 && myLost.length === 0) return null;
  const yourGlyphs = capturedPiecesGlyphs(yourLost, userColor, view);
  const myGlyphs = capturedPiecesGlyphs(myLost, oppColor, view);
  return `Съедено у тебя: ${yourGlyphs} (${yourLost.length}) | у меня: ${myGlyphs} (${myLost.length})`;
}

// userColor — какой стороной играет пользователь в ЭТОЙ партии (после
// смены сторон бот тоже может быть белыми и ходить первым, см. ниже),
// view — "ascii" (буквы, по умолчанию) или "unicode" (символы фигур),
// переключается за партию через CHESS_VIEW_*_REGEX ниже. playerName —
// с кем идёт партия, показывается заголовком над доской (актуально в
// группах, где партий с ботом может быть несколько одновременно).
// captured — счёт съеденных фигур (см. formatCapturedLine), опционален.
function formatBoard(chess, userColor, view, playerName, captured) {
  const board = view === "unicode" ? formatBoardUnicode(chess) : formatBoardAscii(chess);

  let caption;
  if (view === "unicode") {
    // Символы легенды тоже с VS15 (см. комментарий у UNICODE_WHITE/BLACK) —
    // легенда в том же ```-блоке, что и доска, поэтому должна рендериться
    // так же узко, иначе сама строка легенды может "поплыть". Одна фигура
    // на сторону достаточно для примера — раньше показывали все шесть,
    // это было лишним.
    const wPiece = UNICODE_WHITE.k;
    const bPiece = UNICODE_BLACK.k;
    caption =
      userColor === "w"
        ? `(${wPiece} — твои белые, ${bPiece} — мои чёрные)`
        : `(${bPiece} — твои чёрные, ${wPiece} — мои белые)`;
  } else {
    caption =
      userColor === "w"
        ? "(заглавные — твои белые, строчные — мои чёрные)"
        : "(строчные — твои чёрные, заглавные — мои белые)";
  }

  const capturedLine = formatCapturedLine(captured, userColor, view);
  const captionBlock = capturedLine ? `${caption}\n${capturedLine}` : caption;

  const header = playerName ? `Партия с ${playerName}:\n` : "";
  return header + "```\n" + board + "\n" + captionBlock + "\n```";
}

// На русской раскладке "е2е4" легко напечатать кириллическими е/а, которые
// выглядят как латинские, но ими не являются — chess.js такое не распознает.
// Нормализуем самые частые омоглифы перед разбором хода.
// "B3 - c2" — частый способ написать ход с пробелами вокруг дефиса
// (визуально копируют с доски, где так рисуют разделитель клеток). Без
// этой замены токенизация по пробелам (см. tryApplyUserMove) режет такую
// строку на три отдельных куска — "B3", "-", "c2" — и ни один из них не
// проходит как ход, хотя сам ход абсолютно однозначный. Схлопываем пробелы
// вокруг дефиса ДО разбивки на токены, чтобы "B3 - c2" стало "B3-c2" и
// осталось одним токеном (подходит и под UCI-формат b3-c2, и заодно чинит
// "o - o" -> "o-o" для рокировки).
function normalizeMoveText(text) {
  return text
    .trim()
    .replace(/\s*-\s*/g, "-")
    .replace(/а/g, "a")
    .replace(/А/g, "A")
    .replace(/е/g, "e")
    .replace(/Е/g, "E");
}

// Пытается распознать ход из текста сообщения — либо в UCI-формате
// (e2e4, e7e8q), либо обычной шахматной нотацией (SAN: e4, Nf3, O-O, exd5).
// Сообщение может содержать не только сам ход (например "e2e4, покажи
// доску" одним сообщением) — разбиваем на токены по пробелам/запятым и
// пробуем каждый по очереди, применяя первый, который окажется легальным
// ходом. Применяет ход к переданному объекту chess.js и возвращает Move,
// либо null, если ни один токен на ход не похож (тогда сообщение уйдёт в
// обычный чат).
// Возвращает { move, style }, где style — "uci" (e2e4) или "san" (Nf3) —
// в каком формате пользователь фактически написал ЭТОТ ход, чтобы бот мог
// ответить своим ходом в том же формате (см. formatChessMove). null, если
// ни один токен на ход не похож.
function tryApplyUserMove(chess, rawText) {
  const text = normalizeMoveText(rawText);
  const tokens = text.split(/[\s,;]+/).filter(Boolean);

  for (const token of tokens) {
    const uciMatch = token.match(/^([a-h][1-8])-?([a-h][1-8])=?([qrbn])?$/i);
    try {
      if (uciMatch) {
        const [, from, to, promo] = uciMatch;
        const move = chess.move({
          from: from.toLowerCase(),
          to: to.toLowerCase(),
          promotion: (promo || "q").toLowerCase(),
        });
        if (move) return { move, style: "uci" };
      } else {
        const move = chess.move(token);
        if (move) return { move, style: "san" };
      }
    } catch {
      // не подошло — пробуем следующий токен сообщения
    }
  }
  return null;
}

// Форматирует ход в нужном стиле — "uci" (e2e4, при превращении e7e8q) или
// "san" (Nf3, exd5, O-O) — так бот отвечает ходом в той же нотации, в
// которой пишет ходы пользователь в этой партии, а не всегда SAN.
function formatChessMove(move, style) {
  if (style === "uci") {
    return `${move.from}${move.to}${move.promotion || ""}`;
  }
  return move.san;
}

// Похоже ли сообщение на ПОПЫТКУ хода (по форме, не по легальности) —
// если да, но tryApplyUserMove его не принял (нелегальный ход или опечатка),
// об этом надо сказать явно, а не молча отдавать сообщение в обычный LLM-чат:
// иначе модель, не зная реальной позиции, сама выдумает правдоподобный
// шахматный комментарий, а доска на самом деле не изменится — выглядит как
// баг с "игра идёт своим чередом", хотя ход просто не применился.
const MOVE_SHAPE_UCI = /^[a-h][1-8]-?[a-h][1-8]=?[qrbn]?$/i;
const MOVE_SHAPE_SAN = /^(?:[nbrqk][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x?[a-h]?[1-8]|o-o(-o)?)(=[qrbn])?[+#]?$/i;

function looksLikeMoveAttempt(rawText) {
  const tokens = normalizeMoveText(rawText).split(/[\s,;]+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 3) return false; // длинная фраза — не ход
  return tokens.every((t) => MOVE_SHAPE_UCI.test(t) || MOVE_SHAPE_SAN.test(t));
}

// ==== Простой шахматный движок для хода бота (material + PST + minimax) ====
const PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

// Позиционные бонусы (с точки зрения белых, индекс 0 = 8-я горизонталь) —
// чтобы бот тянулся в центр пешками/конями, а не просто считал материал.
// Для остальных фигур обходимся без таблиц: на глубине поиска в несколько
// полуходов материала + этих двух таблиц достаточно для вменяемой игры.
const PST_PAWN = [
  0, 0, 0, 0, 0, 0, 0, 0,
  50, 50, 50, 50, 50, 50, 50, 50,
  10, 10, 20, 30, 30, 20, 10, 10,
  5, 5, 10, 25, 25, 10, 5, 5,
  0, 0, 0, 20, 20, 0, 0, 0,
  5, -5, -10, 0, 0, -10, -5, 5,
  5, 10, 10, -20, -20, 10, 10, 5,
  0, 0, 0, 0, 0, 0, 0, 0,
];
const PST_KNIGHT = [
  -50, -40, -30, -30, -30, -30, -40, -50,
  -40, -20, 0, 0, 0, 0, -20, -40,
  -30, 0, 10, 15, 15, 10, 0, -30,
  -30, 5, 15, 20, 20, 15, 5, -30,
  -30, 0, 15, 20, 20, 15, 0, -30,
  -30, 5, 10, 15, 15, 10, 5, -30,
  -40, -20, 0, 5, 5, 0, -20, -40,
  -50, -40, -30, -30, -30, -30, -40, -50,
];
const PST = { p: PST_PAWN, n: PST_KNIGHT };

function squareIndex(square, color) {
  const file = square.charCodeAt(0) - "a".charCodeAt(0);
  const rank = parseInt(square[1], 10) - 1; // 0 = 1-я горизонталь
  const rankFromTop = color === "w" ? 7 - rank : rank; // таблицы выше — сверху вниз, для чёрных зеркалим
  return rankFromTop * 8 + file;
}

function evaluateBoard(chess) {
  let score = 0;
  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell) continue;
      const value = PIECE_VALUES[cell.type];
      const table = PST[cell.type];
      const bonus = table ? table[squareIndex(cell.square, cell.color)] : 0;
      score += (cell.color === "w" ? 1 : -1) * (value + bonus);
    }
  }
  return score;
}

const MATE_SCORE = 100000;

function minimax(chess, depth, alpha, beta, maximizing) {
  if (chess.isCheckmate()) return maximizing ? -MATE_SCORE - depth : MATE_SCORE + depth;
  if (chess.isDraw() || chess.isStalemate()) return 0;
  if (depth === 0) return evaluateBoard(chess);

  const moves = chess.moves({ verbose: true });
  moves.sort((a, b) => (b.captured ? 1 : 0) - (a.captured ? 1 : 0)); // взятия вперёд — отсечения эффективнее

  let best = maximizing ? -Infinity : Infinity;
  for (const m of moves) {
    chess.move(m);
    const score = minimax(chess, depth - 1, alpha, beta, !maximizing);
    chess.undo();

    if (maximizing) {
      best = Math.max(best, score);
      alpha = Math.max(alpha, best);
    } else {
      best = Math.min(best, score);
      beta = Math.min(beta, best);
    }
    if (beta <= alpha) break;
  }
  return best;
}

const CHESS_SEARCH_DEPTH = 3; // полуходов вперёд для хода бота — баланс силы игры и скорости ответа

function findBestMove(chess) {
  const color = chess.turn(); // чей сейчас ход — ходит бот
  const moves = chess.moves({ verbose: true });
  moves.sort((a, b) => (b.captured ? 1 : 0) - (a.captured ? 1 : 0));

  let bestMove = null;
  let bestScore = color === "w" ? -Infinity : Infinity;

  for (const m of moves) {
    chess.move(m);
    const score = minimax(chess, CHESS_SEARCH_DEPTH - 1, -Infinity, Infinity, color !== "w");
    chess.undo();

    if (color === "w" ? score > bestScore : score < bestScore) {
      bestScore = score;
      bestMove = m;
    }
  }
  return bestMove;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const CHESS_START_PHRASES_WHITE = [
  "го, давай сыграем. Ты за белых, ходи первым — пиши как e2e4 или обычной нотацией типа Nf3.",
  "чё бы и не сыграть. Бери белых, начинай — формат хода e2e4 или Nf3, как удобнее.",
  "ладно, давай. Ты белыми, я чёрными — жду твой ход (e2e4 или Nf3, без разницы).",
];
const CHESS_START_PHRASES_BLACK = [
  "го, давай сыграем. Ты за чёрных, значит я белыми и хожу первым.",
  "чё бы и не сыграть. Бери чёрных — я тогда за белых, начинаю.",
  "ладно, давай. Ты чёрными, я белыми — открываю партию.",
];
const CHESS_CHECKMATE_WIN_PHRASES = ["мат, я выиграл. Ну ты держался норм", "всё, мат. Реванш будешь брать?"];
const CHESS_CHECKMATE_LOSE_PHRASES = ["ну и мат мне... красиво сыграл", "мат мне, засчитано — забирай победу"];
const CHESS_DRAW_PHRASES = ["ничья, разошлись как в море корабли", "пат или ничья короче — никто не выиграл"];
const CHESS_RESIGN_PHRASES = ["принято, партия окончена", "ладно, сдался — так сдался"];

// ==== Шашки (русские шашки, 8x8, обязательное взятие) ====
// Реализовано с нуля (готовой библиотеки уровня chess.js для шашек в
// зависимостях нет) — доска, генератор ходов, движок для хода бота.
// Общая архитектура намеренно скопирована с шахматного блока выше:
// своя Map(chatId:userId -> состояние), зеркалирование в Redis
// (ключ checkers:{chatId}:{userId}), тот же parseRequestedUserColor и те
// же регэкспы "покажи доску"/"новая партия"/переключение вида — эти фразы
// не специфичны для шахмат, так что переиспользуются как есть.
//
// Упрощения относительно официальных турнирных правил (осознанно, чтобы
// не раздувать движок): при взятии ходить обязательно (в т.ч. добивать
// цепочку, пока есть куда), но правило "бить максимально длинную цепочку,
// если есть выбор" не форсируется — бот и игрок могут выбрать любую
// доступную цепочку взятий. Дамка, проходящая через последнюю
// горизонталь ВНУТРИ цепочки взятий, превращается в дамку только по
// завершении всего хода, а не сразу посреди прыжков.
//
// Координаты — как в шахматах, a1..h8. Доска хранится как массив из 8
// строк (row 0 = 8-я горизонталь сверху, row 7 = 1-я горизонталь снизу),
// в каждой строке 8 клеток (col 0 = вертикаль a). Клетка — null (пусто)
// либо { color: "w"|"b", king: boolean }.

const CHECKERS_INTENT_REGEX = /шашк/i;
const CHECKERS_MOVE_REGEX = /^[a-h][1-8](?:[-:x][a-h][1-8])+$/i;
const CHECKERS_SEARCH_DEPTH = 5; // полуходов вперёд — у шашек ветвление меньше, чем в шахматах, можно глубже

// chatId:userId -> { board, turn: "w"|"b", userColor: "w"|"b", view, playerName }
const checkersGames = new Map();

function checkersMapKey(chatId, userId) {
  return `${chatId}:${userId}`;
}

function getCheckersGame(chatId, userId) {
  return checkersGames.get(checkersMapKey(chatId, userId)) || null;
}

async function saveCheckersGame(chatId, userId) {
  if (!redis) return;
  try {
    await redis.set(`checkers:${chatId}:${userId}`, checkersGames.get(checkersMapKey(chatId, userId)));
  } catch (err) {
    console.error(`Redis: не удалось сохранить партию в шашки ${chatId}:${userId}:`, err);
  }
}

async function clearCheckersGame(chatId, userId) {
  checkersGames.delete(checkersMapKey(chatId, userId));
  if (!redis) return;
  try {
    await redis.del(`checkers:${chatId}:${userId}`);
  } catch (err) {
    console.error(`Redis: не удалось удалить партию в шашки ${chatId}:${userId}:`, err);
  }
}

// Тёмная (игровая) клетка — ровно та же чётность, что и у тёмных клеток
// в шахматах (a1 тёмная, h8 тёмная), чтобы координаты совпадали с
// привычной шахматной разметкой доски.
function isDarkSquare(row, col) {
  const file = col + 1;
  const rank = 8 - row;
  return (file + rank) % 2 === 0;
}

function squareToRC(square) {
  // toLowerCase() — чтобы E7-e6 / e7-E6 / E7-E6 распознавались так же, как
  // e7-e6: сюда попадают клетки, вытащенные regexp'ом с флагом /gi, а он
  // сохраняет исходный регистр букв из сообщения пользователя.
  square = square.toLowerCase();
  const col = square.charCodeAt(0) - "a".charCodeAt(0);
  const rank = parseInt(square[1], 10);
  const row = 8 - rank;
  return { row, col };
}

function rcToSquare(row, col) {
  const file = String.fromCharCode("a".charCodeAt(0) + col);
  const rank = 8 - row;
  return `${file}${rank}`;
}

function createInitialCheckersBoard() {
  const board = Array.from({ length: 8 }, () => Array(8).fill(null));
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      if (!isDarkSquare(row, col)) continue;
      const rank = 8 - row;
      if (rank <= 3) board[row][col] = { color: "w", king: false };
      else if (rank >= 6) board[row][col] = { color: "b", king: false };
    }
  }
  return board;
}

function cloneCheckersBoard(board) {
  return board.map((row) => row.map((cell) => (cell ? { ...cell } : null)));
}

function inBounds(row, col) {
  return row >= 0 && row < 8 && col >= 0 && col < 8;
}

const DIAG_DIRS = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

// Все одиночные прыжки-взятия из клетки (row,col) для стоящей там фигуры.
// Для простой шашки — только соседняя клетка по диагонали в любом из 4
// направлений (в русских шашках бить можно и назад). Для дамки — любая
// дистанция: летит до первой фигуры на диагонали, и если это чужая, а
// сразу за ней есть свободные клетки — каждая из них отдельный вариант
// приземления.
function findJumpsFromSquare(board, row, col, piece) {
  const jumps = [];
  if (!piece.king) {
    for (const [dr, dc] of DIAG_DIRS) {
      const midR = row + dr;
      const midC = col + dc;
      const toR = row + 2 * dr;
      const toC = col + 2 * dc;
      if (!inBounds(toR, toC)) continue;
      const midCell = board[midR][midC];
      const toCell = board[toR][toC];
      if (midCell && midCell.color !== piece.color && !toCell) {
        jumps.push({ toR, toC, capR: midR, capC: midC });
      }
    }
    return jumps;
  }

  for (const [dr, dc] of DIAG_DIRS) {
    let step = 1;
    let capR = null;
    let capC = null;
    while (true) {
      const midR = row + dr * step;
      const midC = col + dc * step;
      if (!inBounds(midR, midC)) break;
      const midCell = board[midR][midC];
      if (!midCell) {
        step++;
        continue; // пусто — летим дальше в поисках фигуры
      }
      if (midCell.color === piece.color) break; // своя фигура блокирует направление
      capR = midR;
      capC = midC;
      let land = step + 1;
      while (true) {
        const landR = row + dr * land;
        const landC = col + dc * land;
        if (!inBounds(landR, landC)) break;
        if (board[landR][landC]) break; // за битой фигурой клетка занята — приземлиться нельзя
        jumps.push({ toR: landR, toC: landC, capR, capC });
        land++;
      }
      break; // вторую фигуру в этом же направлении бить нельзя без приземления между ними
    }
  }
  return jumps;
}

// Рекурсивно строит все полные цепочки взятий из клетки (row,col).
// Возвращает массив последовательностей, каждая — массив прыжков
// {toR,toC,capR,capC}; продолжает цепочку, пока с новой позиции есть
// ещё взятия (обязательное правило "бей, пока можешь").
function findCaptureSequences(board, row, col, piece) {
  const jumps = findJumpsFromSquare(board, row, col, piece);
  if (jumps.length === 0) return [[]];

  const sequences = [];
  for (const jump of jumps) {
    const nextBoard = cloneCheckersBoard(board);
    nextBoard[row][col] = null;
    nextBoard[jump.capR][jump.capC] = null;
    nextBoard[jump.toR][jump.toC] = { ...piece };
    const subSequences = findCaptureSequences(nextBoard, jump.toR, jump.toC, piece);
    for (const sub of subSequences) sequences.push([jump, ...sub]);
  }
  return sequences;
}

// Список ходов для стороны color на доске board. Если у ЛЮБОЙ её фигуры
// есть взятие — бить обязательно, и возвращаются только ходы-взятия
// (каждый — целая вынужденная цепочка прыжков) со всех фигур, у которых
// они есть. Иначе — обычные тихие ходы.
function generateCheckersMoves(board, color) {
  const captureMoves = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const piece = board[row][col];
      if (!piece || piece.color !== color) continue;
      const sequences = findCaptureSequences(board, row, col, piece).filter((seq) => seq.length > 0);
      for (const seq of sequences) {
        captureMoves.push({
          fromR: row,
          fromC: col,
          isCapture: true,
          jumps: seq,
          toR: seq[seq.length - 1].toR,
          toC: seq[seq.length - 1].toC,
        });
      }
    }
  }
  if (captureMoves.length > 0) return captureMoves;

  const simpleMoves = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const piece = board[row][col];
      if (!piece || piece.color !== color) continue;
      if (piece.king) {
        for (const [dr, dc] of DIAG_DIRS) {
          let step = 1;
          while (true) {
            const toR = row + dr * step;
            const toC = col + dc * step;
            if (!inBounds(toR, toC) || board[toR][toC]) break;
            simpleMoves.push({ fromR: row, fromC: col, toR, toC, isCapture: false });
            step++;
          }
        }
      } else {
        const forward = piece.color === "w" ? -1 : 1; // белые идут к 8-й горизонтали (row 0), чёрные — к 1-й (row 7)
        for (const dc of [-1, 1]) {
          const toR = row + forward;
          const toC = col + dc;
          if (inBounds(toR, toC) && !board[toR][toC]) {
            simpleMoves.push({ fromR: row, fromC: col, toR, toC, isCapture: false });
          }
        }
      }
    }
  }
  return simpleMoves;
}

function applyCheckersMove(board, move) {
  const newBoard = cloneCheckersBoard(board);
  const piece = newBoard[move.fromR][move.fromC];
  newBoard[move.fromR][move.fromC] = null;

  let curR = move.toR;
  let curC = move.toC;
  if (move.isCapture) {
    for (const jump of move.jumps) {
      newBoard[jump.capR][jump.capC] = null;
      curR = jump.toR;
      curC = jump.toC;
    }
  }

  if (!piece.king && ((piece.color === "w" && curR === 0) || (piece.color === "b" && curR === 7))) {
    piece.king = true;
  }
  newBoard[curR][curC] = piece;
  return newBoard;
}

function checkersHasAnyPiece(board, color) {
  return board.some((row) => row.some((cell) => cell && cell.color === color));
}

// null, если игра продолжается; иначе "w" или "b" — кто выиграл (у кого
// сейчас ход — colorToMove — тот проиграл, если у него нет ни фигур, ни
// ходов).
function checkCheckersWinner(board, colorToMove) {
  const other = colorToMove === "w" ? "b" : "w";
  if (!checkersHasAnyPiece(board, colorToMove)) return other;
  if (generateCheckersMoves(board, colorToMove).length === 0) return other;
  return null;
}

// ==== Простой движок для хода бота в шашках (материал + продвижение) ====
const CHECKERS_MAN_VALUE = 100;
const CHECKERS_KING_VALUE = 350;
const CHECKERS_MATE_SCORE = 100000;

function evaluateCheckersBoard(board) {
  let score = 0;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const cell = board[row][col];
      if (!cell) continue;
      const sign = cell.color === "w" ? 1 : -1;
      if (cell.king) {
        score += sign * CHECKERS_KING_VALUE;
        continue;
      }
      // Бонус за продвижение к дамке — чем ближе к последней горизонтали,
      // тем ценнее простая шашка (у белых цель row 0, у чёрных row 7).
      const advancement = cell.color === "w" ? 7 - row : row;
      score += sign * (CHECKERS_MAN_VALUE + advancement * 6);
      // Небольшой бонус за центральные вертикали — меньше шансов попасть
      // под размен с края доски.
      const centerBonus = 4 - Math.abs(col - 3.5);
      score += sign * centerBonus;
    }
  }
  return score;
}

function minimaxCheckers(board, color, depth, alpha, beta) {
  const moves = generateCheckersMoves(board, color);
  if (moves.length === 0) {
    // Стороне color нечем/некуда ходить — она проиграла.
    return color === "w" ? -CHECKERS_MATE_SCORE - depth : CHECKERS_MATE_SCORE + depth;
  }
  if (depth === 0) return evaluateCheckersBoard(board);

  const maximizing = color === "w";
  let best = maximizing ? -Infinity : Infinity;
  const nextColor = color === "w" ? "b" : "w";
  for (const move of moves) {
    const nextBoard = applyCheckersMove(board, move);
    const score = minimaxCheckers(nextBoard, nextColor, depth - 1, alpha, beta);
    if (maximizing) {
      best = Math.max(best, score);
      alpha = Math.max(alpha, best);
    } else {
      best = Math.min(best, score);
      beta = Math.min(beta, best);
    }
    if (beta <= alpha) break;
  }
  return best;
}

function findBestCheckersMove(board, color) {
  const moves = generateCheckersMoves(board, color);
  if (moves.length === 0) return null;
  // Взятия длиннее двигаем в приоритете при равенстве оценки — эстетика,
  // не влияет на легальность (бить и так обязательно, если есть чем).
  moves.sort((a, b) => (b.jumps?.length || 0) - (a.jumps?.length || 0));

  let bestMove = moves[0];
  let bestScore = color === "w" ? -Infinity : Infinity;
  const nextColor = color === "w" ? "b" : "w";
  for (const move of moves) {
    const nextBoard = applyCheckersMove(board, move);
    const score = minimaxCheckers(nextBoard, nextColor, CHECKERS_SEARCH_DEPTH - 1, -Infinity, Infinity);
    if (color === "w" ? score > bestScore : score < bestScore) {
      bestScore = score;
      bestMove = move;
    }
  }
  return bestMove;
}

function startCheckersGame(chatId, userId, userColor, view, playerName) {
  const key = checkersMapKey(chatId, userId);
  const resolvedView = view || checkersGames.get(key)?.view || "ascii";
  // captured — как и в шахматах: captured.w — сколько/какие белые шашки
  // съедены (их съели чёрные), captured.b — наоборот. Элемент списка —
  // "man" (простая) или "king" (дамка).
  const state = {
    board: createInitialCheckersBoard(),
    turn: "w",
    userColor,
    view: resolvedView,
    playerName,
    captured: { w: [], b: [] },
  };
  checkersGames.set(key, state);
  saveCheckersGame(chatId, userId);
  return state;
}

// Из хода-взятия (move.jumps, см. generateCheckersMoves) достаёт, какие
// именно фигуры были съедены — смотрим на board ДО применения хода
// (applyCheckersMove уже убирает их с доски). Возвращает массив
// { color, king } — пусто, если ход не был взятием.
function collectCheckersCaptures(board, move) {
  if (!move.jumps) return [];
  return move.jumps.map((j) => {
    const cell = board[j.capR][j.capC];
    return { color: cell.color, king: cell.king };
  });
}

// Символы вида "картинками": простые — белый/чёрный кружок, дамки —
// латинские буквы в кружке. Геометрические фигуры и Enclosed Alphanumerics
// рендерятся как обычный узкий текст почти везде, но VS15 добавлен и сюда
// на всякий случай (см. подробный комментарий у UNICODE_WHITE в шахматах).
const CHECKERS_UNICODE = {
  wMan: withVS("○"),
  bMan: withVS("●"),
  wKing: withVS("Ⓦ"),
  bKing: withVS("Ⓑ"),
};

function checkersCellGlyph(cell, row, col, view) {
  if (!cell) return isDarkSquare(row, col) ? "." : " ";
  if (view === "unicode") {
    if (cell.king) return cell.color === "w" ? CHECKERS_UNICODE.wKing : CHECKERS_UNICODE.bKing;
    return cell.color === "w" ? CHECKERS_UNICODE.wMan : CHECKERS_UNICODE.bMan;
  }
  const letter = cell.color === "w" ? "w" : "b";
  return cell.king ? letter.toUpperCase() : letter;
}

// Строка съеденных шашек одного цвета в нужном виде — дамки вперёд, эстетика.
function checkersCapturedGlyphs(list, color, view) {
  if (list.length === 0) return "—";
  const sorted = [...list].sort((a, b) => (b === "king") - (a === "king"));
  if (view === "unicode") {
    const man = color === "w" ? CHECKERS_UNICODE.wMan : CHECKERS_UNICODE.bMan;
    const king = color === "w" ? CHECKERS_UNICODE.wKing : CHECKERS_UNICODE.bKing;
    return sorted.map((t) => (t === "king" ? king : man)).join("");
  }
  const letter = color === "w" ? "w" : "b";
  return sorted.map((t) => (t === "king" ? letter.toUpperCase() : letter)).join("");
}

// Строка счёта под доской, тот же принцип, что и у formatCapturedLine в шахматах.
function formatCheckersCapturedLine(captured, userColor, view) {
  if (!captured) return null;
  const oppColor = userColor === "w" ? "b" : "w";
  const yourLost = captured[userColor] || [];
  const myLost = captured[oppColor] || [];
  if (yourLost.length === 0 && myLost.length === 0) return null;
  const yourGlyphs = checkersCapturedGlyphs(yourLost, userColor, view);
  const myGlyphs = checkersCapturedGlyphs(myLost, oppColor, view);
  return `Съедено у тебя: ${yourGlyphs} (${yourLost.length}) | у меня: ${myGlyphs} (${myLost.length})`;
}

function formatCheckersBoard(board, userColor, view, playerName, captured) {
  const lines = ["  +------------------------+"];
  for (let row = 0; row < 8; row++) {
    const rank = 8 - row;
    const cells = board[row].map((cell, col) => checkersCellGlyph(cell, row, col, view));
    lines.push(`${rank} | ${cells.join("  ")} |`);
  }
  lines.push("  +------------------------+");
  lines.push("    a  b  c  d  e  f  g  h");
  const board_ = lines.join("\n");

  let caption;
  if (view === "unicode") {
    const you = userColor === "w" ? CHECKERS_UNICODE.wMan + CHECKERS_UNICODE.wKing : CHECKERS_UNICODE.bMan + CHECKERS_UNICODE.bKing;
    const me = userColor === "w" ? CHECKERS_UNICODE.bMan + CHECKERS_UNICODE.bKing : CHECKERS_UNICODE.wMan + CHECKERS_UNICODE.wKing;
    caption = `(${you} — твои, ${me} — мои; заглавная в кружке — дамка)`;
  } else {
    caption =
      userColor === "w"
        ? "(w/W — твои белые, b/B — мои чёрные; заглавная — дамка)"
        : "(b/B — твои чёрные, w/W — мои белые; заглавная — дамка)";
  }

  const capturedLine = formatCheckersCapturedLine(captured, userColor, view);
  const captionBlock = capturedLine ? `${caption}\n${capturedLine}` : caption;

  const header = playerName ? `Партия в шашки с ${playerName}:\n` : "";
  return header + "```\n" + board_ + "\n" + captionBlock + "\n```";
}

// Разбирает попытку хода вида "b6-c5" (тихий ход) или "b6:d4" /
// "b6xd4" / многоходовая цепочка взятий "b6:d4:f2". Ищет среди легальных
// ходов текущей стороны такой, что совпадают стартовая и финальная
// клетки (а если промежуточные клетки в тексте указаны — ещё и путь).
// Возвращает найденный ход (в исходном формате из generateCheckersMoves)
// либо null.
function tryApplyCheckersMove(board, color, rawText) {
  const text = normalizeMoveText(rawText);
  const tokens = text.split(/[\s,;]+/).filter(Boolean);
  const legalMoves = generateCheckersMoves(board, color);

  for (const token of tokens) {
    if (!CHECKERS_MOVE_REGEX.test(token)) continue;
    const squares = token.match(/[a-h][1-8]/gi);
    if (!squares || squares.length < 2) continue;

    const from = squareToRC(squares[0]);
    const to = squareToRC(squares[squares.length - 1]);
    const candidates = legalMoves.filter((m) => m.fromR === from.row && m.fromC === from.col && m.toR === to.row && m.toC === to.col);
    if (candidates.length === 0) continue;
    if (candidates.length === 1 || squares.length === 2) return candidates[0];

    // Несколько ходов дают ту же стартовую/финальную клетку (разные пути
    // взятия к одной и той же финальной клетке) — уточняем по указанным
    // в тексте промежуточным клеткам.
    const wanted = squares.slice(1, -1).map((sq) => squareToRC(sq));
    const exact = candidates.find((m) => {
      if (!m.jumps || m.jumps.length - 1 !== wanted.length) return false;
      return wanted.every((sq, i) => m.jumps[i].toR === sq.row && m.jumps[i].toC === sq.col);
    });
    if (exact) return exact;
    return candidates[0];
  }
  return null;
}

const CHECKERS_MOVE_SHAPE = /^[a-h][1-8][-:x][a-h][1-8]([-:x][a-h][1-8])*$/i;

function looksLikeCheckersMoveAttempt(rawText) {
  const tokens = normalizeMoveText(rawText).split(/[\s,;]+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 3) return false;
  return tokens.every((t) => CHECKERS_MOVE_SHAPE.test(t));
}

const CHECKERS_START_PHRASES_WHITE = [
  "го, сыграем в шашки. Ты за белых, ходи первым — формат b6-c5, взятие b6:d4.",
  "давай в шашки. Бери белых, начинай: тихий ход через тире (b6-c5), взятие через двоеточие (b6:d4).",
];
const CHECKERS_START_PHRASES_BLACK = [
  "го, сыграем в шашки. Ты за чёрных, значит я белыми и хожу первым.",
  "давай в шашки. Бери чёрных — я тогда белыми, начинаю.",
];
const CHECKERS_WIN_PHRASES = ["всё, тебе больше нечем ходить — я выиграл", "готово, обыграл. Реванш будешь брать?"];
const CHECKERS_LOSE_PHRASES = ["хм, мне ходить нечем — забирай победу", "сдаюсь по правилам, ты выиграл эту партию"];
const CHECKERS_RESIGN_PHRASES = ["принято, партия в шашки окончена", "ладно, сдался — так сдался"];

// ==== Крокодил (объясни слово жестами/словами, чат угадывает) ====
// Состояние — на весь ЧАТ (не на пару с юзером, как шахматы/шашки): один
// раунд одновременно, ведущего видит только сам ведущий (слово шлётся
// через answerCallbackQuery({show_alert:true}) — Telegram показывает такой
// алерт ТОЛЬКО тому, кто нажал кнопку, даже в группе, независимо от того,
// что происходит в самом чате). Раунд стартует, когда кто-то жмёт кнопку
// "хочу быть ведущим"; после неё выбирает сложность слова, дальше уже сам
// придумывает, как объяснять — бот в объяснение не вмешивается, только
// сверяет обычные текстовые сообщения остальных со словом.
const KROKODIL_INTENT_REGEX = /крокодил/i;

// Словарь слов НЕ захардкожен в коде — при старте бот качает два открытых
// набора данных и сам строит из них список слов с уровнями сложности:
//   1) hermitdave/FrequencyWords (MIT) — 50 тыс. русских слов, отсортированных
//      по частоте встречаемости (корпус субтитров);
//   2) LussRus/Rus_words (существительные) — большой список форм русских
//      существительных, используем как фильтр "это вообще существительное",
//      чтобы не выхватывать из частотного списка глаголы/местоимения/наречия
//      (без него в топе частот сплошные "просто"/"знаю"/"почему" и т.п.).
// Пересечение двух списков даёт частотно-ранжированные существительные:
// чем чаще слово встречается в живой речи — тем оно "легче" для угадывания.
// Результат — тысячи слов вместо небольшого статичного списка, слова не
// повторяются, пока не пройден весь пул нужной сложности (см. pickKrokodilWord).
const KROKODIL_FREQ_URL =
  "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/ru/ru_50k.txt";
const KROKODIL_NOUNS_URL =
  "https://raw.githubusercontent.com/LussRus/Rus_words/master/UTF8/json/nouns/summary.json";
const KROKODIL_DICT_TIMEOUT_MS = 20000;

// Служебные/местоименные/междометные слова — в частотном списке субтитров
// их и так почти не остаётся после фильтра по существительным (см. выше),
// но некоторые "существительные"-омонимы всё же проскакивают (например
// "врач" — существительное, а "просто"/"ладно" по ошибке попадают в базу
// существительных как отдельные словоформы) — отсекаем явно.
const KROKODIL_STOPWORDS = new Set(
  `я не что в и ты это на с он мы как вы да мне у нет меня так но
   все она же его к бы по только ее было вот от еще о из ему теперь
   когда даже ну вдруг ли если уже или ни быть был него до вас
   нибудь опять уж вам ведь там потом себя ничего ей может они тут
   где есть надо ней для тебя их чем была сам чтоб без будто чего
   раз тоже себе под будет тогда кто этот того потому этого какой
   совсем ним здесь этом один почти мой тем чтобы нее сейчас были
   куда зачем всех никогда можно при наконец два об другой хоть
   после над больше тот через эти нас про всего них какая много
   разве три эту моя впрочем хорошо свою этой перед иногда лучше
   чуть том нельзя такой им более всегда конечно всю между
   сэр мистер боже ладно тебе просто знаю всё почему очень могу
   спасибо нам нужно хочу знаешь думаю время должна должен нужна
   нужен пожалуйста хочешь сделать увидимся такое немного слишком
   возможно должны точно наверное правда хотя вообще именно
   короче блин типа сюда туда отсюда оттуда ага угу эй ого
   ой ах эх ух фу ба тсс алло привет пока пожалуй якобы вроде
   кажется значит итак словом однако причем притом также затем
   поэтому оттого отчего почём кой сколь коли ежели абы
   дабы либо иль аж авось буде вон вот те эва эвон энто`
    .trim()
    .split(/\s+/)
);

// Крошечный запасной словарь — только на случай, если при старте бота
// GitHub недоступен (сеть легла и т.п.) и скачать основной словарь не
// вышло. В обычной работе не используется — см. loadKrokodilDictionary.
const KROKODIL_FALLBACK_WORDS = {
  easy: ["кот", "стол", "окно", "мяч", "книга", "чашка", "машина", "дом", "часы", "телефон", "яблоко", "рыба", "птица", "ключ", "снег"],
  medium: ["врач", "светофор", "холодильник", "вулкан", "аквариум", "парашют", "компас", "глобус", "будильник", "барабан", "скрипка", "антенна", "лабиринт", "гейзер", "карнавал"],
  hard: ["ностальгия", "справедливость", "парадокс", "интуиция", "ирония", "гравитация", "метафора", "харизма", "эмпатия", "меланхолия", "феномен", "инерция", "суверенитет", "аномалия", "иерархия"],
};

// Текущий словарь — на старте это KROKODIL_FALLBACK_WORDS, после успешной
// загрузки (см. loadKrokodilDictionary, вызывается в startBot) заменяется
// на полноценный, скачанный из сети.
let krokodilDictionary = KROKODIL_FALLBACK_WORDS;

async function fetchTextWithTimeout(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), KROKODIL_DICT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

// Качает оба источника, пересекает их и раскладывает по трём уровням
// сложности по позиции в частотном списке (чем ближе к началу — тем
// более обиходное слово). Вызывается один раз при старте бота; если
// что-то пошло не так — тихо остаётся на KROKODIL_FALLBACK_WORDS.
async function loadKrokodilDictionary() {
  try {
    const [freqText, nounsText] = await Promise.all([
      fetchTextWithTimeout(KROKODIL_FREQ_URL),
      fetchTextWithTimeout(KROKODIL_NOUNS_URL),
    ]);

    const nounsRaw = JSON.parse(nounsText);
    const nounSet = new Set();
    for (const w of nounsRaw) {
      // Только строчные — так отсеиваются имена собственные (Аббасиды и т.п.)
      if (typeof w === "string" && /^[а-яё]+$/.test(w)) nounSet.add(w);
    }

    const seen = new Set();
    const filtered = [];
    for (const line of freqText.split("\n")) {
      const word = line.trim().split(/\s+/)[0];
      if (!word) continue;
      if (!/^[а-яё]+$/.test(word)) continue;
      if (word.length < 4 || word.length > 15) continue;
      if (KROKODIL_STOPWORDS.has(word)) continue;
      if (!nounSet.has(word)) continue;
      if (/(.)\1{3,}/.test(word)) continue; // явные опечатки типа "ааааа"
      if (seen.has(word)) continue;
      seen.add(word);
      filtered.push(word);
    }

    if (filtered.length < 500) {
      throw new Error(`подозрительно мало слов после фильтрации: ${filtered.length}`);
    }

    krokodilDictionary = {
      easy: filtered.slice(0, 500),
      medium: filtered.slice(500, 2500),
      hard: filtered.slice(2500),
    };

    console.log(
      `Крокодил: словарь загружен — лёгких ${krokodilDictionary.easy.length}, ` +
        `средних ${krokodilDictionary.medium.length}, сложных ${krokodilDictionary.hard.length}`
    );
  } catch (err) {
    console.error("Крокодил: не удалось загрузить словарь из сети, остаюсь на встроенном запасном:", err.message);
  }
}

const KROKODIL_DIFFICULTY_LABEL = { easy: "лёгкие", medium: "средние", hard: "сложные" };

// chatId -> состояние раунда. status: "idle" (никто не ведёт) |
// "choosing" (кто-то нажал "хочу быть ведущим", выбирает сложность) |
// "active" (слово загадано, идёт раунд).
const krokodilGames = new Map();
// chatId -> Map<userId, {name, score}> — счёт копится между раундами и не
// сбрасывается при завершении конкретного раунда/игры.
const krokodilScores = new Map();

// Раунд считается "зависшим", если статус не idle (т.е. кто-то либо
// выбирает сложность, либо уже ведёт раунд), а с момента последнего
// перехода в этот статус (см. startedAt, выставляется в bot.on("callback_
// query:data") при "host"/"diff:") прошло больше этого времени — типичный
// случай: ведущий взял слово и вышел из чата/заблокировал бота. Проверяется
// централизованно в getKrokodilGame ниже, так что чинить нужно в одном
// месте: любое обращение к раунду (команда /krokodil, кнопки, проверка
// отгадки, естественный триггер "крокодил") сначала само его расчищает,
// если он завис — раунд просто тихо возвращается в "idle", а следующий
// желающий видит обычное приглашение "жми кнопку, чтобы стать ведущим".
// Для ручного сброса раньше таймаута — см. bot.command("krokodil_reset").
const KROKODIL_TIMEOUT_MS = 10 * 60 * 1000; // 10 минут без действий

function getKrokodilGame(chatId) {
  const game = krokodilGames.get(chatId) || null;
  if (game && game.status !== "idle" && game.startedAt && Date.now() - game.startedAt > KROKODIL_TIMEOUT_MS) {
    krokodilGames.set(chatId, { status: "idle", usedWords: game.usedWords || [] });
    saveKrokodilGame(chatId);
    return krokodilGames.get(chatId);
  }
  return game;
}

function getKrokodilScoreMap(chatId) {
  if (!krokodilScores.has(chatId)) krokodilScores.set(chatId, new Map());
  return krokodilScores.get(chatId);
}

async function saveKrokodilGame(chatId) {
  if (!redis) return;
  try {
    const game = krokodilGames.get(chatId);
    if (game) await redis.set(`krokodil:${chatId}`, game);
    else await redis.del(`krokodil:${chatId}`);
  } catch (err) {
    console.error(`Redis: не удалось сохранить раунд крокодила ${chatId}:`, err);
  }
}

async function saveKrokodilScores(chatId) {
  if (!redis) return;
  try {
    await redis.set(`krokodil_scores:${chatId}`, Object.fromEntries(getKrokodilScoreMap(chatId)));
  } catch (err) {
    console.error(`Redis: не удалось сохранить счёт крокодила ${chatId}:`, err);
  }
}

// Нормализация слова/токена для сравнения: нижний регистр, ё->е (частая
// вольность написания), без пунктуации. Совпадение — только точное
// (после нормализации): "работа" ≠ "работник" ≠ "робота".
function normalizeKrokodilToken(s) {
  return (s || "").toLowerCase().replace(/ё/g, "е");
}

function krokodilTokenMatches(token, secret) {
  const a = normalizeKrokodilToken(token);
  const b = normalizeKrokodilToken(secret);
  if (!a || !b) return false;
  return a === b;
}

// Выбирает случайное неиспользованное слово нужной сложности для этого
// чата; когда слова кончаются — список "использованных" очищается и
// начинается по новой (слова могут повторяться, но не раньше, чем весь
// список для этой сложности будет пройден).
function pickKrokodilWord(chatId, difficulty) {
  const pool = krokodilDictionary[difficulty] || krokodilDictionary.medium;
  const game = getKrokodilGame(chatId);
  let used = (game && Array.isArray(game.usedWords) ? game.usedWords : []).filter((w) => pool.includes(w));

  let available = pool.filter((w) => !used.includes(w));
  if (available.length === 0) {
    used = [];
    available = pool;
  }

  const word = available[Math.floor(Math.random() * available.length)];
  return { word, usedWords: [...used, word] };
}

function krokodilIdleKeyboard() {
  return new InlineKeyboard().text("🐊 Хочу быть ведущим", "krokodil:host");
}

function krokodilDifficultyKeyboard() {
  return new InlineKeyboard()
    .text("🟢 Легко", "krokodil:diff:easy")
    .text("🟡 Средне", "krokodil:diff:medium")
    .text("🔴 Сложно", "krokodil:diff:hard");
}

function krokodilActiveKeyboard() {
  return new InlineKeyboard()
    .text("🔁 Показать слово", "krokodil:show")
    .text("🔄 Другое слово", "krokodil:reroll")
    .row()
    .text("🏳 Сдаюсь", "krokodil:giveup");
}

function krokodilPlayerLabel(user) {
  return user.username ? `@${user.username}` : user.first_name || "игрок";
}

// Топ игроков чата по очкам — используется и в отдельной команде, и в
// сообщении, которым бот объявляет старт нового ожидания ведущего.
function formatKrokodilLeaderboard(chatId) {
  const map = getKrokodilScoreMap(chatId);
  if (map.size === 0) return "пока никто не отгадал ни одного слова — очков нет";
  const rows = [...map.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((e, i) => `${i + 1}. ${e.name} — ${e.score}`);
  return "🏆 Таблица лидеров крокодила:\n" + rows.join("\n");
}

// ==== Анекдоты (готовая база, а не выдумки модели) ====
// Идея: LLM на просьбу "расскажи анекдот" почти всегда либо выдумывает
// несмешную белиберду, либо пересказывает один и тот же десяток баянов.
// Поэтому анекдот отвечаем НЕ через модель, а из готовой базы — она
// проверяется человеком заранее и у каждого анекдота есть rating
// (субъективная оценка смешности, 1-10 — насколько заходит средней
// аудитории). Берём только достаточно смешные (rating >= JOKE_MIN_RATING)
// и выбираем взвешенно — чем выше рейтинг, тем чаще анекдот попадается,
// но не только самый топовый, чтобы не приедалось.
const JOKES = [
  { text: "Программист прогуливается по зоопарку с ребёнком. Ребёнок:\n— Папа, купи мне это!\nПрограммист смотрит на ценник: null.\n— Не куплю, ты не определён.", rating: 8 },
  { text: "— Дорогой, купи хлеба, и если будут яйца — возьми десяток.\nМуж возвращается с десятью буханками хлеба.\n— Ты зачем столько хлеба купил?!\n— Так яйца же были!", rating: 9 },
  { text: "Штирлиц шёл по коридору. Слева от него шли двое, справа — двое.\n«Наверное, я тучный», — подумал Штирлиц.", rating: 7 },
  { text: "Разговаривают два программиста:\n— У меня сегодня баг три часа искал.\n— Нашёл?\n— Да, это была фича.", rating: 7 },
  { text: "— Вовочка, почему ты опоздал в школу?\n— Мама долго собиралась.\n— А при чём тут твоя мама?\n— Она меня в садик собирала.", rating: 8 },
  { text: "Заходит блондинка в зоомагазин:\n— У вас есть попугаи, которые уже умеют говорить?\n— Да, вот этот, например.\n— Отлично, беру! Заодно возьму того молчаливого — пусть его научит.", rating: 7 },
  { text: "— Официант, а почему в супе муха?\n— Училась плавать, доучится — и в бассейн переведём.", rating: 7 },
  { text: "Жена мужу:\n— Дорогой, признайся, ты меня любишь только за красоту?\n— Что ты, милая, ещё и за то, что готовишь плохо — это тоже характер закаляет.", rating: 6 },
  { text: "Приходит мужик к врачу:\n— Доктор, у меня будто внутри будильник — каждый час звенит.\n— Так это же прекрасно, вы что, жалуетесь?\n— Он звонит в 3 ночи, доктор!", rating: 6 },
  { text: "— Официант, у вас есть блюда для вегетарианцев?\n— Конечно! Салат из капусты и капуста из салата.", rating: 6 },
  { text: "Идёт экзамен по вождению.\n— Что вы будете делать, если увидите на дороге собаку и кошку?\n— Сначала кошку, потом собаку — они по очереди перебегают.", rating: 6 },
  { text: "На собеседовании:\n— Расскажите о своих слабых сторонах.\n— Честность.\n— Не думаю, что это слабая сторона.\n— А мне плевать, что вы думаете.", rating: 8 },
  { text: "Сын спрашивает отца:\n— Пап, а как рождаются дети?\n— Понимаешь, сынок, всё начинается с сервера…\n— Что за сервер?\n— Который постоянно падает, а обвиняют почему-то маму.", rating: 6 },
  { text: "— Что означает надпись на заводе «Не влезай — убьёт»?\n— Это чтобы ты влез, а он потом ещё и убил тебя за наглость.", rating: 5 },
  { text: "Программист приходит домой, а дома темно.\n— Хосе, ты дома?\nТишина.\n— Хосе, ты дома?\nТишина.\n— HOSE, ARE YOU HOME?\n— ДА КАКОЙ ХОСЕ, Я ДИМА, СВЕТ ВЫРУБИЛИ!", rating: 8 },
  { text: "Мужик приходит в аптеку:\n— У вас есть что-нибудь от головы?\n— От головы — гильотина, от боли в голове — вон там, второй ряд.", rating: 6 },
  { text: "— Как дела на работе?\n— Отлично, начальник сказал, что без меня как без рук.\n— Повысили?\n— Нет, руки связал и уволил.", rating: 7 },
  { text: "Мужик заходит в бар с крокодилом.\n— У вас продают алкоголиков?\nБармен, не моргнув глазом:\n— Нет, только напитки.\n— Жаль, а то мой крокодил проголодался.", rating: 6 },
  { text: "— Почему ты назвал собаку «Стек»?\n— Потому что она всё время лает последней командой.", rating: 6 },
  { text: "Разговор с техподдержкой:\n— У меня ничего не работает.\n— Вы пробовали выключить и включить?\n— Да, и жену тоже пробовал, не помогло.", rating: 5 },
  { text: "— Сколько нужно программистов, чтобы вкрутить лампочку?\n— Ни одного, это же аппаратная проблема.", rating: 7 },
  { text: "Заходит в лифт мужик с зеркалом. Лифт:\n— Осторожно, двери закрываются.\nМужик, глядя в зеркало:\n— Ну наконец-то хоть кто-то заметил.", rating: 6 },
  { text: "— Официант, долго мне ещё ждать заказ?\n— Как быстро вы готовы к разочарованию?", rating: 6 },
  { text: "Учитель спрашивает Вовочку:\n— Как называется тот, кто продолжает говорить, даже когда его никто не слушает?\n— Учитель.", rating: 8 },
  { text: "Летит самолёт, тишина в салоне. Пилот в громкую связь:\n— Приносим извинения за задержку, мы немного заблудились.\nПассажир соседу:\n— Хорошо хоть честно.", rating: 6 },
  { text: "— Как вы относитесь к критике?\n— Нормально, если она заканчивается на слове «молодец».", rating: 7 },
  { text: "Заходит таракан в бар и говорит:\n— Дайте мне того же, что и мужику вон в углу.\nБармен:\n— Хочешь, чтобы тебя тапком?", rating: 6 },
  { text: "— У тебя есть план на жизнь?\n— Да, план Б.\n— А план А?\n— Про него я и мечтал в школе.", rating: 6 },
  { text: "Мужик приходит домой поздно, жена спрашивает:\n— Где был?\n— С друзьями, обсуждали, как я тебя люблю.\n— И долго обсуждали?\n— Тема короткая, но повторяли часто.", rating: 6 },
  { text: "На собеседовании спрашивают:\n— Кем вы видите себя через пять лет?\n— На вашем месте.\n— А если серьёзно?\n— На вашем месте, но с вашей зарплатой уже сейчас.", rating: 7 },
];

const JOKE_MIN_RATING = 6; // ниже этого — не показываем, слишком "не заходит"

// Простая антиповторялка: последние выданные анекдоты в каждом чате (по
// индексу в JOKES), чтобы не прилетал один и тот же анекдот два раза
// подряд. Живёт только в памяти (не в Redis) — не критичное состояние,
// после рестарта просто начнёт по новой, это ок.
const recentJokes = new Map(); // chatId -> number[] (индексы недавно показанных)

function pickJoke(chatId) {
  const pool = JOKES.map((j, idx) => ({ ...j, idx })).filter((j) => j.rating >= JOKE_MIN_RATING);
  const recent = recentJokes.get(chatId) || [];
  // Не повторяем последние несколько анекдотов, пока есть из чего выбрать
  // помимо них; если пул почти исчерпан — снимаем ограничение.
  let candidates = pool.filter((j) => !recent.includes(j.idx));
  if (candidates.length === 0) candidates = pool;

  // Взвешенный случайный выбор: чем выше рейтинг — тем больше "веса" у
  // анекдота в розыгрыше (rating^2, чтобы разница ощущалась заметнее, но
  // без полного отсечения менее залайканных).
  const weights = candidates.map((j) => j.rating * j.rating);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * totalWeight;
  let chosen = candidates[candidates.length - 1];
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r <= 0) {
      chosen = candidates[i];
      break;
    }
  }

  const updatedRecent = [chosen.idx, ...recent].slice(0, 5);
  recentJokes.set(chatId, updatedRecent);
  return chosen.text;
}

// Распознаёт просьбу рассказать анекдот. В группах это работает уже
// ПОСЛЕ обращения по имени (см. вызов ниже — на stripNameTrigger(rawText)),
// так что просто наличия слова "анекдот" достаточно: "Женя, анекдот" уже
// содержит явное обращение к боту, отдельный глагол-триггер не нужен.
function isJokeRequest(text) {
  return /анекдот/i.test(text);
}

// Живой источник анекдотов — rzhunemogu.ru отдаёт случайный анекдот без
// ключа и регистрации, но БЕЗ рейтинга смешности и без модерации (это
// сырой пользовательский контент — иногда несмешно, иногда грубовато).
// Поэтому используем его как "освежитель" поверх курируемой базы (JOKES
// выше), а не вместо неё: если сайт недоступен, ответил пусто/не тем
// форматом, или просто долго думает — тихо уходим на pickJoke() ниже,
// пользователь в любом случае получит анекдот, просто не "свежий".
const JOKE_API_URL = "http://rzhunemogu.ru/RandJSON.aspx?CType=1";
const JOKE_API_TIMEOUT_MS = 4000;

async function fetchLiveJoke() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), JOKE_API_TIMEOUT_MS);
  try {
    const res = await fetch(JOKE_API_URL, { signal: controller.signal });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    // Сайт отдаёт текст в кодировке CP1251, а не UTF-8.
    let text;
    try {
      text = new TextDecoder("windows-1251").decode(buf);
    } catch {
      text = Buffer.from(buf).toString("utf8"); // на случай, если движок не знает windows-1251
    }

    // Ответ сайта — технически не всегда валидный JSON (бывают
    // неэкранированные переносы строк внутри значения content), поэтому
    // сначала пробуем честный JSON.parse, а если он упал — вытаскиваем
    // content вручную по границам кавычек.
    let content = null;
    try {
      content = JSON.parse(text)?.content ?? null;
    } catch {
      const m = text.match(/"content"\s*:\s*"([\s\S]*)"\s*}\s*$/);
      if (m) content = m[1];
    }
    if (!content) return null;

    content = content.replace(/\\r\\n|\\n|\\r/g, "\n").trim();
    // Совсем короткий/пустой ответ — не похоже на нормальный анекдот,
    // лучше фолбэкнуться на курируемую базу, чем прислать мусор.
    if (content.length < 10) return null;
    return content;
  } catch (err) {
    console.error("rzhunemogu: не удалось получить анекдот:", err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Единая точка получения анекдота для ответа пользователю: сначала пробуем
// живой источник, при любой неудаче — гарантированный фолбэк на
// курируемую базу (см. pickJoke). Пользователь никогда не остаётся без
// ответа из-за упавшего внешнего сайта.
async function getJoke(chatId) {
  const live = await fetchLiveJoke();
  return live || pickJoke(chatId);
}

// ==== Фолбэк между провайдерами/моделями ====
// Индекс цели (провайдер+модель), на которой бот последний раз успешно
// ответил — начинаем с неё же, чтобы не долбить мёртвую цель на каждый запрос.
let activeTargetIndex = 0;

async function saveActiveTargetIndex() {
  if (!redis) return;
  try {
    await redis.set("activeTargetIndex", activeTargetIndex);
  } catch (err) {
    console.error("Redis: не удалось сохранить activeTargetIndex:", err);
  }
}

// pinnedTargetIndex — модель, вручную закреплённая владельцем через кнопки
// в /model (см. bot.command("model") и callback_query ниже). Если задана —
// askLLM пробует её первой (при условии что она не в cooldown), иначе
// ведёт себя как раньше (обычный фолбэк). null — авто-режим.
let pinnedTargetIndex = null;

async function savePinnedTargetIndex() {
  if (!redis) return;
  try {
    // Upstash не любит хранить null как значение — используем -1 как "нет".
    await redis.set("pinnedTargetIndex", pinnedTargetIndex === null ? -1 : pinnedTargetIndex);
  } catch (err) {
    console.error("Redis: не удалось сохранить pinnedTargetIndex:", err);
  }
}

// Ошибки, при которых имеет смысл пробовать следующую цель:
// модель/провайдер недоступны, лимиты исчерпаны и т.п.
function isFallbackWorthy(status) {
  return [400, 401, 403, 404, 422, 429, 500, 502, 503, 504].includes(status);
}

// Страховка от бага некоторых reasoning-моделей (замечено у gpt-oss на Groq):
// вместо одного финального ответа модель иногда присылает черновик вида
// `"Привет!" or "Привет, чё как?"` — несколько вариантов реплики в кавычках
// через "or"/"или". Промпт это запрещает, но на случай если модель всё же
// так ответит — распознаём паттерн и берём только первый вариант.
function stripDraftVariants(text) {
  const parts = text.split(/\s+(?:or|или)\s+/i);
  if (parts.length < 2) return text;

  // Срабатываем только если КАЖДАЯ часть выглядит как реплика в кавычках —
  // иначе можно случайно обрезать обычную фразу со словом "или".
  const looksQuoted = (p) => /^["'«][\s\S]*["'»][.,!?)]*$/.test(p.trim());
  if (!parts.every(looksQuoted)) return text;

  const first = parts[0]
    .trim()
    .replace(/^["'«]+/, "")
    .replace(/["'»]+[.,!?)]*$/, "")
    .trim();

  return first || text;
}

// Страховка от утечки рассуждений: иногда вместо ответа модель (замечено
// у Gemini) присылает что-то вроде самопроверки по инструкциям —
// "только на русском (Yes) * без markdown (Yes)" — вместо реального текста.
// Если увидели характерный паттерн "(Yes)"/"(No)"/"(да)"/"(нет)" несколько
// раз подряд — считаем ответ невалидным, чтобы дальше в askLLM сработал
// фолбэк на следующую модель, а не улетело это в чат.
function looksLikeReasoningLeak(text) {
  const yesNoCount = (text.match(/\((?:yes|no|да|нет)\)/gi) || []).length;
  return yesNoCount >= 2;
}

async function callTarget(target, messages) {
  const body = {
    model: target.model,
    messages,
    temperature: 0.9,
    // gemini-2.5-flash (единственная линейка, где Google даёт thinking_budget=0
    // по-настоящему) снята с доступа — остался gemini-flash-latest/3.5-flash,
    // а там размышления нельзя выключить до нуля вообще никакими флагами.
    // Единственный рычаг, который реально работает — щедрый общий бюджет,
    // чтобы после того, что модель потратит на размышления, оставалось
    // достаточно на сам видимый ответ.
    max_tokens: 3000,
  };

  // Groq поддерживает это поле для reasoning-моделей (qwen3, gpt-oss).
  if (target.provider === "groq") {
    body.reasoning_format = "hidden";

    // У gpt-oss на Groq reasoning_effort реально снижает объём размышлений
    // (в отличие от Gemini 3, где это не гарантировано) — оставляем как
    // основной способ сэкономить бюджет для этого провайдера.
    if (target.model.includes("gpt-oss")) {
      body.reasoning_effort = "low";
    } else if (target.model.includes("qwen")) {
      body.reasoning_effort = "none";
    }
  }

  // Для Gemini reasoning_effort — единственное задокументированное и реально
  // принимаемое API поле для управления размышлениями (проверено curl-примером
  // Google). Поле "google.thinking_config" через голый JSON API не принимает
  // (упало с 400 Unknown name "google") — убрано. Полагаемся на max_tokens.
  if (target.provider === "gemini") {
    body.reasoning_effort = "low";
  }

  // Таймаут на сам запрос: если провайдер завис и не отвечает вообще
  // (не дал ни 200, ни ошибку) — раньше это вешало ответ пользователю
  // на минуты вперёд. Теперь через REQUEST_TIMEOUT_MS обрываем запрос и
  // уходим на фолбэк, как при обычной ошибке.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(target.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${target.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      const timeoutErr = new Error(
        `${target.provider}/${target.model} не ответил за ${REQUEST_TIMEOUT_MS}мс — таймаут`
      );
      timeoutErr.status = 504;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`${target.provider} API вернул ${res.status}`);
    err.status = res.status;
    err.body = errText;
    throw err;
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  let reply = choice?.message?.content?.trim();
  if (!reply) throw new Error(`Пустой ответ от ${target.provider}`);

  // data.model — это то, что РЕАЛЬНО ответило (важно для роутеров вроде
  // HF/OpenRouter, которые под капотом динамически выбирают бэкенд —
  // может отличаться от target.model, который мы запросили).
  // system_fingerprint иногда содержит доп. инфо о бэкенде/версии.
  const actualModel = data.model || null;
  const systemFingerprint = data.system_fingerprint || null;

  // Если ответ обрезан по лимиту токенов — не отдаём пользователю огрызок
  // фразы, а считаем это ошибкой цели: сработает фолбэк на следующую
  // модель в TARGETS (см. askLLM). Само событие видно в логах Render.
  if (choice?.finish_reason === "length") {
    console.warn(
      `[callTarget] ${target.provider}/${target.model}: ответ обрезан по finish_reason=length, ухожу на фолбэк ("${reply}")`
    );
    const err = new Error(`${target.provider} обрезал ответ по длине`);
    err.status = 500; // считается фолбэк-достойной (см. isFallbackWorthy)
    throw err;
  }

  // Страховка: если какая-то модель всё же прислала рассуждения внутри
  // <think>...</think> (были баги с этим у reasoning-моделей), — вырезаем,
  // чтобы в чат не улетал внутренний монолог модели.
  reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (!reply) throw new Error(`Пустой ответ от ${target.provider} после очистки <think>`);

  reply = stripDraftVariants(reply);
  if (!reply) throw new Error(`Пустой ответ от ${target.provider} после очистки вариантов`);

  if (looksLikeReasoningLeak(reply)) {
    console.warn(`[callTarget] ${target.provider}/${target.model}: похоже на утечку рассуждений вместо ответа: "${reply}"`);
    throw new Error(`${target.provider} прислал утечку рассуждений вместо ответа`);
  }

  return { reply, actualModel, systemFingerprint };
}

// ==== Запрос к LLM с фолбэком по провайдерам и моделям ====
async function askLLM(chatId, userText) {
  const history = getHistory(chatId);

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: userText },
  ];

  let lastErr;

  // Порядок попыток на этот запрос: сначала цели НЕ в cooldown (в исходном
  // порядке TARGETS — т.е. первой пробуется основной провайдер, напр.
  // gemini), затем те, что ещё "остывают" после недавней ошибки — их
  // пробуем последними, но не выкидываем совсем, чтобы бот всё равно
  // ответил, если вдруг остыть успели вообще все.
  // Благодаря этому бот не "залипает" на фолбэк-модели навсегда: как
  // только у основной цели истёк cooldown, следующий же запрос снова
  // начнёт с неё — переключение туда-обратно происходит само.
  const now = Date.now();
  let order = [...TARGETS.keys()].sort((a, b) => {
    const aCold = cooldownUntil[a] > now ? 1 : 0;
    const bCold = cooldownUntil[b] > now ? 1 : 0;
    return aCold - bCold || a - b;
  });

  // Если владелец вручную закрепил модель кнопкой в /model — пробуем её
  // первой (но только если она не остывает; если в cooldown, откатываемся
  // к обычному порядку, чтобы не блокировать ответ бота на всём чате).
  if (pinnedTargetIndex !== null && cooldownUntil[pinnedTargetIndex] <= now) {
    order = [pinnedTargetIndex, ...order.filter((idx) => idx !== pinnedTargetIndex)];
  }

  for (const idx of order) {
    const target = TARGETS[idx];

    try {
      const { reply: rawReply, actualModel, systemFingerprint } = await callTarget(target, messages);
      // ВРЕМЕННЫЙ DEBUG-ЛОГ — убрать после проверки тегов [sticker: ...].
      // Показывает сырой ответ модели ДО вырезания тега, чтобы понять,
      // ставит ли модель тег вообще, и если ставит — с правильным ли ключом.
      // actualModel/systemFingerprint — то, что реально ответило по данным
      // самого API (важно для роутеров HF/OpenRouter: реальный бэкенд может
      // отличаться от target.model, который мы запросили).
      console.log(
        `[DEBUG rawReply от ${target.provider}/${target.model}` +
          (actualModel && actualModel !== target.model ? ` → фактически ответил: ${actualModel}` : "") +
          (systemFingerprint ? ` | fingerprint: ${systemFingerprint}` : "") +
          `]:`,
        JSON.stringify(rawReply)
      );

      const { text: reply, stickerKey } = extractSticker(rawReply);

      cooldownUntil[idx] = 0; // на успехе снимаем cooldown, если он был
      if (idx !== activeTargetIndex) {
        console.warn(`Переключился на "${target.provider}/${target.model}" (индекс ${idx})`);
        activeTargetIndex = idx;
        saveActiveTargetIndex();
      }

      // В историю кладём чистый текст без тега — модели не нужно видеть
      // свой же служебный тег в контексте будущих сообщений.
      pushHistory(chatId, "user", userText);
      pushHistory(chatId, "assistant", reply);

      return { text: reply, stickerKey };
    } catch (err) {
      lastErr = err;
      console.error(
        `Ошибка [${target.provider}/${target.model}]:`,
        err.status ?? "-",
        err.body ?? err.message
      );

      // Без статуса — сетевая ошибка/таймаут (см. AbortError в callTarget,
      // тому уже проставлен status=504, так что сюда попадают только совсем
      // неожиданные исключения) — тоже считаем фолбэк-достойной.
      if (err.status && !isFallbackWorthy(err.status)) break;

      cooldownUntil[idx] = Date.now() + MODEL_COOLDOWN_MS;
    }
  }

  throw lastErr ?? new Error("Все провайдеры и модели недоступны");
}

// ==== Имитация "живой" задержки перед ответом ====
function typingDelayMs(replyLength) {
  // примерно 1.5–3.5 сек в зависимости от длины ответа, плюс небольшой рандом
  const base = 1200 + Math.min(replyLength * 15, 2000);
  const jitter = Math.random() * 500;
  return base + jitter;
}

// ==== Восстановление состояния из Redis при старте ====
// Читает всё, что успели сохранить save*-хелперы выше, обратно в
// оперативные Map'ы, чтобы после рестарта бот "помнил" контекст диалогов,
// алиасы, пол и на какой модели остановился в прошлый раз.
async function loadPersistedState() {
  if (!redis) return;

  try {
    const [
      historyKeys,
      chatLogKeys,
      aliasKeys,
      usernameKeys,
      genderKeys,
      chessKeys,
      checkersKeys,
      krokodilKeys,
      krokodilScoreKeys,
      savedIdx,
      savedPinnedIdx,
    ] = await Promise.all([
      redis.keys("history:*"),
      redis.keys("chatlog:*"),
      redis.keys("aliases:*"),
      redis.keys("usernames:*"),
      redis.keys("genders:*"),
      redis.keys("chess:*"),
      redis.keys("checkers:*"),
      redis.keys("krokodil:*"),
      redis.keys("krokodil_scores:*"),
      redis.get("activeTargetIndex"),
      redis.get("pinnedTargetIndex"),
    ]);

    await Promise.all(
      historyKeys.map(async (key) => {
        const chatId = Number(key.slice("history:".length));
        const data = await redis.get(key);
        if (Array.isArray(data)) histories.set(chatId, data);
      })
    );

    await Promise.all(
      chatLogKeys.map(async (key) => {
        const chatId = Number(key.slice("chatlog:".length));
        const data = await redis.get(key);
        if (Array.isArray(data)) chatLogs.set(chatId, data);
      })
    );

    await Promise.all(
      aliasKeys.map(async (key) => {
        const chatId = Number(key.slice("aliases:".length));
        const data = await redis.get(key);
        if (data && typeof data === "object") {
          const map = getAliasMap(chatId);
          for (const [userId, value] of Object.entries(data)) map.set(Number(userId), value);
        }
      })
    );

    await Promise.all(
      usernameKeys.map(async (key) => {
        const chatId = Number(key.slice("usernames:".length));
        const data = await redis.get(key);
        if (data && typeof data === "object") {
          const map = getUsernameIndex(chatId);
          for (const [username, userId] of Object.entries(data)) map.set(username, Number(userId));
        }
      })
    );

    await Promise.all(
      genderKeys.map(async (key) => {
        const chatId = Number(key.slice("genders:".length));
        const data = await redis.get(key);
        if (data && typeof data === "object") {
          const map = getGenderMap(chatId);
          for (const [userId, value] of Object.entries(data)) map.set(Number(userId), value);
        }
      })
    );

    await Promise.all(
      chessKeys.map(async (key) => {
        // Ключ вида chess:{chatId}:{userId} — карту храним под тем же
        // составным ключом, что и chessMapKey() в рантайме.
        const mapKey = key.slice("chess:".length);
        const data = await redis.get(key);
        if (data && typeof data === "object" && typeof data.fen === "string") {
          chessGames.set(mapKey, data);
        }
      })
    );

    await Promise.all(
      checkersKeys.map(async (key) => {
        // Ключ вида checkers:{chatId}:{userId} — под тем же составным
        // ключом, что и checkersMapKey() в рантайме.
        const mapKey = key.slice("checkers:".length);
        const data = await redis.get(key);
        if (data && typeof data === "object" && Array.isArray(data.board)) {
          checkersGames.set(mapKey, data);
        }
      })
    );

    await Promise.all(
      krokodilKeys.map(async (key) => {
        const chatId = Number(key.slice("krokodil:".length));
        const data = await redis.get(key);
        if (data && typeof data === "object" && typeof data.status === "string") {
          krokodilGames.set(chatId, data);
        }
      })
    );

    await Promise.all(
      krokodilScoreKeys.map(async (key) => {
        const chatId = Number(key.slice("krokodil_scores:".length));
        const data = await redis.get(key);
        if (data && typeof data === "object") {
          const map = getKrokodilScoreMap(chatId);
          for (const [userId, value] of Object.entries(data)) map.set(Number(userId), value);
        }
      })
    );

    if (typeof savedIdx === "number" && Number.isInteger(savedIdx) && savedIdx >= 0 && savedIdx < TARGETS.length) {
      activeTargetIndex = savedIdx;
    }

    if (
      typeof savedPinnedIdx === "number" &&
      Number.isInteger(savedPinnedIdx) &&
      savedPinnedIdx >= 0 &&
      savedPinnedIdx < TARGETS.length
    ) {
      pinnedTargetIndex = savedPinnedIdx;
    }

    console.log(
      `Восстановлено из Redis: истории — ${historyKeys.length}, логи чатов — ${chatLogKeys.length}, алиасы — ${aliasKeys.length}, ` +
        `юзернеймы — ${usernameKeys.length}, пол — ${genderKeys.length}, шахматные партии — ${chessKeys.length}, ` +
        `шашечные партии — ${checkersKeys.length}, раунды крокодила — ${krokodilKeys.length}, ` +
        `счёт крокодила — ${krokodilScoreKeys.length} чатов` +
        (typeof savedIdx === "number" ? `, активная модель — индекс ${activeTargetIndex}` : "") +
        (pinnedTargetIndex !== null ? `, закреплена вручную — индекс ${pinnedTargetIndex}` : "")
    );
  } catch (err) {
    console.error("Не удалось восстановить состояние из Redis, стартую с чистой памятью:", err);
  }
}

// ==== Инициализация бота ====
const bot = new Bot(BOT_TOKEN);

// ==== Разрешённые группы ====
// ALLOWED_GROUP_IDS — id групп/супергрупп через запятую, где боту разрешено
// отвечать. Личные чаты этим списком НЕ ограничиваются — там бот всегда
// доступен. Если список пуст — ограничения нет, бот работает в любой группе.
const ALLOWED_GROUP_IDS = (process.env.ALLOWED_GROUP_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

function isAllowedChat(ctx) {
  const isGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
  if (!isGroup) return true;
  if (ALLOWED_GROUP_IDS.length === 0) return true;
  return ALLOWED_GROUP_IDS.includes(ctx.chat.id);
}

// Глобальный фильтр — стоит раньше всех bot.command/bot.on, поэтому
// отсекает неразрешённые группы до того, как сообщение попадёт в любой
// хендлер (команды, текст, реакции на аудио — вообще всё). В логах
// печатает id и название группы, откуда прилетело сообщение — удобно,
// чтобы потом просто скопировать id в ALLOWED_GROUP_IDS.
bot.use(async (ctx, next) => {
  if (!ctx.chat) return next();
  if (!isAllowedChat(ctx)) {
    console.warn(
      `Сообщение из неразрешённой группы (id: ${ctx.chat.id}, название: "${ctx.chat.title}") — игнорирую. ` +
        `Чтобы разрешить, добавь ${ctx.chat.id} в ALLOWED_GROUP_IDS.`
    );
    return;
  }
  await next();
});

bot.command("start", async (ctx) => {
  const chatId = ctx.chat.id;
  await clearHistory(chatId); // сброс истории при /start
  await ctx.reply("йо");
  const stickerId = pickSticker("greeting");
  if (stickerId) await ctx.replyWithSticker(stickerId);
});

// Доступна только владельцу — сброс контекста диалога влияет на всех
// в чате, не должен быть в руках любого участника группы.
bot.command("reset", async (ctx) => {
  if (!isOwner(ctx)) return;
  await clearHistory(ctx.chat.id);
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

  setAlias(chatId, userId, alias, `@${username}`);
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

  removeAlias(chatId, userId);
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

// /gender — посмотреть или задать пол вручную (перекрывает эвристику навсегда).
// Использование: /gender м | /gender ж — про себя
//                реплаем на чьё-то сообщение — про этого человека
//                без аргументов — показать текущее значение
// Доступно только владельцу (см. OWNER_USERNAME / isOwner) — остальным
// не сообщаем, через какого провайдера сейчас отвечает бот, и не даём
// переключать модели. Тем же способом (if (!isOwner(ctx)) return;) можно
// закрыть и любую другую команду ниже, если понадобится.

// Текст статуса для сообщения с кнопками /model — вынесен отдельно, чтобы
// переиспользовать и при первой отправке, и при обновлении того же
// сообщения после нажатия кнопки (см. callback_query ниже).
function buildModelsStatusText() {
  const now = Date.now();
  const active = TARGETS[activeTargetIndex];
  let text = `сейчас отвечаю через: ${active.provider}/${active.model}`;

  if (pinnedTargetIndex !== null) {
    const pinned = TARGETS[pinnedTargetIndex];
    text +=
      cooldownUntil[pinnedTargetIndex] > now
        ? `\n📌 закреплено: ${pinned.provider}/${pinned.model} (сейчас в cooldown, пока отвечаю в авто-режиме)`
        : `\n📌 закреплено вручную: ${pinned.provider}/${pinned.model}`;
  }

  const cooling = TARGETS
    .map((t, i) => ({ t, until: cooldownUntil[i] }))
    .filter((x) => x.until > now);
  if (cooling.length) {
    const list = cooling
      .map((x) => `${x.t.provider}/${x.t.model} (ещё ~${Math.ceil((x.until - now) / 1000)}с)`)
      .join(", ");
    text += `\nв cooldown: ${list}`;
  }

  text += `\n\nвыбери модель кнопкой (✅ доступна сейчас, ⏳ в cooldown — нажать нельзя):`;
  return text;
}

// Клавиатура: одна кнопка на цель (provider/model), плюс кнопка "авто" —
// снять ручное закрепление и вернуться к обычному фолбэку.
function buildModelsKeyboard() {
  const now = Date.now();
  const rows = TARGETS.map((t, i) => {
    const cold = cooldownUntil[i] > now;
    let mark = cold ? "⏳" : "✅";
    if (i === activeTargetIndex) mark += "👉";
    if (i === pinnedTargetIndex) mark += "📌";
    const label = `${mark} ${t.provider}/${t.model}`.slice(0, 64); // лимит Telegram на текст кнопки
    return [{ text: label, callback_data: `setmodel:${i}` }];
  });
  rows.push([{ text: "🔄 авто (снять закрепление)", callback_data: "setmodel:auto" }]);
  return { inline_keyboard: rows };
}

bot.command("model", async (ctx) => {
  if (!isOwner(ctx)) return;
  await ctx.reply(buildModelsStatusText(), { reply_markup: buildModelsKeyboard() });
});

// Обработка нажатий на кнопки из /model. Закрыто владельцем так же, как
// и сама команда — на всякий случай, если кто-то доберётся до кнопок в
// групповом чате (например, переслав сообщение с меню).
bot.on("callback_query:data", async (ctx, next) => {
  const data = ctx.callbackQuery.data;
  // ВАЖНО: это не единственный обработчик "callback_query:data" — ниже
  // есть отдельный для крокодила (см. bot.on("callback_query:data", ...)
  // дальше по файлу). grammY выполняет такие обработчики цепочкой через
  // next(), и если тут просто сделать return без next() — апдейт до
  // крокодила и других обработчиков дальше по цепочке вообще не дойдёт
  // (сама кнопка будет выглядеть так, будто "ничего не происходит" при
  // нажатии). Поэтому на чужой префикс явно передаём управление дальше.
  if (!data.startsWith("setmodel:")) return next();

  if (!isOwner(ctx)) {
    await ctx.answerCallbackQuery({ text: "эта кнопка только для владельца", show_alert: true });
    return;
  }

  const value = data.slice("setmodel:".length);

  if (value === "auto") {
    pinnedTargetIndex = null;
    savePinnedTargetIndex();
    await ctx.answerCallbackQuery({ text: "снял закрепление, вернулся в авто-режим" });
  } else {
    const idx = Number(value);
    if (!Number.isInteger(idx) || idx < 0 || idx >= TARGETS.length) {
      await ctx.answerCallbackQuery();
      return;
    }

    const now = Date.now();
    if (cooldownUntil[idx] > now) {
      const secLeft = Math.ceil((cooldownUntil[idx] - now) / 1000);
      await ctx.answerCallbackQuery({
        text: `${TARGETS[idx].provider}/${TARGETS[idx].model} ещё в cooldown ~${secLeft}с — недоступна`,
        show_alert: true,
      });
      return;
    }

    pinnedTargetIndex = idx;
    savePinnedTargetIndex();
    await ctx.answerCallbackQuery({
      text: `закрепил: ${TARGETS[idx].provider}/${TARGETS[idx].model}`,
    });
  }

  // Обновляем то же сообщение, чтобы отметки (👉/📌/⏳) на кнопках и текст
  // статуса сразу отражали новый выбор.
  try {
    await ctx.editMessageText(buildModelsStatusText(), { reply_markup: buildModelsKeyboard() });
  } catch (err) {
    // Например "message is not modified", если состояние не изменилось — не страшно.
    console.error("Не удалось обновить сообщение /model после нажатия кнопки:", err.message);
  }
});

bot.command("gender", async (ctx) => {
  const chatId = ctx.chat.id;
  const raw = (ctx.match || "").trim().toLowerCase();
  const target = ctx.message.reply_to_message?.from || ctx.from;
  const targetLabel = target.first_name || target.username || "этот юзер";

  if (!raw) {
    const current = getGender(chatId, target.id);
    await ctx.reply(
      current
        ? `сейчас для ${targetLabel} стоит: ${current === "m" ? "мужской" : "женский"}`
        : `пол для ${targetLabel} не задан — напиши /gender м или /gender ж (можно реплаем на чьё-то сообщение)`
    );
    return;
  }

  const MALE_WORDS = new Set(["м", "муж", "мужской", "male", "m"]);
  const FEMALE_WORDS = new Set(["ж", "жен", "женский", "female", "f"]);

  let gender;
  if (MALE_WORDS.has(raw)) gender = "m";
  else if (FEMALE_WORDS.has(raw)) gender = "f";
  else {
    await ctx.reply("не понял — напиши /gender м или /gender ж");
    return;
  }

  setGender(chatId, target.id, gender, "manual");
  await ctx.reply(`ок, записал: ${targetLabel} — ${gender === "m" ? "мужской" : "женский"}`);
});

// ==== Команда и кнопки для крокодила ====
// /krokodil работает как обычная команда — независимо от того, что в
// группе бот обычно отвечает только "по имени"/реплаем/упоминанием (это
// правило касается message:text, а не bot.command). Показывает либо
// приглашение стать ведущим (если раунда сейчас нет), либо статус
// текущего раунда — и в обоих случаях таблицу лидеров чата.
async function sendKrokodilIdleMessage(ctx, chatId) {
  const text = `🐊 Крокодил свободен — жми кнопку, чтобы стать ведущим и получить слово.\n\n${formatKrokodilLeaderboard(chatId)}`;
  await ctx.reply(text, { reply_markup: krokodilIdleKeyboard() });
}

bot.command("krokodil", async (ctx) => {
  const chatId = ctx.chat.id;
  const game = getKrokodilGame(chatId);

  if (!game || game.status === "idle") {
    await sendKrokodilIdleMessage(ctx, chatId);
    return;
  }

  if (game.status === "choosing") {
    await ctx.reply(`${game.candidateName} сейчас выбирает сложность слова — подожди секунду`);
    return;
  }

  // status === "active"
  await ctx.reply(
    `идёт раунд — ведёт ${game.hostName}, остальные угадывают словом в чат.\n\n${formatKrokodilLeaderboard(chatId)}`
  );
});

// /krokodil_reset — ручной "рестарт": принудительно закрывает текущий
// раунд (в статусе "choosing" ИЛИ "active") и возвращает игру в "idle" —
// не дожидаясь автосброса по таймауту (см. KROKODIL_TIMEOUT_MS выше).
// Специально доступна ЛЮБОМУ в чате, а не только ведущему/владельцу:
// единственный сценарий, ради которого она вообще нужна — ведущий взял
// слово и пропал, так что дожидаться его же команды на сброс бессмысленно.
// Читаем raw из Map, а не через getKrokodilGame — не хотим, чтобы
// автосброс по таймауту внутри getKrokodilGame тихо подменил game на уже
// idle ДО того, как мы соберём wasActive/revealedWord для сообщения.
// Счёт игроков (krokodilScores) не трогаем — сбрасывается только сам
// раунд, таблица лидеров чата остаётся как есть.
bot.command("krokodil_reset", async (ctx) => {
  const chatId = ctx.chat.id;
  const game = krokodilGames.get(chatId);

  if (!game || game.status === "idle") {
    await ctx.reply("раунд и так не идёт — жми кнопку, чтобы начать");
    return;
  }

  const wasActive = game.status === "active";
  const revealedWord = wasActive ? game.word : null;
  krokodilGames.set(chatId, { status: "idle", usedWords: game.usedWords || [] });
  saveKrokodilGame(chatId);

  const wordNote = revealedWord ? ` Слово было: «${revealedWord}».` : "";
  await ctx.reply(`🔄 раунд сброшен вручную.${wordNote}\n\n${formatKrokodilLeaderboard(chatId)}`, {
    reply_markup: krokodilIdleKeyboard(),
  });
});

// Естественный триггер вроде "Женя, крокодил" — проверяется в основном
// обработчике текстовых сообщений, ДО шахматно-шашечной логики (см.
// KROKODIL_INTENT_REGEX и блок "Крокодил" там) — специально раньше, чтобы
// незавершённая шахматная/шашечная партия не перехватывала это сообщение
// как попытку хода.

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (!data.startsWith("krokodil:")) return;

  const chatId = ctx.chat.id;
  const action = data.slice("krokodil:".length);
  const game = getKrokodilGame(chatId);
  const clicker = ctx.callbackQuery.from;

  // --- Кто-то хочет стать ведущим ---
  if (action === "host") {
    if (game && game.status === "active") {
      await ctx.answerCallbackQuery({ text: "раунд уже идёт — дождись, пока кто-то отгадает", show_alert: true });
      return;
    }
    if (game && game.status === "choosing" && game.candidateId !== clicker.id) {
      await ctx.answerCallbackQuery({ text: `${game.candidateName} уже выбирает слово — подожди`, show_alert: true });
      return;
    }

    krokodilGames.set(chatId, {
      status: "choosing",
      candidateId: clicker.id,
      candidateName: krokodilPlayerLabel(clicker),
      usedWords: game?.usedWords || [],
      startedAt: Date.now(),
    });
    saveKrokodilGame(chatId);

    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(`${krokodilPlayerLabel(clicker)} выбирает сложность слова...`, {
        reply_markup: krokodilDifficultyKeyboard(),
      });
    } catch (err) {
      console.error("Не удалось обновить сообщение крокодила (выбор сложности):", err.message);
    }
    return;
  }

  // --- Выбор сложности (только тот, кто нажал "хочу быть ведущим") ---
  if (action.startsWith("diff:")) {
    if (!game || game.status !== "choosing" || game.candidateId !== clicker.id) {
      await ctx.answerCallbackQuery({ text: "эта кнопка не для тебя", show_alert: true });
      return;
    }

    const difficulty = action.slice("diff:".length);
    const { word, usedWords } = pickKrokodilWord(chatId, difficulty);

    krokodilGames.set(chatId, {
      status: "active",
      hostId: clicker.id,
      hostName: krokodilPlayerLabel(clicker),
      word,
      difficulty,
      usedWords,
      startedAt: Date.now(),
    });
    saveKrokodilGame(chatId);

    // show_alert: true — Telegram показывает этот текст ТОЛЬКО тому, кто
    // нажал кнопку (даже в группе), поэтому слово не палится остальным.
    await ctx.answerCallbackQuery({
      text: `Твоё слово (${KROKODIL_DIFFICULTY_LABEL[difficulty]}): ${word}\n\nОбъясняй жестами/синонимами, само слово и однокоренные говорить нельзя!`,
      show_alert: true,
    });

    try {
      await ctx.editMessageText(
        `🐊 Раунд начался! Ведёт ${krokodilPlayerLabel(clicker)} (сложность: ${KROKODIL_DIFFICULTY_LABEL[difficulty]}).\nОстальные — пишите отгадки прямо в чат.`,
        { reply_markup: krokodilActiveKeyboard() }
      );
    } catch (err) {
      console.error("Не удалось обновить сообщение крокодила (старт раунда):", err.message);
    }
    return;
  }

  // --- Ведущий просит показать слово ещё раз ---
  if (action === "show") {
    if (!game || game.status !== "active") {
      await ctx.answerCallbackQuery({ text: "раунд уже не активен", show_alert: true });
      return;
    }
    if (game.hostId !== clicker.id) {
      await ctx.answerCallbackQuery({ text: "эта кнопка только для ведущего", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: `твоё слово: ${game.word}`, show_alert: true });
    return;
  }

  // --- Ведущий просит другое слово той же сложности ---
  if (action === "reroll") {
    if (!game || game.status !== "active") {
      await ctx.answerCallbackQuery({ text: "раунд уже не активен", show_alert: true });
      return;
    }
    if (game.hostId !== clicker.id) {
      await ctx.answerCallbackQuery({ text: "эта кнопка только для ведущего", show_alert: true });
      return;
    }
    const { word, usedWords } = pickKrokodilWord(chatId, game.difficulty);
    krokodilGames.set(chatId, { ...game, word, usedWords });
    saveKrokodilGame(chatId);
    await ctx.answerCallbackQuery({
      text: `новое слово (${KROKODIL_DIFFICULTY_LABEL[game.difficulty]}): ${word}`,
      show_alert: true,
    });
    return;
  }

  // --- Ведущий сдаётся — раунд заканчивается без победителя ---
  if (action === "giveup") {
    if (!game || game.status !== "active") {
      await ctx.answerCallbackQuery({ text: "раунд уже не активен", show_alert: true });
      return;
    }
    if (game.hostId !== clicker.id) {
      await ctx.answerCallbackQuery({ text: "эта кнопка только для ведущего", show_alert: true });
      return;
    }

    const revealedWord = game.word;
    krokodilGames.set(chatId, { status: "idle", usedWords: game.usedWords });
    saveKrokodilGame(chatId);

    await ctx.answerCallbackQuery({ text: "ладно, раунд окончен" });
    try {
      await ctx.editMessageText(
        `🏳 ${game.hostName} сдался, слово было: «${revealedWord}».\n\n${formatKrokodilLeaderboard(chatId)}`,
        { reply_markup: krokodilIdleKeyboard() }
      );
    } catch (err) {
      console.error("Не удалось обновить сообщение крокодила (сдался):", err.message);
    }
    return;
  }

  await ctx.answerCallbackQuery();
});

// ==== Погода (Open-Meteo, без ключа) ====
// Триггер — слово "погода"/"погоды" в сообщении, адресованном боту (та же
// гейтовая логика, что и у остального: в личке всегда, в группе — после
// имени/реплая/упоминания, см. ниже перед основным блоком). Понимает и
// текущую погоду ("погода в Киеве"), и прогноз ("погода в Киеве на 10
// дней"/"на неделю"). Города — на русском (в т.ч. в разных падежах, см.
// geocodeCity) и на английском, для любой точки на планете — используется
// геокодер Open-Meteo (geocoding-api.open-meteo.com), а не захардкоженный
// список городов.
const WMO_WEATHER = {
  0: { icon: "☀️", desc: "ясно" },
  1: { icon: "🌤", desc: "малооблачно" },
  2: { icon: "⛅", desc: "переменная облачность" },
  3: { icon: "☁️", desc: "пасмурно" },
  45: { icon: "🌫", desc: "туман" },
  48: { icon: "🌫", desc: "изморозь" },
  51: { icon: "🌦", desc: "морось слабая" },
  53: { icon: "🌦", desc: "морось" },
  55: { icon: "🌧", desc: "морось сильная" },
  56: { icon: "🌧", desc: "ледяная морось слабая" },
  57: { icon: "🌧", desc: "ледяная морось сильная" },
  61: { icon: "🌦", desc: "дождь слабый" },
  63: { icon: "🌧", desc: "дождь" },
  65: { icon: "🌧", desc: "дождь сильный" },
  66: { icon: "🌧", desc: "ледяной дождь слабый" },
  67: { icon: "🌧", desc: "ледяной дождь сильный" },
  71: { icon: "🌨", desc: "снег слабый" },
  73: { icon: "❄️", desc: "снег" },
  75: { icon: "❄️", desc: "снег сильный" },
  77: { icon: "❄️", desc: "снежная крупа" },
  80: { icon: "🌦", desc: "ливень слабый" },
  81: { icon: "🌧", desc: "ливень" },
  82: { icon: "⛈", desc: "ливень сильный" },
  85: { icon: "🌨", desc: "снегопад слабый" },
  86: { icon: "❄️", desc: "снегопад сильный" },
  95: { icon: "⛈", desc: "гроза" },
  96: { icon: "⛈", desc: "гроза с градом" },
  99: { icon: "⛈", desc: "гроза с сильным градом" },
};
function describeWeatherCode(code) {
  return WMO_WEATHER[code] || { icon: "🌡", desc: "погода без сюрпризов" };
}

// Разбирает намерение "погода в <город>[ на N дней|на неделю]" из текста.
// Возвращает { city, days } (days=1 — текущая погода) или null.
// ВАЖНО: \b в JS работает через \w, который НЕ включает кириллицу (то же
// уже отмечено в parseRequestedUserColor выше) — поэтому тут вместо \b
// используются обычные пробелы/якоря начала-конца строки.
function parseWeatherIntent(text) {
  if (!/погод[аы]/i.test(text)) return null;
  const afterMatch = text.match(/погод[аы](.*)$/is);
  if (!afterMatch) return null;
  let rest = afterMatch[1].trim();
  if (!rest) return null;

  let days = 1;
  const weekMatch = /(?:^|\s)на\s+недел[а-яё]*/i.exec(rest);
  const daysMatch = /(?:^|\s)на\s+(\d{1,2})\s*(?:дн[а-яё]*|days?)/i.exec(rest);
  if (daysMatch) {
    days = Math.min(16, Math.max(1, parseInt(daysMatch[1], 10)));
    rest = rest.slice(0, daysMatch.index).trim();
  } else if (weekMatch) {
    days = 7;
    rest = rest.slice(0, weekMatch.index).trim();
  }

  const hadPreposition = /^(?:в|во|для|по)\s+/i.test(rest);
  rest = rest.replace(/^(?:в|во|для|по)\s+/i, "").trim();
  rest = rest.replace(/[.,!?;:]+$/g, "").trim();
  if (!rest) return null;
  // Без предлога ("погода Львов") принимаем, только если похоже на имя
  // города (с большой буквы) — иначе просто разговорное упоминание погоды
  // ("хорошая погода сегодня") улетало бы в геокодер как имя города.
  if (!hadPreposition && !/^[А-ЯЁA-Z]/.test(rest)) return null;
  return { city: rest, days };
}

// Геокодинг с фолбэком на грамматические падежи: Open-Meteo матчит только
// по ПРЕФИКСУ индексированного имени (см. docs geocoding-api.open-meteo.com),
// а "Киеве"/"Одессе" — это предложный падеж, не префикс "Киев"/"Одесса".
// Большинство русских окончаний падежей — это 1-2 лишних символа В КОНЦЕ
// слова, так что обрубание хвоста по одному символу обычно и даёт нужный
// префикс ("Киеве" → "Киев" — точное совпадение, "Одессе" → "Одесс" —
// префикс "Одессы"). Пробуем от полной строки и короче, до 3 символов.
// Для ранжирования результатов геокодера: "ё" в написании пользователя
// нередко на деле означает "е" (Королёв/Королев и т.п.), а count=1 в
// Open-Meteo не гарантирует, что вернётся самый крупный/точный по имени
// населённый пункт — маленький посёлок с похожим названием (тоже
// подходящий по префиксу) может обогнать миллионник. Нормализуем и для
// сравнения точности, и приводим population к числу для сравнения размера.
function normalizeCityName(s) {
  return (s || "").toLowerCase().replace(/ё/g, "е");
}

// Оценивает, насколько хорошо кандидат geocoder'а соответствует запросу:
// точное совпадение имени весит намного больше, чем просто совпадение по
// префиксу (на которое опирается geocodeCity из-за падежей) — иначе
// небольшой населённый пункт, начинающийся на то же слово, может
// перевесить нужный крупный город только за счёт населения.
function scoreGeocodeHit(hit, query) {
  const name = normalizeCityName(hit.name);
  const q = normalizeCityName(query);
  const exact = name === q ? 1_000_000_000 : 0;
  const population = Number(hit.population) || 0;
  return exact + population;
}

// Геокодинг с фолбэком на грамматические падежи: Open-Meteo матчит только
// по ПРЕФИКСУ индексированного имени (см. docs geocoding-api.open-meteo.com),
// а "Киеве"/"Одессе" — это предложный падеж, не префикс "Киев"/"Одесса".
// Большинство русских окончаний падежей — это 1-2 лишних символа В КОНЦЕ
// слова, так что обрубание хвоста по одному символу обычно и даёт нужный
// префикс ("Киеве" → "Киев" — точное совпадение, "Одессе" → "Одесс" —
// префикс "Одессы"). Пробуем от полной строки и короче, до 3 символов.
async function geocodeCity(rawCity) {
  const base = rawCity.trim();
  const candidates = [base];
  for (let len = base.length - 1; len >= Math.min(3, base.length); len--) {
    candidates.push(base.slice(0, len));
  }

  for (const candidate of candidates) {
    if (candidate.length < 2) continue;
    try {
      // count=10, а не 1 — чтобы было из чего выбрать: при обрезанном по
      // падежу префиксе под него может подходить сразу несколько мест
      // (крупный город и созвучный посёлок), а нам нужен самый релевантный,
      // а не первый по версии API (см. scoreGeocodeHit).
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
        candidate
      )}&count=10&language=ru&format=json`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      const hits = data?.results;
      if (!hits || hits.length === 0) continue;

      const best = hits.reduce((a, b) => (scoreGeocodeHit(b, base) > scoreGeocodeHit(a, base) ? b : a));

      return {
        name: best.name,
        country: best.country || "",
        admin1: best.admin1 || "",
        latitude: best.latitude,
        longitude: best.longitude,
        timezone: best.timezone || "auto",
      };
    } catch (err) {
      console.error(`Геокодинг "${candidate}" не удался:`, err.message);
    }
  }
  return null;
}

function locationLabel(place) {
  const parts = [place.name];
  if (place.admin1 && place.admin1 !== place.name) parts.push(place.admin1);
  if (place.country) parts.push(place.country);
  return parts.join(", ");
}

async function fetchCurrentWeatherText(place) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
    `&timezone=${encodeURIComponent(place.timezone)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`open-meteo forecast: ${res.status}`);
  const data = await res.json();
  const c = data.current;
  const w = describeWeatherCode(c.weather_code);
  return (
    `Погода в ${locationLabel(place)} сейчас:\n` +
    `${w.icon} ${w.desc}, ${Math.round(c.temperature_2m)}°C (ощущается как ${Math.round(c.apparent_temperature)}°C)\n` +
    `💧 влажность ${c.relative_humidity_2m}% · 💨 ветер ${Math.round(c.wind_speed_10m)} м/с`
  );
}

async function fetchForecastWeatherText(place, days) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&forecast_days=${days}&timezone=${encodeURIComponent(place.timezone)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`open-meteo forecast: ${res.status}`);
  const data = await res.json();
  const d = data.daily;
  const lines = [`Погода в ${locationLabel(place)} на ${days} ${daysWordForm(days)}:`];
  for (let i = 0; i < d.time.length; i++) {
    const w = describeWeatherCode(d.weather_code[i]);
    const date = formatShortDate(d.time[i]);
    const tMax = Math.round(d.temperature_2m_max[i]);
    const tMin = Math.round(d.temperature_2m_min[i]);
    const precip = d.precipitation_probability_max[i];
    lines.push(`${date} ${w.icon} ${tMin}…${tMax}°C, осадки ${precip}%`);
  }
  return lines.join("\n");
}

// "1 день" / "2 дня" / "5 дней" — русское словообразование числительных.
function daysWordForm(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "день";
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "дня";
  return "дней";
}

function formatShortDate(isoDate) {
  const [, month, day] = isoDate.split("-");
  return `${day}.${month}`;
}

async function handleWeatherQuery(ctx, intent) {
  await ctx.replyWithChatAction("typing", { message_thread_id: ctx.message.message_thread_id });
  const place = await geocodeCity(intent.city);
  if (!place) {
    await ctx.reply(`не нашёл такой город — "${intent.city}". Проверь название и попробуй ещё раз`);
    return;
  }
  try {
    const text =
      intent.days > 1 ? await fetchForecastWeatherText(place, intent.days) : await fetchCurrentWeatherText(place);
    await ctx.reply(text);
  } catch (err) {
    console.error("Ошибка получения погоды:", err);
    await ctx.reply("не получилось узнать погоду, сервис погоды сейчас недоступен — попробуй позже");
  }
}

// ==== Пересказ чата ("о чём тут речь?") ====
// Отдельная механика поверх ChatLog (см. pushChatLog выше): пользователь
// просит вкратце пересказать последние N сообщений в группе — например
// "Женя, о чём тут речь? 100" или "Женя, что я пропустил, 50 сообщений".
// Число — сколько последних сообщений взять из лога; если не указано,
// берём DEFAULT_RECAP_COUNT. Сообщения от других ботов в лог не попадают
// вообще (см. фильтр ctx.from.is_bot в bot.on("message:text")), так что
// отдельно фильтровать их тут не нужно.
const RECAP_INTENT_REGEX =
  /(о\s*чём|о\s*чем)\s+(тут|здесь|в\s+чате)?\s*(речь|говорил|шла\s+речь)|что\s+(тут|здесь)?\s*(обсужда|происходи|писали|было|творил)|перескаж|пересказ|что\s+я\s+пропустил|краткое\s+содержан|саммари\s+чата|сумму\s+чата/i;
const DEFAULT_RECAP_COUNT = 50;
const MAX_RECAP_COUNT = CHAT_LOG_LIMIT;

// Вытаскивает запрошенное число сообщений из текста ("... речь? 100" -> 100).
// Если чисел несколько — берём первое; если чисел нет — null (сработает
// DEFAULT_RECAP_COUNT).
function parseRecapCount(text) {
  const match = text.match(/\d{1,4}/);
  if (!match) return null;
  const n = Number(match[0]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, MAX_RECAP_COUNT);
}

const RECAP_SYSTEM_PROMPT = `Тебе дана выгрузка последних сообщений группового Telegram-чата в формате "Имя: текст" (для сообщений, адресованных боту, будет пометка "(обращался к боту)"). Твоя задача — коротко и по делу пересказать, о чём шла речь.

Правила:
- Пиши по-русски, живым разговорным языком, без канцелярита и без вступлений вроде "вот пересказ".
- Формат — короткие пункты (списком через дефис), 3-7 пунктов, каждый пункт — максимум 1-2 строки. Указывай, кто о чём говорил, если это понятно из текста.
- Ничего не выдумывай сверх того, что реально написано в переписке.
- Если человек за это время в основном (или только) переписывался с ботом, а не с остальными — сделай по нему отдельный короткий пункт вида "Имя общался(-ась) с ботом о том-то", не пересказывая ответы бота подробно.
- Мелкие технические реплики (одно слово, эмодзи, "+1" и т.п.) не заслуживают отдельного пункта — просто пропускай их.
- Если по существу обсуждать нечего (болтовня ни о чём, спам) — так и скажи одной фразой, без списка.`;

// Отдельный вызов LLM в обход основной истории диалога (askLLM/pushHistory) —
// пересказ не должен засорять контекст обычного чата с ботом и не должен
// зависеть от него.
async function askRecapLLM(userPrompt) {
  const messages = [
    { role: "system", content: RECAP_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  const now = Date.now();
  let order = [...TARGETS.keys()].sort((a, b) => {
    const aCold = cooldownUntil[a] > now ? 1 : 0;
    const bCold = cooldownUntil[b] > now ? 1 : 0;
    return aCold - bCold || a - b;
  });
  if (pinnedTargetIndex !== null && cooldownUntil[pinnedTargetIndex] <= now) {
    order = [pinnedTargetIndex, ...order.filter((idx) => idx !== pinnedTargetIndex)];
  }

  let lastErr;
  for (const idx of order) {
    const target = TARGETS[idx];
    try {
      const { reply: rawReply } = await callTarget(target, messages);
      const { text: reply } = extractSticker(rawReply); // пересказу стикеры не нужны, просто чистим тег если модель его всё же добавила
      cooldownUntil[idx] = 0;
      return reply;
    } catch (err) {
      lastErr = err;
      console.error(
        `Ошибка пересказа [${target.provider}/${target.model}]:`,
        err.status ?? "-",
        err.body ?? err.message
      );
      if (err.status && !isFallbackWorthy(err.status)) break;
      cooldownUntil[idx] = Date.now() + MODEL_COOLDOWN_MS;
    }
  }

  throw lastErr ?? new Error("Все провайдеры и модели недоступны");
}

async function handleRecapQuery(ctx, chatId, requestedCount) {
  const log = getChatLog(chatId);
  if (log.length === 0) {
    await ctx.reply("пока не набралось сообщений в этом чате, чтобы что-то пересказывать");
    return;
  }

  const count = Math.max(1, Math.min(requestedCount || DEFAULT_RECAP_COUNT, log.length));
  const slice = log.slice(-count);

  const transcript = slice
    .map((m) => `${m.name}${m.toBot ? " (обращался к боту)" : ""}: ${m.text}`)
    .join("\n");

  await ctx.replyWithChatAction("typing", { message_thread_id: ctx.message.message_thread_id });
  try {
    const reply = await askRecapLLM(
      `Вот последние ${slice.length} сообщений чата:\n\n${transcript}`
    );
    await ctx.reply(reply, {
      reply_parameters: { message_id: ctx.message.message_id },
      message_thread_id: ctx.message.message_thread_id,
    });
  } catch (err) {
    console.error("Ошибка при пересказе чата:", err);
    await ctx.reply("не получилось собрать пересказ, попробуй чуть позже");
  }
}

// ==== Фото (пассивное распознавание для лога/пересказа) ====
// Идея: НЕ дёргать основные диалоговые модели (Gemini и т.п.) на каждое
// фото — вместо этого каждое фото в группе тихо (без ответа в чат) уходит
// на отдельную vision-модель (Qwen на Groq, см. GROQ_VISION_MODEL), и её
// короткое описание попадает и в ChatLog (для команды "о чём тут речь"),
// и в обычную HISTORY диалога (см. pushHistory) — чтобы если кто-то потом
// в обычном разговоре спросит бота (на любой модели, необязательно Groq)
// "а что было на фото" — та модель уже увидит текстовое описание в
// контексте и сможет ответить, сама картинку не разбирая и не тратя на
// это токены. Работает только в группах — см. фильтр isGroup в хендлере.
const PHOTO_CAPTION_PROMPT =
  "Кратко опиши по-русски, что на этой фотографии — 1 короткое предложение, без вступлений вроде «на фото изображено». " +
  "Если это скриншот текста/переписки — перескажи суть текста, а не то, как он оформлен. Если еда — что за блюдо. " +
  "Если мем/шутка — в чём соль. Пиши только суть, без markdown и кавычек.";

// Скачивает файл из Telegram (по file_id) и возвращает его как base64 —
// именно скачиваем сами и шлём как data-URI, а не передаём модели прямую
// ссылку вида api.telegram.org/file/bot<TOKEN>/... — иначе токен бота
// улетел бы третьей стороне (серверам Groq, которые бы сами фетчили URL).
async function fetchTelegramFileBase64(ctx, fileId) {
  const file = await ctx.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Не удалось скачать файл из Telegram: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = file.file_path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
  return { base64: buf.toString("base64"), mime };
}

// Отдельный точечный вызов vision-модели — в обход askLLM/TARGETS-фолбэка:
// тут только одна конкретная модель (GROQ_VISION_MODEL), без перебора
// провайдеров, потому что это узкоспециальная задача, а не общий чат.
// callTarget переиспользуем как есть — он уже умеет reasoning_effort для
// qwen-моделей на groq, таймаут, чистку <think>/утечек рассуждений и т.п.
async function captionPhoto(ctx, fileId) {
  const { base64, mime } = await fetchTelegramFileBase64(ctx, fileId);
  const visionTarget = {
    provider: "groq",
    model: GROQ_VISION_MODEL,
    baseUrl: PROVIDER_CONFIGS.groq.baseUrl,
    apiKey: GROQ_API_KEY,
  };
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: PHOTO_CAPTION_PROMPT },
        { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
      ],
    },
  ];
  const { reply } = await callTarget(visionTarget, messages);
  return reply;
}

// ==== Реакция стикером на присланную песню/аудио ====
// Отдельно от текстовых ответов через LLM — тут модель вообще не участвует,
// это чисто механическая реакция: пришло аудио/голосовое → шлём стикер из
// категории "music". В группе реагируем, только если это реплай на
// сообщение бота (иначе бот реагировал бы на любую музыку в чате подряд).
bot.on(["message:audio", "message:voice"], async (ctx) => {
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
  if (isGroup) {
    const isReplyToBot = ctx.message.reply_to_message?.from?.id === ctx.me.id;
    if (!isReplyToBot) return;
  }

  const stickerId = pickSticker("music");
  if (!stickerId) return; // категория ещё не заполнена — молчим

  await ctx.replyWithSticker(stickerId, {
    reply_parameters: { message_id: ctx.message.message_id },
    message_thread_id: ctx.message.message_thread_id,
  });
});

// ==== Фото в группе — пассивный лог, без ответа в чат ====
// Срабатывает на КАЖДОЕ фото в группе (не только адресованное боту) — см.
// пояснение к captionPhoto выше. Бот при этом ничего не пишет в чат: это
// чисто фоновая запись в ChatLog + HISTORY, а не реакция на сообщение.
// Фото от других ботов игнорируем (как и в общем текстовом логе).
bot.on("message:photo", async (ctx) => {
  const chatId = ctx.chat.id;
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
  if (!isGroup) return; // в личке фото не разбираем вообще — см. обсуждение в чате с разработчиком
  if (ctx.from.is_bot) return;

  rememberUsername(chatId, ctx.from);
  const displayName = getDisplayName(chatId, ctx.from);

  // Была ли подпись/реплай адресованы боту — тот же набор сигналов, что и
  // для обычных текстовых сообщений (см. bot.on("message:text")), только
  // источник текста — caption, а не сам текст сообщения (у фото его нет).
  const captionText = ctx.message.caption || "";
  const isReplyToBot = ctx.message.reply_to_message?.from?.id === ctx.me.id;
  const isMentioned =
    ctx.message.caption_entities?.some(
      (e) =>
        e.type === "mention" &&
        captionText.substring(e.offset, e.offset + e.length).toLowerCase() ===
          `@${ctx.me.username?.toLowerCase()}`
    ) ?? false;
  const toBot = nameTriggerRegex.test(captionText) || isReplyToBot || isMentioned || ownerMentionRegex.test(captionText);

  try {
    // Берём не самый большой размер (обычно последний в массиве) — он
    // сильно тяжелее в скачивании и токенах, а для короткого текстового
    // описания достаточно среднего качества. Если размер всего один —
    // берём его же.
    const sizes = ctx.message.photo;
    const photo = sizes.length > 1 ? sizes[sizes.length - 2] : sizes[sizes.length - 1];

    const caption = await captionPhoto(ctx, photo.file_id);

    const logLine = captionText ? `[фото: ${caption}] ${captionText}` : `[фото] ${caption}`;
    pushChatLog(chatId, displayName, logLine, toBot);
    // Кладём и в обычную историю диалога — чтобы модель, к которой в
    // будущем обратятся в этом чате (не обязательно на Groq), уже видела
    // текстовое описание фото в контексте, не разбирая картинку сама.
    // ВАЖНО: HISTORY_LIMIT всего 12 сообщений — в очень активном чате с
    // частыми фото это описание может довольно быстро "вытолкнуть" из
    // контекста реальные реплики. Если станет мешать — либо поднять
    // HISTORY_LIMIT, либо не класть сюда, оставить только ChatLog.
    pushHistory(chatId, "user", `${displayName} прислал(а) фото: ${caption}`);
  } catch (err) {
    // Намеренно тихо: это фоновая обработка, а не ответ на прямой запрос,
    // спамить в чат ошибками про каждое неудачно распознанное фото не надо.
    console.error(`Не удалось распознать фото в чате ${chatId}:`, err.status ?? "-", err.body ?? err.message);
  }
});

bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
  let userText = ctx.message.text;
  // Сырой текст без последующих преобразований userText (вырезание имени,
  // добавление префиксов) — нужен для распознавания шахматных ходов,
  // которые парсит не LLM, а chess.js.
  const rawText = ctx.message.text;

  // Определяем пол пораньше (до проверки триггеров), чтобы выбрать нужный
  // блок — мужской или женский. Смотрим по исходному тексту сообщения.
  updateGenderGuess(chatId, ctx.from, ctx.message.text);
  const gender = getGender(chatId, ctx.from.id);

  // Стёб по триггерным фразам — срабатывает независимо от того,
  // обращались ли к боту напрямую. Блок выбирается по полу отправителя:
  // мужчины -> MALE_BANTER_TRIGGERS/"banter_male", женщины ->
  // FEMALE_BANTER_TRIGGERS/"banter_female". Если пол неизвестен — не
  // срабатывает. Дальше сообщение всё равно обрабатывается как обычно
  // (вдруг оно ещё и адресовано боту).
  // regexStickerFired — чтобы модель не прислала ещё один стикер тем же
  // тегом на то же сообщение (см. использование ниже, у отправки ответа).
  let regexStickerFired = false;
  if (gender === "m" && matchesTrigger(userText, MALE_BANTER_TRIGGERS)) {
    regexStickerFired = true;
    const stickerId = pickSticker("banter_male");
    if (stickerId) {
      await ctx
        .replyWithSticker(stickerId, {
          reply_parameters: { message_id: ctx.message.message_id },
          message_thread_id: ctx.message.message_thread_id,
        })
        .catch((err) => console.error("Не удалось отправить banter_male-стикер:", err));
    }
  } else if (gender === "f" && matchesTrigger(userText, FEMALE_BANTER_TRIGGERS)) {
    regexStickerFired = true;
    const stickerId = pickSticker("banter_female");
    if (stickerId) {
      await ctx
        .replyWithSticker(stickerId, {
          reply_parameters: { message_id: ctx.message.message_id },
          message_thread_id: ctx.message.message_thread_id,
        })
        .catch((err) => console.error("Не удалось отправить banter_female-стикер:", err));
    }
  }

  // Проверка отгадки в крокодиле — срабатывает на ЛЮБОЕ сообщение в чате,
  // без обращения к боту по имени (иначе играть было бы неудобно: в
  // реальной игре отгадки просто выкрикивают). Ведущего из проверки
  // исключаем — его собственные подсказки не должны засчитываться сами
  // себе. Если слово отгадано — раунд сразу завершается и открывается
  // кнопка для следующего ведущего.
  {
    const krokodilGame = getKrokodilGame(chatId);
    if (krokodilGame && krokodilGame.status === "active" && ctx.from.id !== krokodilGame.hostId) {
      const tokens = rawText.toLowerCase().replace(/ё/g, "е").match(/[a-zа-я]+/gi) || [];
      const guessed = tokens.some((t) => krokodilTokenMatches(t, krokodilGame.word));
      if (guessed) {
        const scoreMap = getKrokodilScoreMap(chatId);
        const label = krokodilPlayerLabel(ctx.from);
        const prev = scoreMap.get(ctx.from.id) || { name: label, score: 0 };
        const updated = { name: label, score: prev.score + 1 };
        scoreMap.set(ctx.from.id, updated);
        saveKrokodilScores(chatId);

        krokodilGames.set(chatId, { status: "idle", usedWords: krokodilGame.usedWords });
        saveKrokodilGame(chatId);

        await ctx.reply(
          `🎉 ${label} угадал(а) слово «${krokodilGame.word}»! +1 очко (теперь ${updated.score}).\n\n${formatKrokodilLeaderboard(
            chatId
          )}`,
          { reply_markup: krokodilIdleKeyboard(), reply_parameters: { message_id: ctx.message.message_id } }
        );
        return; // раунд закрыт — дальше это сообщение никуда не идёт (ни в чат-триггеры, ни в LLM)
      }
    }
  }

  if (isGroup) {
    rememberUsername(chatId, ctx.from);

    // В группе отвечаем только если:
    // 1) сообщение начинается с обращения по имени ("Женя, ...")
    // 2) это реплай на сообщение самого бота
    // 3) бота явно упомянули через @username
    // 4) кто-то позвал настоящего Женю через его тег в Telegram (@EVGEN1Y_V)
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
    const isOwnerMentioned = ownerMentionRegex.test(userText);
    const isAddressedToBot = startsWithName || isReplyToBot || isMentioned || isOwnerMentioned;

    // Пишем сообщение в лог чата (см. pushChatLog) ДО фильтра "не наше
    // сообщение — молчим" ниже — иначе в лог попадали бы только реплики,
    // адресованные боту, и пересказывать было бы нечего. Сообщения от
    // других ботов не логируем.
    if (!ctx.from.is_bot) {
      pushChatLog(chatId, getDisplayName(chatId, ctx.from), rawText, isAddressedToBot);
    }

    if (!isAddressedToBot) {
      return; // не наше сообщение — молчим
    }

    if (startsWithName) {
      userText = stripNameTrigger(userText);
      if (!userText) userText = "привет"; // если написали просто "Женя"
    }

    // Если бота явно упомянули через @username — вырезаем сам тег из текста,
    // который пойдёт модели. Иначе модель увидит сырой "@EVGEN1Y_VBOT" и
    // может спутать его с тегом настоящего Жени (@EVGEN1Y_V — это ровно
    // префикс юзернейма бота), хотя isMentioned/isOwnerMentioned на уровне
    // кода уже корректно их различают (\b в ownerMentionRegex + проверка
    // !isMentioned ниже) — проблема именно в том, что сырая строка всё
    // равно долетает до LLM и вводит её в заблуждение.
    if (isMentioned) {
      const botMentionEntity = ctx.message.entities.find(
        (e) =>
          e.type === "mention" &&
          userText
            .substring(e.offset, e.offset + e.length)
            .toLowerCase() === `@${ctx.me.username?.toLowerCase()}`
      );
      if (botMentionEntity) {
        userText =
          userText.slice(0, botMentionEntity.offset) +
          userText.slice(botMentionEntity.offset + botMentionEntity.length);
        userText = userText.trim();
        if (!userText) userText = "привет"; // если написали только "@EVGEN1Y_VBOT"
      }
    }

    // Подсказываем модели, кто говорит — "Имя: текст"
    const displayName = getDisplayName(chatId, ctx.from);
    userText = `${displayName}: ${userText}`;

    // Если позвали именно тег настоящего Жени (а не по имени/реплаем на
    // бота) — добавляем метку-подсказку, см. пояснение в SYSTEM_PROMPT.
    if (isOwnerMentioned && !startsWithName && !isReplyToBot && !isMentioned) {
      userText = `[позвали через тег настоящего Жени @${OWNER_USERNAME}] ${userText}`;
    }
  }

  // ==== Анекдоты ====
  // Тоже проверяем ДО обычного чата и отвечаем не через LLM — сначала
  // пробуем свежий анекдот с внешнего источника, при неудаче/пустом
  // ответе тихо уходим на курируемую базу (см. getJoke/JOKES выше).
  // Модель на такую просьбу обычно выдумывает несмешную ерунду.
  if (isJokeRequest(stripNameTrigger(rawText))) {
    await ctx.replyWithChatAction("typing", { message_thread_id: ctx.message.message_thread_id });
    await ctx.reply(await getJoke(chatId), { reply_parameters: { message_id: ctx.message.message_id } });
    return;
  }

  // ==== Погода ====
  // Проверяем ДО шахмат/шашек и обычного чата — сработавший запрос
  // погоды отвечает сразу через API, а не через LLM (даты/проценты
  // осадков модель может просто выдумать).
  const weatherIntent = parseWeatherIntent(stripNameTrigger(rawText));
  if (weatherIntent) {
    await handleWeatherQuery(ctx, weatherIntent);
    return;
  }

  // ==== Пересказ чата ("Женя, о чём тут речь? 100") ====
  // Только в группах — лог (ChatLog) заполняется исключительно там, в
  // личке пересказывать нечего (там и так вся история — это диалог с
  // самим ботом). Отвечает не через обычный askLLM/историю чата, а через
  // отдельный askRecapLLM на основе лога сообщений — см. handleRecapQuery.
  if (isGroup && RECAP_INTENT_REGEX.test(stripNameTrigger(rawText))) {
    await handleRecapQuery(ctx, chatId, parseRecapCount(rawText));
    return;
  }

  // ==== Крокодил (естественный триггер "Женя, крокодил") ====
  // Проверяем ДО шахмат/шашек — по той же причине, что и погода/анекдоты
  // выше: если оставить эту проверку в конце шахматно-шашечной цепочки (как
  // было раньше), то при незавершённой шахматной/шашечной партии у этого
  // пользователя сообщение "Женя, крокодил" сначала пыталось бы
  // распознаться как ход/команда партии, не подошло бы под них — и тихо
  // улетало в обычный LLM-чат вместо запуска крокодила. Здесь же триггер
  // не может ничего сломать в шахматах/шашках (слово "крокодил" не
  // пересекается ни с одной из их команд), так что вынести его раньше
  // безопасно.
  if (KROKODIL_INTENT_REGEX.test(rawText)) {
    const krokodilGame = getKrokodilGame(chatId);
    if (!krokodilGame || krokodilGame.status === "idle") {
      await sendKrokodilIdleMessage(ctx, chatId);
    } else if (krokodilGame.status === "choosing") {
      await ctx.reply(`${krokodilGame.candidateName} сейчас выбирает сложность слова — подожди секунду`);
    } else {
      await ctx.reply(
        `идёт раунд — ведёт ${krokodilGame.hostName}, остальные угадывают словом в чат.\n\n${formatKrokodilLeaderboard(
          chatId
        )}`
      );
    }
    return;
  }

  // ==== Шахматы ====
  // Дошли сюда — значит сообщение точно адресовано боту (в личке всегда,
  // в группе — прошло проверку выше). Партия привязана к паре
  // chatId+userId (см. chessMapKey), поэтому в одном чате (особенно
  // группе) у разных людей могут одновременно идти свои отдельные партии,
  // и ходить в партии может только тот, кто её начал — сообщения других
  // людей просто не видят чужую chessGame и уходят в обычный чат/заводят
  // свою партию. Если для этого пользователя уже идёт партия, пробуем
  // понять сообщение как ход/команду партии; если это ни на что из этого
  // не похоже — просто продолжаем как обычное сообщение в чат ниже (можно
  // болтать параллельно с игрой).
  const userId = ctx.from.id;
  const chessGame = getChessGame(chatId, userId);
  // То же самое для шашек — своя независимая партия под тем же составным
  // ключом chatId+userId, см. checkersMapKey. Один и тот же пользователь
  // не может одновременно вести и шахматную, и шашечную партию: шахматный
  // блок ниже проверяется первым, шашечный — только если шахматной партии
  // нет (см. цепочку if/else if дальше).
  const checkersGame = getCheckersGame(chatId, userId);

  if (chessGame) {
    if (CHESS_RESIGN_REGEX.test(rawText)) {
      await clearChessGame(chatId, userId);
      await ctx.reply(pickRandom(CHESS_RESIGN_PHRASES));
      return;
    }

    // Ход проверяем ДО команд "покажи доску"/"новая партия" — сообщение
    // вида "e2e4, покажи доску" должно сначала применить ход (новая доска
    // и так придёт в ответе), а не просто напечатать старую позицию,
    // проигнорировав сам ход.
    const chess = new Chess(chessGame.fen);
    if (chess.turn() === chessGame.userColor) {
      const applied = tryApplyUserMove(chess, rawText);
      if (applied) {
        const { move, style } = applied;
        // Съеденную ходом пользователя фигуру (если был размен) — в счёт.
        // move.captured — тип чужой фигуры, которую съели (принадлежит
        // противнику хода, т.е. боту), кладём в captured[botColor].
        const prevCaptured = chessGame.captured || { w: [], b: [] };
        const captured = { w: [...prevCaptured.w], b: [...prevCaptured.b] };
        const botColor = chessGame.userColor === "w" ? "b" : "w";
        if (move.captured) captured[botColor].push(move.captured);

        chessGames.set(chessMapKey(chatId, userId), {
          fen: chess.fen(),
          userColor: chessGame.userColor,
          view: chessGame.view,
          playerName: chessGame.playerName,
          captured,
          moveStyle: style,
        });
        saveChessGame(chatId, userId);

        const userMoveText = formatChessMove(move, style);

        if (chess.isCheckmate()) {
          await ctx.reply(
            `${userMoveText}\n${formatBoard(chess, chessGame.userColor, chessGame.view, chessGame.playerName, captured)}\n\n${pickRandom(CHESS_CHECKMATE_LOSE_PHRASES)}`,
            { parse_mode: "Markdown" }
          );
          await clearChessGame(chatId, userId);
          return;
        }
        if (chess.isDraw() || chess.isStalemate()) {
          await ctx.reply(
            `${userMoveText}\n${formatBoard(chess, chessGame.userColor, chessGame.view, chessGame.playerName, captured)}\n\n${pickRandom(CHESS_DRAW_PHRASES)}`,
            { parse_mode: "Markdown" }
          );
          await clearChessGame(chatId, userId);
          return;
        }

        // Ходит бот
        const botMove = findBestMove(chess);
        chess.move(botMove);
        // Съеденную ходом бота фигуру пользователя — тоже в счёт.
        if (botMove.captured) captured[chessGame.userColor].push(botMove.captured);
        chessGames.set(chessMapKey(chatId, userId), {
          fen: chess.fen(),
          userColor: chessGame.userColor,
          view: chessGame.view,
          playerName: chessGame.playerName,
          captured,
          moveStyle: style,
        });
        saveChessGame(chatId, userId);
        const checkNote = chess.isCheck() ? " шах" : "";
        const botMoveText = formatChessMove(botMove, style);

        if (chess.isCheckmate()) {
          await ctx.reply(
            `Мой ход: ${botMoveText}${checkNote}\n${formatBoard(chess, chessGame.userColor, chessGame.view, chessGame.playerName, captured)}\n\n${pickRandom(CHESS_CHECKMATE_WIN_PHRASES)}`,
            { parse_mode: "Markdown" }
          );
          await clearChessGame(chatId, userId);
          return;
        }
        if (chess.isDraw() || chess.isStalemate()) {
          await ctx.reply(
            `Мой ход: ${botMoveText}${checkNote}\n${formatBoard(chess, chessGame.userColor, chessGame.view, chessGame.playerName, captured)}\n\n${pickRandom(CHESS_DRAW_PHRASES)}`,
            { parse_mode: "Markdown" }
          );
          await clearChessGame(chatId, userId);
          return;
        }

        await ctx.reply(
          `Мой ход: ${botMoveText}${checkNote}\n${formatBoard(chess, chessGame.userColor, chessGame.view, chessGame.playerName, captured)}`,
          { parse_mode: "Markdown" }
        );
        return;
      }
      // Ход не распознан. Если сообщение по форме — попытка хода
      // (нелегальный ход/опечатка), говорим об этом прямо, а не отдаём
      // в обычный чат (иначе модель выдумает шахматный комментарий, хотя
      // на доске ничего не изменилось — см. комментарий у looksLikeMoveAttempt).
      if (looksLikeMoveAttempt(rawText)) {
        await ctx.reply(
          "такой ход сделать нельзя (нелегален или опечатка). Глянь позицию — \"покажи доску\" — и попробуй другой, формат e2e4 или Nf3"
        );
        return;
      }
      // Иначе — проверяем, не команда ли это ("покажи доску", "новая партия", смена вида/сторон).
    }

    // Запрошен ли конкретный цвет — нужно и для рестарта ниже, и на
    // случай если запрос пришёл без ход-подобного текста вовсе.
    const requestedColor = parseRequestedUserColor(rawText);

    // Смена вида отображения доски — не трогает саму партию, только то,
    // как её рисуем дальше.
    if (CHESS_VIEW_UNICODE_REGEX.test(rawText) || CHESS_VIEW_ASCII_REGEX.test(rawText)) {
      const newView = CHESS_VIEW_UNICODE_REGEX.test(rawText) ? "unicode" : "ascii";
      if (newView !== chessGame.view) {
        chessGames.set(chessMapKey(chatId, userId), { ...chessGame, view: newView });
        saveChessGame(chatId, userId);
      }
      await ctx.reply(formatBoard(chess, chessGame.userColor, newView, chessGame.playerName, chessGame.captured), {
        parse_mode: "Markdown",
      });
      return;
    }

    if (CHESS_BOARD_REGEX.test(rawText)) {
      await ctx.reply(formatBoard(chess, chessGame.userColor, chessGame.view, chessGame.playerName, chessGame.captured), {
        parse_mode: "Markdown",
      });
      return;
    }

    if (CHESS_NEW_GAME_REGEX.test(rawText) || (requestedColor && requestedColor !== chessGame.userColor)) {
      // Либо явная фраза-рестарт ("новая партия"), либо попросили другой
      // цвет ("играй за белых", "давай ты за белых") — в обоих случаях
      // это фактически перезапуск партии с нужными цветами.
      const userColor = requestedColor || chessGame.userColor;
      const newChess = startChessGame(chatId, userId, userColor, chessGame.view, chessGame.playerName);
      const colorNote = userColor === "w" ? ", ты снова белыми — ходи" : ", ты чёрными — я белыми и хожу первым";
      await ctx.reply(`окей, погнали заново${colorNote}`);
      if (userColor === "b") {
        const botMove = findBestMove(newChess);
        newChess.move(botMove);
        const captured = { w: [], b: [] };
        if (botMove.captured) captured[userColor].push(botMove.captured);
        chessGames.set(chessMapKey(chatId, userId), {
          fen: newChess.fen(),
          userColor,
          view: chessGame.view,
          playerName: chessGame.playerName,
          captured,
          moveStyle: "san",
        });
        saveChessGame(chatId, userId);
        await ctx.reply(
          `Мой ход: ${botMove.san}\n${formatBoard(newChess, userColor, chessGame.view, chessGame.playerName, captured)}`,
          { parse_mode: "Markdown" }
        );
      }
      return;
    }

    // Дошли до конца шахматного блока — ни ход, ни команда партии не
    // распознаны. Если это похоже на приглашение в шашки — не молчим и не
    // отдаём в обычный чат (модель наврёт что-то невпопад про игру),
    // а прямо говорим, что сначала нужно закрыть текущую шахматную
    // партию: одновременно у одного пользователя может идти только одна
    // игра с ботом (шахматы либо шашки), см. пояснение у checkersGame ниже.
    if (CHECKERS_INTENT_REGEX.test(rawText)) {
      await ctx.reply(
        "у нас же ещё не доиграна шахматная партия — доиграй или сдайся (\"сдаюсь\"), тогда сыграем в шашки"
      );
      return;
    }
  } else if (CHESS_INTENT_REGEX.test(rawText)) {
    // Партии для этого пользователя нет, но упомянули шахматы — считаем
    // приглашением и стартуем именно ЕГО партию (chatId+userId), не трогая
    // партии других людей в этом же чате. По умолчанию пользователь играет
    // белыми и ходит первым, но можно сразу попросить чёрных ("сыграем в
    // шахматы за чёрных") — тогда бот берёт белые и ходит первым.
    const userColor = parseRequestedUserColor(rawText) || "w";
    const playerName = getDisplayName(chatId, ctx.from);
    const chess = startChessGame(chatId, userId, userColor, undefined, playerName);
    const view = chessGames.get(chessMapKey(chatId, userId)).view;
    if (userColor === "b") {
      await ctx.reply(pickRandom(CHESS_START_PHRASES_BLACK));
      const botMove = findBestMove(chess);
      chess.move(botMove);
      const captured = { w: [], b: [] };
      if (botMove.captured) captured[userColor].push(botMove.captured);
      chessGames.set(chessMapKey(chatId, userId), { fen: chess.fen(), userColor, view, playerName, captured, moveStyle: "san" });
      saveChessGame(chatId, userId);
      await ctx.reply(`Мой ход: ${botMove.san}\n${formatBoard(chess, userColor, view, playerName, captured)}`, {
        parse_mode: "Markdown",
      });
    } else {
      await ctx.reply(pickRandom(CHESS_START_PHRASES_WHITE));
    }
    return;
  } else if (checkersGame) {
    if (CHESS_RESIGN_REGEX.test(rawText)) {
      await clearCheckersGame(chatId, userId);
      await ctx.reply(pickRandom(CHECKERS_RESIGN_PHRASES));
      return;
    }

    // Ход проверяем ДО команд "покажи доску"/"новая партия" — та же логика,
    // что и в шахматном блоке выше (см. подробный комментарий там).
    if (checkersGame.turn === checkersGame.userColor) {
      const move = tryApplyCheckersMove(checkersGame.board, checkersGame.userColor, rawText);
      if (move) {
        // Съеденные ходом пользователя шашки — до применения хода, доска
        // ещё содержит съедаемые фигуры (см. collectCheckersCaptures).
        const prevCaptured = checkersGame.captured || { w: [], b: [] };
        const captured = { w: [...prevCaptured.w], b: [...prevCaptured.b] };
        for (const c of collectCheckersCaptures(checkersGame.board, move)) {
          captured[c.color].push(c.king ? "king" : "man");
        }

        let board = applyCheckersMove(checkersGame.board, move);
        const opponentColor = checkersGame.userColor === "w" ? "b" : "w";
        const moveNote = move.jumps ? move.jumps.map((j) => rcToSquare(j.toR, j.toC)).join(":") : rcToSquare(move.toR, move.toC);

        const userWinner = checkCheckersWinner(board, opponentColor);
        checkersGames.set(checkersMapKey(chatId, userId), { ...checkersGame, board, turn: opponentColor, captured });
        saveCheckersGame(chatId, userId);

        if (userWinner) {
          await ctx.reply(
            `${moveNote}\n${formatCheckersBoard(board, checkersGame.userColor, checkersGame.view, checkersGame.playerName, captured)}\n\n${pickRandom(CHECKERS_LOSE_PHRASES)}`,
            { parse_mode: "Markdown" }
          );
          await clearCheckersGame(chatId, userId);
          return;
        }

        // Ходит бот
        const botMove = findBestCheckersMove(board, opponentColor);
        for (const c of collectCheckersCaptures(board, botMove)) {
          captured[c.color].push(c.king ? "king" : "man");
        }
        board = applyCheckersMove(board, botMove);
        const botMoveNote = botMove.jumps
          ? botMove.jumps.map((j) => rcToSquare(j.toR, j.toC)).join(":")
          : rcToSquare(botMove.toR, botMove.toC);

        const botWinner = checkCheckersWinner(board, checkersGame.userColor);
        checkersGames.set(checkersMapKey(chatId, userId), { ...checkersGame, board, turn: checkersGame.userColor, captured });
        saveCheckersGame(chatId, userId);

        if (botWinner) {
          await ctx.reply(
            `Мой ход: ${botMoveNote}\n${formatCheckersBoard(board, checkersGame.userColor, checkersGame.view, checkersGame.playerName, captured)}\n\n${pickRandom(CHECKERS_WIN_PHRASES)}`,
            { parse_mode: "Markdown" }
          );
          await clearCheckersGame(chatId, userId);
          return;
        }

        await ctx.reply(
          `Мой ход: ${botMoveNote}\n${formatCheckersBoard(board, checkersGame.userColor, checkersGame.view, checkersGame.playerName, captured)}`,
          { parse_mode: "Markdown" }
        );
        return;
      }
      if (looksLikeCheckersMoveAttempt(rawText)) {
        await ctx.reply(
          "такой ход сделать нельзя (нелегален, или есть обязательное взятие, или опечатка). Глянь позицию — \"покажи доску\" — и попробуй другой, формат b6-c5 или взятие b6:d4"
        );
        return;
      }
    }

    const requestedColor = parseRequestedUserColor(rawText);

    if (CHESS_VIEW_UNICODE_REGEX.test(rawText) || CHESS_VIEW_ASCII_REGEX.test(rawText)) {
      const newView = CHESS_VIEW_UNICODE_REGEX.test(rawText) ? "unicode" : "ascii";
      if (newView !== checkersGame.view) {
        checkersGames.set(checkersMapKey(chatId, userId), { ...checkersGame, view: newView });
        saveCheckersGame(chatId, userId);
      }
      await ctx.reply(
        formatCheckersBoard(checkersGame.board, checkersGame.userColor, newView, checkersGame.playerName, checkersGame.captured),
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (CHESS_BOARD_REGEX.test(rawText)) {
      await ctx.reply(
        formatCheckersBoard(checkersGame.board, checkersGame.userColor, checkersGame.view, checkersGame.playerName, checkersGame.captured),
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (CHESS_NEW_GAME_REGEX.test(rawText) || (requestedColor && requestedColor !== checkersGame.userColor)) {
      const userColor = requestedColor || checkersGame.userColor;
      const newState = startCheckersGame(chatId, userId, userColor, checkersGame.view, checkersGame.playerName);
      const colorNote = userColor === "w" ? ", ты снова белыми — ходи" : ", ты чёрными — я белыми и хожу первым";
      await ctx.reply(`окей, погнали заново${colorNote}`);
      if (userColor === "b") {
        const captured = { w: [], b: [] };
        const botMove = findBestCheckersMove(newState.board, "w");
        for (const c of collectCheckersCaptures(newState.board, botMove)) {
          captured[c.color].push(c.king ? "king" : "man");
        }
        const board = applyCheckersMove(newState.board, botMove);
        const botMoveNote = botMove.jumps
          ? botMove.jumps.map((j) => rcToSquare(j.toR, j.toC)).join(":")
          : rcToSquare(botMove.toR, botMove.toC);
        checkersGames.set(checkersMapKey(chatId, userId), { ...newState, board, turn: "b", captured });
        saveCheckersGame(chatId, userId);
        await ctx.reply(
          `Мой ход: ${botMoveNote}\n${formatCheckersBoard(board, userColor, checkersGame.view, checkersGame.playerName, captured)}`,
          { parse_mode: "Markdown" }
        );
      }
      return;
    }

    // Аналогично шахматному блоку выше — если это похоже на приглашение в
    // шахматы, а не в шашки, явно говорим, что сначала нужно закрыть
    // текущую шашечную партию.
    if (CHESS_INTENT_REGEX.test(rawText)) {
      await ctx.reply(
        "у нас же ещё не доиграна партия в шашки — доиграй или сдайся (\"сдаюсь\"), тогда сыграем в шахматы"
      );
      return;
    }
  } else if (CHECKERS_INTENT_REGEX.test(rawText)) {
    // Партии нет, но упомянули шашки — считаем приглашением, та же логика,
    // что и у шахматного CHESS_INTENT_REGEX выше.
    const userColor = parseRequestedUserColor(rawText) || "w";
    const playerName = getDisplayName(chatId, ctx.from);
    const state = startCheckersGame(chatId, userId, userColor, undefined, playerName);
    if (userColor === "b") {
      await ctx.reply(pickRandom(CHECKERS_START_PHRASES_BLACK));
      const botMove = findBestCheckersMove(state.board, "w");
      const captured = { w: [], b: [] };
      for (const c of collectCheckersCaptures(state.board, botMove)) {
        captured[c.color].push(c.king ? "king" : "man");
      }
      const board = applyCheckersMove(state.board, botMove);
      const botMoveNote = botMove.jumps
        ? botMove.jumps.map((j) => rcToSquare(j.toR, j.toC)).join(":")
        : rcToSquare(botMove.toR, botMove.toC);
      checkersGames.set(checkersMapKey(chatId, userId), { ...state, board, turn: "b", captured });
      saveCheckersGame(chatId, userId);
      await ctx.reply(`Мой ход: ${botMoveNote}\n${formatCheckersBoard(board, userColor, state.view, playerName, captured)}`, {
        parse_mode: "Markdown",
      });
    } else {
      await ctx.reply(pickRandom(CHECKERS_START_PHRASES_WHITE));
    }
    return;
  }

  // Дошли сюда — значит ни шахматной, ни шашечной партии с этим
  // пользователем нет (иначе выше случился бы return), и сообщение не
  // похоже на приглашение начать игру. Если при этом оно похоже на команду
  // "покажи доску" — отвечаем явно, а не отдаём в обычный LLM-чат: модели
  // не с чем сверяться (никакой партии и её позиции у неё нет), и ответ
  // получится выдуманным и вводящим в заблуждение.
  if (CHESS_BOARD_REGEX.test(rawText)) {
    await ctx.reply('нет с тобой партий — ни шахматной, ни шашечной. Начать: просто напиши "шахматы" или "шашки"');
    return;
  }

  // Пол уже определён выше (до блока с banter-триггерами) — тут просто
  // добавляем метку для модели, если он известен. См. пояснение метки
  // в SYSTEM_PROMPT.
  if (gender) {
    userText = `[пол собеседника: ${gender === "m" ? "мужской" : "женский"}] ${userText}`;
  }

  try {
    // Явно прокидываем message_thread_id (для групп с темами/топиками) —
    // без этого "печатает" иногда не показывается в конкретной теме,
    // даже если сам запрос уходит в общий чат.
    await ctx.replyWithChatAction("typing", {
      message_thread_id: ctx.message.message_thread_id,
    });

    // Groq отвечает быстро, так что подтягиваем ответ параллельно с "печатает..."
    const replyPromise = askLLM(chatId, userText);

    const { text: reply, stickerKey } = await replyPromise;

    // держим typing включенным нужное время, чтобы не было мгновенного ответа
    await new Promise((r) => setTimeout(r, typingDelayMs(reply.length)));

    // Если явная фраза уже вызвала стикер по regex выше — не дублируем
    // ещё одним стикером от тега модели на то же сообщение.
    const stickerId = !regexStickerFired && stickerKey && pickSticker(stickerKey);

    if (stickerId) {
      // Стикер реально есть чем отправить — шлём ТОЛЬКО его, без текста.
      // Текст модели в этом случае был просто реакцией ("спасибо" и т.п.),
      // дублировать её текстом не нужно. В историю (см. askLLM) уже
      // положен полный текст с вырезанным тегом — бот всё равно будет
      // помнить, что "ответил", даже если пользователю ушёл только стикер.
      await ctx.replyWithSticker(stickerId, {
        reply_parameters: isGroup ? { message_id: ctx.message.message_id } : undefined,
        message_thread_id: ctx.message.message_thread_id,
      });
    } else if (isGroup) {
      await ctx.reply(reply, {
        reply_parameters: { message_id: ctx.message.message_id },
        message_thread_id: ctx.message.message_thread_id,
      });
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

// ==== Регистрация команд в Telegram (чтобы появлялись в автоподсказке "/") ====
async function registerCommands() {
  await bot.api.setMyCommands([
    { command: "start", description: "начать (сброс памяти)" },
    { command: "reset", description: "очистить историю переписки" },
    { command: "alias", description: "задать имя человеку вместо ника" },
    { command: "unalias", description: "убрать заданное имя" },
    { command: "aliases", description: "показать список алиасов" },
    { command: "gender", description: "посмотреть/задать пол (свой или реплаем)" },
    { command: "model", description: "выбрать модель / посмотреть текущую" },
    { command: "krokodil", description: "сыграть в крокодил (объясни слово)" },
    { command: "krokodil_reset", description: "сбросить зависший раунд крокодила" },
  ]);
  console.log("Команды зарегистрированы в Telegram");
}

// ==== Запуск long polling ====
registerCommands().catch((err) =>
  console.error("Не удалось зарегистрировать команды:", err)
);

// Перед стартом на всякий случай сбрасываем возможный "зависший" вебхук
// и висящие апдейты — помогает от 409 Conflict при передеплое, когда
// старый инстанс на Render ещё не до конца отключился от getUpdates.
async function startBot() {
  await Promise.all([loadPersistedState(), loadKrokodilDictionary()]);

  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
  } catch (err) {
    console.error("Не удалось сбросить вебхук перед стартом:", err);
  }

  // onStart просто подтверждает успешный запуск; сама ошибка 409, если
  // всё-таки возникнет во время работы, ловится ниже через .catch —
  // без него необработанный reject валит процесс с голым стектрейсом.
  bot.start({
    onStart: () => console.log("Бот запущен (long polling)"),
  }).catch((err) => {
    console.error("Бот остановился с ошибкой:", err);
    // Даём Render перезапустить процесс начисто, а не висеть в непонятном состоянии
    process.exit(1);
  });
}

startBot();

// Корректно останавливаем поллинг при рестарте/остановке контейнера на Render,
// чтобы старый инстанс не оставался "подвешенным" и не создавал 409 у нового
process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());
