// ==== Натальная карта / гороскопы (астрология) ====
//
// Этот модуль отвечает ТОЛЬКО за расчёты: парсинг даты рождения из текста
// команды, построение натальной карты и текущих транзитов через библиотеку
// circular-natal-horoscope-js (чистая математика/астрономия — реальные
// положения планет на заданный момент и место, без сети), поиск аспектов
// и форматирование всего этого в компактный русскоязычный текстовый блок.
//
// Сам LLM-вызов (с фолбэком по TARGETS, характером Жени и т.п.) остаётся в
// index.js — там уже есть SYSTEM_PROMPT/callTarget/computeTargetOrder,
// дублировать их тут незачем. index.js берёт готовый контекст-блок отсюда
// (buildAstroContext) и подмешивает его в system-промпт LLM с задачей
// "напиши по этим данным гороскоп/разбор характера, ничего не выдумывая
// сверх них".
//
// Геокодинг города НЕ делает этот модуль — index.js уже умеет резолвить
// город в координаты через geocodeCity() (Open-Meteo), это переиспользуется
// напрямую, чтобы не тащить второй геокодер и не путать пользователя двумя
// разными базами городов для погоды и для натальной карты.

import pkg from "circular-natal-horoscope-js";
const { Origin, Horoscope } = pkg;

// ==== Русские словари ====

const PLANET_RU = {
  sun: "Солнце",
  moon: "Луна",
  mercury: "Меркурий",
  venus: "Венера",
  mars: "Марс",
  jupiter: "Юпитер",
  saturn: "Сатурн",
  uranus: "Уран",
  neptune: "Нептун",
  pluto: "Плутон",
  chiron: "Хирон",
  northnode: "Северный узел",
  ascendant: "Асцендент",
  midheaven: "Середина неба (MC)",
};

// Порядок точек в выводе — сначала личные/социальные планеты (наиболее
// "читаемые" для человека без астрологического бэкграунда), потом
// медленные/фоновые, потом углы карты.
const POINT_ORDER = [
  "sun", "moon", "mercury", "venus", "mars",
  "jupiter", "saturn", "uranus", "neptune", "pluto",
  "chiron", "northnode", "ascendant", "midheaven",
];

const SIGN_RU = {
  aries: "Овен", taurus: "Телец", gemini: "Близнецы", cancer: "Рак",
  leo: "Лев", virgo: "Дева", libra: "Весы", scorpio: "Скорпион",
  sagittarius: "Стрелец", capricorn: "Козерог", aquarius: "Водолей", pisces: "Рыбы",
};

const HOUSE_ORDINAL_RU = {
  1: "1-й", 2: "2-й", 3: "3-й", 4: "4-й", 5: "5-й", 6: "6-й",
  7: "7-й", 8: "8-й", 9: "9-й", 10: "10-й", 11: "11-й", 12: "12-й",
};

const ASPECT_RU = {
  conjunction: "соединение",
  opposition: "оппозиция",
  trine: "трин",
  square: "квадрат",
  sextile: "секстиль",
};

// ==== Парсинг команды /natal ====
//
// Формат: "ДД.ММ.ГГГГ[ ЧЧ:ММ] Город[, страна]". Время не обязательно —
// без него часть карты (Асцендент/MC/дома/Луна с точностью до часа) не
// строится, потому что реально зависит от точного часа рождения, а не
// только от даты (см. hasTime ниже и HOUSE-зависимую логику в index.js).
const BIRTH_ARGS_REGEX =
  /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})(?:\s+(\d{1,2}):(\d{2}))?\s+(.+)$/;

function isValidCalendarDate(day, month, year) {
  if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) return false;
  if (month < 1 || month > 12) return false;
  if (year < 1900 || year > new Date().getFullYear()) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  // new Date переносит "31 февраля" на март — сверяем, что после сборки
  // компоненты не разъехались, иначе это была невалидная дата.
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

// Возвращает { day, month, year, hour, minute, hasTime, cityRaw } либо
// null, если текст вообще не похож на "дата [время] город". Смысловая
// валидация (существует ли такая дата, существует ли час 0-23) — тоже
// тут, чтобы index.js мог сразу ответить пользователю понятной ошибкой,
// не долетая до геокодинга.
export function parseBirthDateArgs(argsText) {
  const m = BIRTH_ARGS_REGEX.exec((argsText || "").trim());
  if (!m) return null;

  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const hasTime = m[4] !== undefined;
  const hour = hasTime ? Number(m[4]) : 12; // без времени считаем от полудня — нейтральная точка суток
  const minute = hasTime ? Number(m[5]) : 0;
  const cityRaw = m[6].trim();

  if (!isValidCalendarDate(day, month, year)) return null;
  if (hasTime && (hour > 23 || minute > 59)) return null;
  if (!cityRaw) return null;

  return { day, month, year, hour, minute, hasTime, cityRaw };
}

// ==== Распознавание запроса гороскопа в обычном тексте ====
//
// Анкеровано к началу сообщения (после stripBotAddressing на стороне
// index.js) — та же философия, что у MOVIE_TRIGGER_WORDS/парсинга погоды:
// точный, предсказуемый формат фразы, который можно честно подсказать
// пользователю в skills.js, а не гадательный fuzzy-match.
// ВАЖНО: \b в JS-регэкспах основан на \w == [A-Za-z0-9_] — кириллица в это
// множество не входит, так что \b после русского слова НЕ считается
// границей (по обе стороны "не-\w") и просто никогда не матчится. Вместо
// него — negative lookahead на русскую букву сразу после нужного слова
// (тот же приём, что уже используется в MOVIE_TRIGGER_WORDS выше по коду
// index.js) — так "гороскоп" не зацепит "гороскопчик" или "гороскопы", но
// корректно матчится сам по себе.
const NOT_CYRILLIC_LETTER = "(?![а-яёА-ЯЁ])";

// ==== Тематический гороскоп (здоровье / любовь / карьера-деньги) ====
//
// Тема — необязательный фильтр ПОВЕРХ периода: "гороскоп на любовь",
// "гороскоп по здоровью", "гороскоп на завтра по карьере". Сами данные
// (транзиты/натальные аспекты) не меняются — тема лишь просит LLM
// сфокусироваться на нужной сфере (см. THEME_FOCUS_INSTRUCTIONS в
// index.js). Важная оговорка: положения планет — реальная астрономия, а
// вот СВЯЗЬ конкретной планеты/дома с "здоровьем" или "любовью" — это
// астрологическая традиция, а не измеримый факт (в отличие от самих
// координат планет). LLM-промпт в index.js об этом честно предупреждает,
// особенно для темы "здоровье" — там же явный запрет на мед. советы.
const THEME_PATTERNS = [
  { key: "health", re: /здоровь/i },
  { key: "love", re: /любв|любов|отношени|личн[а-яёА-ЯЁ]*\s+жизн/i },
  { key: "career", re: /карьер|работ|финанс|деньг|денеж/i },
];

// "жизнь" как ПЕРИОД ("гороскоп на жизнь" = долгосрочный разбор без
// транзитов) не должна путаться с ТЕМОЙ "личная жизнь" (это про любовь,
// а период там обычный — "на сегодня") — отсюда негативный lookbehind:
// не считаем это периодом "жизнь", если "жизн" идёт сразу после "личн...".
const LIFE_PERIOD_RE = /(?<!личн[а-яёА-ЯЁ]*\s)жизн/i;

// Если в тексте совпало сразу несколько тем — берём ту, что встретилась
// раньше по тексту (а не первую в THEME_PATTERNS), это интуитивнее.
function detectTheme(rest) {
  let theme = null;
  let bestIndex = Infinity;
  for (const tp of THEME_PATTERNS) {
    const match = tp.re.exec(rest);
    if (match && match.index < bestIndex) {
      theme = tp.key;
      bestIndex = match.index;
    }
  }
  return theme;
}

export function parseHoroscopeQueryIntent(text) {
  const t = (text || "").trim();
  if (!t) return null;

  // Раньше здесь ловился только один заранее известный период-словом; теперь
  // забираем весь кириллический "хвост" после "гороскоп" одним куском и
  // ищем в нём и период, и тему — так работают любые сочетания вида
  // "гороскоп на завтра по любви" независимо от порядка слов.
  const horoscopeRe = new RegExp(`^гороскоп${NOT_CYRILLIC_LETTER}([\\sа-яёА-ЯЁ]*)`, "i");
  let m = horoscopeRe.exec(t);
  if (m) {
    const rest = (m[1] || "").toLowerCase();
    let period = "today";
    if (/завтра/.test(rest)) period = "tomorrow";
    else if (/недел/.test(rest)) period = "week";
    else if (LIFE_PERIOD_RE.test(rest)) period = "life";
    const theme = detectTheme(rest);
    return { type: "horoscope", period, theme };
  }

  // [а-яёА-ЯЁ]* вместо \w* — та же причина, что и с \b выше: \w не видит
  // кириллицу, так что \w* после русской основы слова не съедал бы
  // падежные окончания вообще (сравнивалось с пустой строкой).
  if (/^натальн[а-яёА-ЯЁ]*\s+карт[а-яёА-ЯЁ]*/i.test(t)) return { type: "chart" };
  if (new RegExp(`^(мои\\s+|мой\\s+)?характер${NOT_CYRILLIC_LETTER}`, "i").test(t)) {
    return { type: "chart" };
  }
  // "мои" тут не опционален (в отличие от "характер" выше) — голое слово
  // "аспекты" слишком частое в обычной речи (аспекты проекта, аспекты
  // задачи и т.п.), а не характерный для этого бота единственный в своём
  // роде триггер вроде "крокодил"/"шахматы" — без "мои" ложных
  // срабатываний было бы заметно больше.
  if (/^мои\s+аспект[а-яёА-ЯЁ]*/i.test(t)) return { type: "aspects" };

  return null;
}

// ==== Построение карты ====

// month у Origin — 0-индексированный (январь=0), в отличие от того, как
// его пишет человек в команде (январь=1) — конвертация именно тут, чтобы
// не разбросать "-1" по всему index.js.
function buildOrigin({ year, month, day, hour, minute, latitude, longitude }) {
  return new Origin({
    year, month: month - 1, date: day, hour, minute,
    latitude, longitude,
  });
}

// Общая конфигурация Horoscope для натальной карты и для транзитных
// "снимков" — специально одна и та же (houseSystem/zodiac/aspectPoints),
// чтобы дома и знаки считались одинаково и их можно было сравнивать.
// language всегда "en" — у библиотеки нет русской локали (падает на
// custom-orbs таблице), переводим сами через словари выше.
function buildHoroscope(origin) {
  return new Horoscope({
    origin,
    houseSystem: "placidus",
    zodiac: "tropical",
    aspectPoints: ["bodies", "points", "angles"],
    aspectWithPoints: ["bodies", "points", "angles"],
    aspectTypes: ["major"],
    language: "en",
  });
}

export function buildNatalHoroscope(profile) {
  return buildHoroscope(buildOrigin(profile));
}

// ==== Извлечение точек карты в удобном/переводимом виде ====

function extractPoints(horoscope) {
  const all = {
    ...horoscope.CelestialBodies,
    ...horoscope.CelestialPoints,
    ascendant: horoscope.Angles.ascendant,
    midheaven: horoscope.Angles.midheaven,
  };

  const points = {};
  for (const key of POINT_ORDER) {
    const raw = all[key];
    if (!raw) continue;
    points[key] = {
      key,
      ru: PLANET_RU[key] || raw.label,
      signKey: raw.Sign?.key,
      signRu: raw.Sign?.key ? SIGN_RU[raw.Sign.key] || raw.Sign.label : null,
      houseId: raw.House?.id ?? null,
      degrees: raw.ChartPosition?.Ecliptic?.DecimalDegrees ?? null,
    };
  }
  return points;
}

function cuspDegrees(horoscope) {
  return horoscope.Houses.map((h) => h.ChartPosition.StartPosition.Ecliptic.DecimalDegrees);
}

// Куспиды не гарантированно монотонны (переход через 360°→0°) — идём по
// кругу и ищем дугу, в которую попадает градус планеты.
function houseForDegree(cusps, degree) {
  if (degree == null) return null;
  for (let i = 0; i < 12; i++) {
    const start = cusps[i];
    const end = cusps[(i + 1) % 12];
    const inArc = start <= end ? degree >= start && degree < end : degree >= start || degree < end;
    if (inArc) return i + 1;
  }
  return null;
}

// ==== Натальные аспекты (между собственными точками карты) ====

// sirius (неподвижная звезда) сюда не нужен — библиотека всегда считает
// её вместе с "bodies", но для гороскопа рядового пользователя это лишний
// астрологический нюанс, который только раздувает список без пользы;
// вырезаем откуда угодно, где она попадается.
function natalAspectsList(horoscope, { limit = 14 } = {}) {
  return horoscope.Aspects.all
    .filter((a) => a.point1Key !== "sirius" && a.point2Key !== "sirius")
    .sort((a, b) => a.orb - b.orb)
    .slice(0, limit);
}

function formatAspectLine(a, ruName = (key, label) => PLANET_RU[key] || label) {
  const p1 = ruName(a.point1Key, a.point1Label);
  const p2 = ruName(a.point2Key, a.point2Label);
  const asp = ASPECT_RU[a.aspectKey] || a.label;
  return `${p1} — ${p2}: ${asp} (орб ${a.orb.toFixed(1)}°)`;
}

// ==== Текущее время в таймзоне места рождения ====
//
// Транзиты (положения планет "сейчас") должны считаться от местного
// времени в точке рождения (та же логика, что Origin ожидает для самой
// натальной карты) — Intl.DateTimeFormat с timeZone делает это без
// дополнительных npm-зависимостей.
function localPartsInTZ(date, tz) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || "UTC",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: parts.hour === "24" ? 0 : Number(parts.hour),
    minute: Number(parts.minute),
  };
}

// dayOffset=0 — "сейчас", положительные значения — снимок на будущий день.
// noon=true — фиксирует время на 12:00 по местному времени (для "завтра"/
// "неделя", где важен сам день, а не точная минута) вместо текущего часа.
function transitSnapshotParts(tz, dayOffset, { noon = false } = {}) {
  const base = new Date(Date.now() + dayOffset * 24 * 60 * 60 * 1000);
  const p = localPartsInTZ(base, tz);
  if (noon) {
    p.hour = 12;
    p.minute = 0;
  }
  return p;
}

// ==== Транзитные аспекты (текущие планеты -> натальные точки) ====

// Только мажорные аспекты и заметно более узкий орб, чем у натальных (там
// орб библиотеки до 8°) — иначе список "что происходит сегодня" тонет в
// слабых, ничего не значащих совпадениях.
const TRANSIT_ASPECT_DEFS = [
  { key: "conjunction", angle: 0 },
  { key: "sextile", angle: 60 },
  { key: "square", angle: 90 },
  { key: "trine", angle: 120 },
  { key: "opposition", angle: 180 },
];
const TRANSIT_ORB = 4;

// Транзитные точки, которые реально имеет смысл смотреть день-в-день —
// сверхмедленные (Уран/Нептун/Плутон) за сутки-неделю почти не двигаются
// относительно натальной карты, включать их в "гороскоп на сегодня" почти
// всегда шум (аспект либо уже был вчера, либо будет ещё месяц).
const DAILY_TRANSIT_KEYS = ["moon", "sun", "mercury", "venus", "mars", "jupiter", "saturn"];

function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function findTransitAspects(transitPoints, natalPoints, keys = DAILY_TRANSIT_KEYS) {
  const out = [];
  for (const tKey of keys) {
    const t = transitPoints[tKey];
    if (!t || t.degrees == null) continue;
    for (const nKey of POINT_ORDER) {
      const n = natalPoints[nKey];
      if (!n || n.degrees == null) continue;
      const diff = angleDiff(t.degrees, n.degrees);
      for (const def of TRANSIT_ASPECT_DEFS) {
        const orb = Math.abs(diff - def.angle);
        if (orb <= TRANSIT_ORB) {
          out.push({ transitKey: tKey, natalKey: nKey, aspectKey: def.key, orb });
          break;
        }
      }
    }
  }
  return out.sort((a, b) => a.orb - b.orb);
}

function formatTransitAspectLine(a) {
  const tName = PLANET_RU[a.transitKey];
  const nName = PLANET_RU[a.natalKey];
  const asp = ASPECT_RU[a.aspectKey];
  return `транзитн. ${tName} — натальн. ${nName}: ${asp} (орб ${a.orb.toFixed(1)}°)`;
}

// ==== Форматирование блока положений планет ====

function formatPointsBlock(points, { withHouses }) {
  return POINT_ORDER.filter((k) => points[k])
    .map((k) => {
      const p = points[k];
      const housePart = withHouses && p.houseId ? `, ${HOUSE_ORDINAL_RU[p.houseId]} дом` : "";
      return `${p.ru} — ${p.signRu}${housePart}`;
    })
    .join("\n");
}

// ==== Публичные функции высокого уровня, которые вызывает index.js ====

// Собирает всё, что нужно для расчётов, один раз — index.js кэширует
// результат на время обработки одного запроса (натальная карта не меняется,
// пересчитывать её на каждый чих незачем).
export function computeNatalProfile(profile) {
  const horoscope = buildNatalHoroscope(profile);
  const points = extractPoints(horoscope);
  const cusps = profile.hasTime ? cuspDegrees(horoscope) : null;
  return { horoscope, points, cusps, profile };
}

// "натальная карта" / "мой характер" — статичный разбор без транзитов:
// расположения планет по знакам (+ домам, если известно время рождения) и
// сильнейшие натальные аспекты.
export function buildChartContext(natal) {
  const lines = [];
  lines.push("Положения планет в натальной карте:");
  lines.push(formatPointsBlock(natal.points, { withHouses: !!natal.profile.hasTime }));
  if (!natal.profile.hasTime) {
    lines.push(
      "(точное время рождения неизвестно — дома, Асцендент и MC не считаем; " +
        "показаны только знаки, это Солнце/Луна/планеты без привязки к дому)"
    );
  }
  const aspects = natalAspectsList(natal.horoscope);
  if (aspects.length) {
    lines.push("\nОсновные натальные аспекты (от самых точных к более широким):");
    lines.push(aspects.map((a) => formatAspectLine(a)).join("\n"));
  }
  return lines.join("\n");
}

// "мои аспекты" — то же самое, но только список аспектов, без общего блока
// положений (человек уже спросил конкретно про углы между планетами).
export function buildAspectsOnlyContext(natal) {
  const aspects = natalAspectsList(natal.horoscope, { limit: 20 });
  if (!aspects.length) return "У натальной карты не нашлось значимых мажорных аспектов.";
  return "Натальные аспекты:\n" + aspects.map((a) => formatAspectLine(a)).join("\n");
}

// "гороскоп на сегодня"/"на завтра": один транзитный снимок. dayOffset=0 —
// сейчас (использует текущий час, а не полдень — для "сегодня" это честнее,
// Луна за день реально успевает смениться); dayOffset=1 — "завтра", берём
// полдень как нейтральную точку дня.
export function buildDayHoroscopeContext(natal, dayOffset) {
  const tz = natal.profile.timezone || "UTC";
  const parts = transitSnapshotParts(tz, dayOffset, { noon: dayOffset > 0 });
  const transitHoroscope = buildHoroscope(
    buildOrigin({
      year: parts.year, month: parts.month, day: parts.day,
      hour: parts.hour, minute: parts.minute,
      latitude: natal.profile.latitude, longitude: natal.profile.longitude,
    })
  );
  const transitPoints = extractPoints(transitHoroscope);
  const aspects = findTransitAspects(transitPoints, natal.points);

  const lines = [];
  lines.push("Текущие положения планет (транзиты) на этот момент:");
  lines.push(
    DAILY_TRANSIT_KEYS.map((k) => `${PLANET_RU[k]} — ${transitPoints[k].signRu}`).join("\n")
  );
  if (aspects.length) {
    lines.push("\nАктивные транзитные аспекты к натальной карте (самые точные — важнее):");
    lines.push(aspects.slice(0, 8).map(formatTransitAspectLine).join("\n"));
  } else {
    lines.push("\nЗначимых транзитных аспектов к натальной карте на этот момент нет — фоново спокойный период.");
  }
  return lines.join("\n");
}

// "гороскоп на неделю" — два снимка (сегодня и через 7 дней), чтобы модель
// могла описать не статичную точку, а какое-то движение/динамику недели, не
// считая честный день-за-днём разбор (это было бы 7 запросов транзитов
// подряд ради одного сообщения в Telegram — избыточно).
export function buildWeekHoroscopeContext(natal) {
  const startBlock = buildDayHoroscopeContext(natal, 0);
  const endBlock = buildDayHoroscopeContext(natal, 7);
  return (
    "Транзиты на начало недели (сегодня):\n" + startBlock +
    "\n\nТранзиты на конец недели (через 7 дней):\n" + endBlock
  );
}

// "гороскоп на жизнь" — намеренно БЕЗ транзитов: в астрологической традиции
// долгосрочные темы/предназначение читаются по самой натальной карте
// (сильные аспекты, куда попадают личные планеты), а не по положению
// планет "прямо сейчас" — так что переиспользуем тот же блок, что и для
// характера, просто с другой задачей для LLM (см. TASK_INSTRUCTIONS.life
// в index.js).
export function buildLifeContext(natal) {
  return buildChartContext(natal);
}

// Человекочитаемая подпись сохранённых данных рождения — для "/natal" без
// аргументов (показать, что уже сохранено) и для ошибок.
export function formatSavedProfileLabel(profile, locationLabel) {
  const datePart = `${String(profile.day).padStart(2, "0")}.${String(profile.month).padStart(2, "0")}.${profile.year}`;
  const timePart = profile.hasTime
    ? `, ${String(profile.hour).padStart(2, "0")}:${String(profile.minute).padStart(2, "0")}`
    : " (время неизвестно)";
  return `${datePart}${timePart}, ${locationLabel}`;
}

// ==== Заголовок гороскопа для чата ====
//
// В групповом чате несколько человек могут спрашивать гороскоп подряд, и
// без подписи непонятно, кому какой ответ адресован и на какой именно день
// он посчитан. formatHoroscopeDateLabel строит короткую шапку вида
// "гороскоп на завтра, вторник, 18 августа" — index.js добавляет к ней имя
// адресата и кладёт перед текстом гороскопа (а также отвечает реплаем на
// исходное сообщение — это уже отдельная механика в index.js).
const WEEKDAY_RU = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const MONTH_RU_GENITIVE = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

function formatRuDate(parts) {
  const weekday = WEEKDAY_RU[new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()];
  return `${weekday}, ${parts.day} ${MONTH_RU_GENITIVE[parts.month - 1]}`;
}

// taskType — то же значение, что index.js передаёт в askAstroLLM:
// "chart" | "aspects" | "today" | "tomorrow" | "week" | "life".
// theme — необязательно: "health" | "love" | "career" | null.
const THEME_LABEL_RU = { health: "здоровье", love: "любовь", career: "карьера и деньги" };

export function formatHoroscopeDateLabel(natal, taskType, theme = null) {
  const tz = natal.profile.timezone || "UTC";
  const themeSuffix = theme && THEME_LABEL_RU[theme] ? ` — ${THEME_LABEL_RU[theme]}` : "";
  if (taskType === "chart") return "натальная карта";
  if (taskType === "aspects") return "аспекты";
  if (taskType === "life") return `гороскоп на жизнь${themeSuffix}`;
  if (taskType === "week") {
    const start = transitSnapshotParts(tz, 0, { noon: true });
    const end = transitSnapshotParts(tz, 7, { noon: true });
    const startStr = start.month === end.month ? `${start.day}` : `${start.day} ${MONTH_RU_GENITIVE[start.month - 1]}`;
    return `гороскоп на неделю${themeSuffix}, ${startStr} — ${end.day} ${MONTH_RU_GENITIVE[end.month - 1]}`;
  }
  const dayOffset = taskType === "tomorrow" ? 1 : 0;
  const parts = transitSnapshotParts(tz, dayOffset, { noon: dayOffset > 0 });
  const label = taskType === "tomorrow" ? "гороскоп на завтра" : "гороскоп на сегодня";
  return `${label}${themeSuffix}, ${formatRuDate(parts)}`;
}
