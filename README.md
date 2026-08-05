# Разговорный Telegram-бот (grammy + Groq)

## Локальный запуск (проверить перед деплоем)

```bash
npm install
cp .env.example .env
# впиши BOT_TOKEN и GROQ_API_KEY в .env
npm start
```

## Деплой на Render

1. Залей этот проект в GitHub-репозиторий (без `.env` — он в `.gitignore`)
2. На Render: **New → Web Service** → подключи репозиторий
3. Настройки:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
4. **Environment → Add Environment Variable:**
   - `BOT_TOKEN` — токен от @BotFather
   - `GROQ_API_KEY` — ключ с console.groq.com
   - `GROQ_MODEL` — можно оставить по умолчанию (`llama-3.3-70b-versatile`)
5. Deploy. В логах должно появиться `Бот запущен (long polling)`

## Чтобы бот не засыпал (free tier спит через 15 мин простоя)

Зарегистрируйся на cron-job.org (бесплатно), создай задачу, которая раз в
10 минут дёргает GET-запрос на URL твоего Render-сервиса
(вида `https://твой-сервис.onrender.com/`).

## Как поменять манеру общения бота

Открой `index.js`, найди константу `SYSTEM_PROMPT` в начале файла —
это единственное место, которое нужно менять. Перепиши текст под новый
характер, закоммить и запушь — Render передеплоит автоматически.

## Команды бота

- `/start` — начать (сбрасывает память диалога)
- `/reset` — очистить историю переписки, если бот "путается" в контексте

## Модели Groq на выбор (переменная GROQ_MODEL)

- `llama-3.3-70b-versatile` — баланс ума и скорости (по умолчанию)
- `qwen/qwen3-32b` — альтернативный стиль ответов, тоже быстрый
