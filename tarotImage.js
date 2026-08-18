// ==== Коллаж расклада Таро (одна картинка на весь расклад) ====
//
// Отвечает только за рендер: берёт уже вытянутые карты (тот же формат
// { card, reversed }[], что возвращает drawCards/drawDailyCard в tarot.js)
// и подписи позиций из SPREADS[spreadType].positions, и собирает их в
// один PNG-буфер, который index.js отправляет одним сообщением
// (ctx.replyWithPhoto с подписью, вместо серии из фото + отдельного
// текста, как было раньше).
//
// Что получилось учесть:
//  - перевёрнутая карта реально показана перевёрнутой (rotate 180) —
//    раньше картинка карты всегда шла "прямой", даже если по данным
//    выпала перевёрнутая;
//  - у каждой карты на коллаже своя подпись позиции — тот же самый
//    текст, что уходит модели в buildTarotContext (SPREADS[...].positions),
//    так что подпись позиции больше не "плавает" от ответа к ответу;
//  - "Кельтский крест" собран в классической раскладке (крест + посох
//    справа), а не произвольной сеткой — карта 2 ("что противодействует")
//    положена поперёк карты 1, как и рисуют в бумажных раскладах.
//
// Если картинки конкретной карты нет в assets/tarot (см. README и
// tarot.js:cardImageFileName) — вместо неё рисуется декоративная
// заглушка с названием карты, а не пропуск/ошибка на весь коллаж.

import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";
import { cardImageFileName } from "./tarot.js";

const ASSETS_DIR = path.join(process.cwd(), "assets", "tarot");

// Размеры карты для раскладов в один ряд (карта дня / да-нет / три карты) —
// карт мало, можно себе позволить покрупнее.
const ROW_CARD_W = 200;
const ROW_CARD_H = 340;

// Кельтский крест — 4 колонки в ширину (3 колонки креста + колонка
// посоха), поэтому карты берём заметно мельче, иначе итоговое изображение
// выйдет неприлично широким для телефона.
const CELTIC_CARD_W = 132;
const CELTIC_CARD_H = 224;

const PAD = 14;
const BG_COLOR = "#181229";
const GOLD = "#c9a54e";
const LABEL_BG = "#f4ecd8";
const LABEL_POS_COLOR = "#7a6fa2";
const LABEL_TITLE_COLOR = "#2b2440";

function escXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function wrapText(text, maxCharsPerLine) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxCharsPerLine && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// Средняя ширина символа DejaVu Sans ~0.58 от кегля — эмпирически годится
// и для кириллицы. fontSize по умолчанию 11 — тот же, что у подписи
// позиции в labelBuffer.
function maxCharsForWidth(width, fontSize = 11) {
  return Math.max(6, Math.floor(width / (fontSize * 0.58)));
}

// Заглушка на случай отсутствующей картинки карты в assets/tarot/.
async function placeholderCardBuffer(nameRu, w, h) {
  const fontSize = 16;
  const lines = wrapText(nameRu, maxCharsForWidth(w - 20, fontSize));
  const lineH = 20;
  const startY = h / 2 - ((lines.length - 1) * lineH) / 2;
  const textSvg = lines
    .map(
      (l, i) =>
        `<text x="${w / 2}" y="${startY + i * lineH}" font-family="DejaVu Sans" font-size="${fontSize}" fill="#e9dcb5" text-anchor="middle">${escXml(l)}</text>`
    )
    .join("");
  const svg = `<svg width="${w}" height="${h}">
    <rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="10" fill="#2b2440" stroke="${GOLD}" stroke-width="2"/>
    <text x="${w / 2}" y="26" font-family="DejaVu Sans" font-size="11" fill="${GOLD}" text-anchor="middle">✦</text>
    ${textSvg}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function loadCardArt(card, reversed, w, h) {
  const filePath = path.join(ASSETS_DIR, cardImageFileName(card));
  let buf;
  try {
    const raw = await fs.readFile(filePath);
    buf = await sharp(raw).resize(w, h, { fit: "cover" }).png().toBuffer();
  } catch {
    // Нет ассета — рисуем заглушку с названием карты, не роняем весь коллаж.
    buf = await placeholderCardBuffer(card.nameRu, w, h);
  }
  if (reversed) {
    buf = await sharp(buf).rotate(180).png().toBuffer();
  }
  return buf;
}

// Название карты (+ "(перев.)") тоже может не влезать в одну строку
// (напр. "Рыцарь Жезлов (перев.)") — переносим максимум на 2 строки,
// уменьшая при необходимости шрифт, а не обрезаем текст молча.
const TITLE_MAX_LINES = 2;

// Подпись под картой: номер позиции (кружок), название позиции и
// название карты + ориентация — оба переносятся по словам на несколько
// строк. labelH — фиксированная высота, одинаковая для всех подписей в
// рамках одного коллажа (считается заранее по самой длинной подписи
// расклада), чтобы карты в ряд/сетку не "прыгали" по высоте.
async function labelBuffer(n, posLabel, cardTitle, width, labelH) {
  const maxChars = maxCharsForWidth(width - 12);
  const posLines = wrapText(posLabel, maxChars);
  const titleLines = wrapText(cardTitle, maxChars).slice(0, TITLE_MAX_LINES);
  const badgeR = 8;
  const parts = [
    `<rect width="${width}" height="${labelH}" fill="${LABEL_BG}" rx="6"/>`,
    `<circle cx="${badgeR + 5}" cy="${badgeR + 5}" r="${badgeR}" fill="${GOLD}"/>`,
    `<text x="${badgeR + 5}" y="${badgeR + 9}" font-family="DejaVu Sans" font-size="10" font-weight="bold" fill="${BG_COLOR}" text-anchor="middle">${n}</text>`,
  ];
  // Первая строка позиции начинается заметно ниже кружка с номером, чтобы
  // выносные элементы букв (у/р/ц и т.п. и просто верх заглавных) не
  // залезали под кружок, даже если строка короткая и центр близко к краю.
  let y = 32;
  for (const l of posLines) {
    parts.push(
      `<text x="${width / 2}" y="${y}" font-family="DejaVu Sans" font-size="11" fill="${LABEL_POS_COLOR}" text-anchor="middle">${escXml(l)}</text>`
    );
    y += 13;
  }
  y += 6;
  for (const l of titleLines) {
    parts.push(
      `<text x="${width / 2}" y="${y}" font-family="DejaVu Sans" font-size="12" font-weight="bold" fill="${LABEL_TITLE_COLOR}" text-anchor="middle">${escXml(l)}</text>`
    );
    y += 14;
  }
  const svg = `<svg width="${width}" height="${labelH}">${parts.join("")}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// Сколько строк займёт позиция и сколько — название карты, при данной
// ширине карты (используется, чтобы заранее посчитать одну общую labelH
// под все карты расклада — см. labelHeightFor ниже).
function estimateLabelLineCounts(posLabel, cardTitle, width) {
  const maxChars = maxCharsForWidth(width - 12);
  const posLines = wrapText(posLabel, maxChars).length;
  const titleLines = Math.min(TITLE_MAX_LINES, wrapText(cardTitle, maxChars).length);
  return { posLines, titleLines };
}

// Высота подписи (labelH), рассчитанная под самую длинную позицию +
// название карты из всего расклада — держит layout в labelBuffer в точном
// соответствии с раскладкой строк там (24 старт, 13px/строка позиции,
// 6px зазор, 14px/строка названия, 8px нижний отступ под спуски букв).
function labelHeightFor(items, width) {
  let maxPos = 1;
  let maxTitle = 1;
  for (const { posLabel, cardTitle } of items) {
    const { posLines, titleLines } = estimateLabelLineCounts(posLabel, cardTitle, width);
    maxPos = Math.max(maxPos, posLines);
    maxTitle = Math.max(maxTitle, titleLines);
  }
  return 32 + maxPos * 13 + 6 + maxTitle * 14 + 8;
}

// Собирает одну "карту с подписью" (тайл): картинка сверху, подпись снизу.
// extraRotate — доп. поворот ПОСЛЕ обычного (нужно только для карты 2 в
// кельтском кресте, которая кладётся поперёк карты 1).
async function buildTile(n, posLabel, card, reversed, cardW, cardH, labelH, extraRotate = 0) {
  let cardBuf = await loadCardArt(card, reversed, cardW, cardH);
  if (extraRotate) {
    cardBuf = await sharp(cardBuf).rotate(extraRotate).png().toBuffer();
  }
  const meta = await sharp(cardBuf).metadata();
  const boxW = Math.max(cardW, meta.width);
  const boxH = Math.max(cardH, meta.height);
  const centeredCard = await sharp({
    create: { width: boxW, height: boxH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: cardBuf, left: Math.round((boxW - meta.width) / 2), top: Math.round((boxH - meta.height) / 2) }])
    .png()
    .toBuffer();

  // Подпись всегда рисуется по "логической" ширине колонки (cardW), даже
  // если сама карта повёрнута и физически шире (карта 2 в кельтском
  // кресте) — иначе её подпись перекрывает подписи соседних карт. Просто
  // центрируем более узкую подпись под более широкой картой.
  const title = `${card.nameRu}${reversed ? " (перев.)" : ""}`;
  const label = await labelBuffer(n, posLabel, title, cardW, labelH);
  const labelLeft = Math.round((boxW - cardW) / 2);

  const tile = await sharp({
    create: { width: boxW, height: boxH + labelH + 4, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      { input: centeredCard, left: 0, top: 0 },
      { input: label, left: labelLeft, top: boxH + 4 },
    ])
    .png()
    .toBuffer();

  return { buf: tile, w: boxW, h: boxH + labelH + 4, cardH: boxH };
}

// Ряд из 1 или 3 карт (карта дня / да-нет / три карты / ситуация).
async function buildRowSpread(drawn, positions) {
  const labelItems = drawn.map(({ card, reversed }, i) => ({
    posLabel: positions[i],
    cardTitle: `${card.nameRu}${reversed ? " (перев.)" : ""}`,
  }));
  const labelH = labelHeightFor(labelItems, ROW_CARD_W);

  const tiles = [];
  for (let i = 0; i < drawn.length; i++) {
    const { card, reversed } = drawn[i];
    tiles.push(await buildTile(i + 1, positions[i], card, reversed, ROW_CARD_W, ROW_CARD_H, labelH));
  }

  const totalW = tiles.reduce((s, t) => s + t.w, 0) + PAD * (tiles.length + 1);
  const totalH = Math.max(...tiles.map((t) => t.h)) + PAD * 2;

  const composites = [];
  let x = PAD;
  for (const t of tiles) {
    composites.push({ input: t.buf, left: x, top: PAD });
    x += t.w + PAD;
  }

  return sharp({ create: { width: totalW, height: totalH, channels: 4, background: BG_COLOR } })
    .composite(composites)
    .png()
    .toBuffer();
}

// Классический "Кельтский крест": карты 1-6 в форме креста (карта 2 —
// поперёк карты 1), карты 7-10 столбиком-посохом справа, снизу вверх.
async function buildCelticSpread(drawn, positions) {
  const cw = CELTIC_CARD_W;
  const ch = CELTIC_CARD_H;
  const labelItems = drawn.map(({ card, reversed }, i) => ({
    posLabel: positions[i],
    cardTitle: `${card.nameRu}${reversed ? " (перев.)" : ""}`,
  }));
  // Считаем по ширине cw (не по расширенной ширине повёрнутой карты 2) —
  // это только даёт карте 2 небольшой запас снизу подписи, не обрезание.
  const labelH = labelHeightFor(labelItems, cw);
  const tileH = ch + labelH + 4;

  const tiles = [];
  for (let i = 0; i < 10; i++) {
    const { card, reversed } = drawn[i];
    const extraRotate = i === 1 ? 90 : 0;
    tiles.push(await buildTile(i + 1, positions[i], card, reversed, cw, ch, labelH, extraRotate));
  }

  const crossW = cw * 3 + PAD * 4;
  const crossH = tileH * 3 + PAD * 4;
  const staffW = tiles[6].w + PAD * 2;
  const staffH = tileH * 4 + PAD * 5;
  const totalW = crossW + staffW + PAD;
  const totalH = Math.max(crossH, staffH) + PAD * 2;

  const crossTop = PAD + Math.max(0, (totalH - crossH) / 2 - PAD);
  const colX = (col) => PAD + col * (cw + PAD);
  const rowY = (row) => crossTop + row * (tileH + PAD);

  const composites = [];
  // Карта 1 — центр.
  const c1Left = colX(1);
  const c1Top = rowY(1);
  composites.push({ input: tiles[0].buf, left: c1Left, top: c1Top });
  // Карта 2 — поперёк карты 1, центрируется по центру карты 1.
  const c2 = tiles[1];
  composites.push({
    input: c2.buf,
    left: Math.round(c1Left + cw / 2 - c2.w / 2),
    top: Math.round(c1Top + ch / 2 - c2.cardH / 2),
  });
  composites.push({ input: tiles[2].buf, left: colX(1), top: rowY(2) }); // 3 — основа/корень, снизу
  composites.push({ input: tiles[3].buf, left: colX(0), top: rowY(1) }); // 4 — недавнее прошлое, слева
  composites.push({ input: tiles[4].buf, left: colX(1), top: rowY(0) }); // 5 — возможное развитие, сверху
  composites.push({ input: tiles[5].buf, left: colX(2), top: rowY(1) }); // 6 — ближайшее будущее, справа

  // Посох (7 снизу — 10 сверху), справа от креста, по центру относительно
  // полной высоты холста.
  const staffX = crossW + PAD;
  const staffTop = PAD + Math.max(0, (totalH - staffH) / 2 - PAD);
  composites.push({ input: tiles[9].buf, left: staffX, top: staffTop }); // 10
  composites.push({ input: tiles[8].buf, left: staffX, top: staffTop + (tileH + PAD) }); // 9
  composites.push({ input: tiles[7].buf, left: staffX, top: staffTop + 2 * (tileH + PAD) }); // 8
  composites.push({ input: tiles[6].buf, left: staffX, top: staffTop + 3 * (tileH + PAD) }); // 7

  return sharp({ create: { width: totalW, height: totalH, channels: 4, background: BG_COLOR } })
    .composite(composites)
    .png()
    .toBuffer();
}

// Единая точка входа для index.js. spreadType — ключ из SPREADS (tarot.js),
// drawn — результат drawCards/drawDailyCard (см. tarot.js), positions —
// SPREADS[spreadType].positions (передаётся явно, чтобы этот модуль не
// тянул на себя знание про SPREADS).
export async function buildSpreadCollage(spreadType, drawn, positions) {
  if (spreadType === "celtic") {
    return buildCelticSpread(drawn, positions);
  }
  return buildRowSpread(drawn, positions);
}
