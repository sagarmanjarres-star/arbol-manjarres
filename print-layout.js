// Splits a (possibly large) family tree into A4 sheets for printing/PDF.
// The one rule that matters: a cut never runs through a person's card.
// Whole generations that fit together share a page; a generation too wide
// for one page on its own gets split into left-to-right column tiles, each
// cut only in the gap between two cards.

import { computeLayout, CARD_W, CARD_H } from './tree.js';

const PAGE_W_MM = 297; // A4 landscape
const PAGE_H_MM = 210;
const PAGE_MARGIN_MM = 12;

// Never shrink further than this — below it the names stop being readable
// on paper, so we switch from "one shrunk page" to "several full-size ones".
const MIN_READABLE_SCALE = 0.6;

function mmToPx(mm) {
  return mm * (96 / 25.4);
}

export function computePrintPages(people, headerHeightPx = 0) {
  const { rows, pos, canvasWidth, canvasHeight } = computeLayout(people);

  const availW = mmToPx(PAGE_W_MM - PAGE_MARGIN_MM * 2);
  const availH = mmToPx(PAGE_H_MM - PAGE_MARGIN_MM * 2) - headerHeightPx;

  if (!rows.length) {
    return { scale: 1, pages: [{ xStart: 0, yStart: 0, xEnd: canvasWidth, yEnd: canvasHeight }] };
  }

  const naturalScale = Math.min(availW / canvasWidth, availH / canvasHeight, 1);
  if (naturalScale >= MIN_READABLE_SCALE) {
    return { scale: naturalScale, pages: [{ xStart: 0, yStart: 0, xEnd: canvasWidth, yEnd: canvasHeight }] };
  }

  const scale = MIN_READABLE_SCALE;
  const pageContentW = availW / scale;
  const pageContentH = availH / scale;

  const rowInfo = rows.map((ids) => {
    const xs = ids.map((id) => pos.get(id).x);
    const y = pos.get(ids[0]).y;
    return {
      ids,
      y,
      yEnd: y + CARD_H,
      xMin: Math.min(...xs),
      xMax: Math.max(...xs) + CARD_W,
    };
  });

  const pages = [];
  let band = [];
  let bandHeight = 0;

  const flushBand = () => {
    if (!band.length) return;
    pages.push({
      xStart: Math.min(...band.map((r) => r.xMin)),
      xEnd: Math.max(...band.map((r) => r.xMax)),
      yStart: band[0].y,
      yEnd: band[band.length - 1].yEnd,
    });
    band = [];
    bandHeight = 0;
  };

  for (const row of rowInfo) {
    const rowWidth = row.xMax - row.xMin;
    const rowHeight = row.yEnd - row.y;

    if (rowWidth > pageContentW) {
      // This single generation is wider than a page on its own — flush
      // whatever band was building, then give this row its own column tiles.
      flushBand();
      pages.push(...splitRowIntoColumns(row, pos, pageContentW));
      continue;
    }

    if (band.length && bandHeight + rowHeight > pageContentH) {
      flushBand();
    }
    band.push(row);
    bandHeight += rowHeight;
  }
  flushBand();

  return { scale, pages };
}

function splitRowIntoColumns(row, pos, pageContentW) {
  const sorted = row.ids.slice().sort((a, b) => pos.get(a).x - pos.get(b).x);
  const tiles = [];
  let tileStart = pos.get(sorted[0]).x;
  let prevEnd = tileStart;

  for (const id of sorted) {
    const x = pos.get(id).x;
    const end = x + CARD_W;
    if (end - tileStart > pageContentW) {
      tiles.push({ xStart: tileStart, xEnd: prevEnd, yStart: row.y, yEnd: row.yEnd });
      tileStart = x;
    }
    prevEnd = end;
  }
  tiles.push({ xStart: tileStart, xEnd: prevEnd, yStart: row.y, yEnd: row.yEnd });
  return tiles;
}
