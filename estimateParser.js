'use strict';

// CCC One Operation column values (printed full-word and internal short-code formats)
const OP_RE = /^(?:remove\/replace|remove\/install|repair|straighten|blend|sublet|refinish|inspect|overhaul|r&r|r&i|r\/r|r\/i|repl|rpr|blnd|incl|o\/h|a\/m|subl{1,2})$/i;

// ── Main entry point ──────────────────────────────────────────────────────────
// Returns { rawText, lines, cols }
//   rawText — full text joined row-by-row, used by all keyword-based detection
//   lines   — array of { lineNum, op, description, bodyHrs, paintHrs }
//   cols    — detected column x-positions: { body, paint } or null

async function extractStructured(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const allItems = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const { height } = page.getViewport({ scale: 1 });
    for (const item of content.items) {
      const s = item.str.trim();
      if (s) allItems.push({ s, x: item.transform[4], y: height - item.transform[5], page: p });
    }
  }

  const rows = groupByRow(allItems);
  const cols = findCols(rows);
  const lines = toLines(rows, cols);
  const rawText = rows.map(r => r.map(i => i.s).join(' ')).join('\n');

  return { rawText, lines, cols };
}

// ── Row grouping ──────────────────────────────────────────────────────────────
// Items within tol y-units of each other are treated as the same row.

function groupByRow(items, tol = 2.5) {
  const sorted = [...items].sort((a, b) =>
    a.page !== b.page ? a.page - b.page : a.y !== b.y ? a.y - b.y : a.x - b.x
  );
  const rows = [];
  for (const item of sorted) {
    const prev = rows[rows.length - 1];
    if (prev && prev[0].page === item.page && Math.abs(item.y - prev[0].y) <= tol) {
      prev.push(item);
    } else {
      rows.push([item]);
    }
  }
  return rows.map(r => r.sort((a, b) => a.x - b.x));
}

// ── Column header detection ───────────────────────────────────────────────────
// CCC One always has this exact column header row:
//   Line  Ver  Operation  Description  Qty  Extended  Price  $  Part  Type  Labor  Type  Paint
//
// We find it by requiring "operation", "labor", and "paint" as exact tokens on
// the same row, then record the x-coordinates of Labor and Paint columns.

function findCols(rows) {
  for (const row of rows) {
    const lower = row.map(i => i.s.toLowerCase());
    if (!lower.includes('operation')) continue;
    if (!lower.includes('labor'))     continue;
    if (!lower.includes('paint'))     continue;

    let body = null, paint = null;
    for (const item of row) {
      const t = item.s.toLowerCase();
      if (t === 'labor') body  = item.x;
      if (t === 'paint') paint = item.x;
    }
    // Sanity check: Paint column must be to the right of Labor column
    if (body !== null && paint !== null && paint > body) {
      return { body, paint };
    }
  }
  return null;
}

// ── Line item parsing ─────────────────────────────────────────────────────────
// Fixed CCC One column order (left → right):
//   Line  Ver  Operation  Description  Qty  Extended Price $  Part Type  Labor  Type  Paint
//
// For every row containing a recognized Operation value we extract bodyHrs and
// paintHrs by matching candidate numbers to the nearest column x-position.

function toLines(rows, cols) {
  const out = [];

  for (const row of rows) {
    const strs = row.map(i => i.s);
    const opIdx = strs.findIndex(s => OP_RE.test(s));
    if (opIdx === -1) continue;

    // Line number: first short integer before the OP (skips Ver codes like S02, E01)
    const lineNum = strs.slice(0, opIdx).find(s => /^\d{1,4}$/.test(s)) || '';
    const op = strs[opIdx];

    // Items after the Operation token
    const tail = row.slice(opIdx + 1);

    // Hour candidates: 1–2 integer digits, at most 1 decimal place, value ≤ 50.
    // Prices are excluded (they have ≥3 integer digits or a taxable "T" suffix).
    const hrItems   = tail.filter(i => /^\d{1,2}(?:\.\d)?$/.test(i.s) && +i.s <= 50);
    const descItems = tail.filter(i => !/^\d*\.?\d+$/.test(i.s));

    let bodyHrs = 0, paintHrs = 0;

    if (cols && hrItems.length) {
      // Primary: use the x-distance to each column header to assign values.
      // Paint gets first pick (rightmost reference); body picks from the rest.
      const nearest = (targetX, list) =>
        list.reduce((a, b) => Math.abs(a.x - targetX) < Math.abs(b.x - targetX) ? a : b);

      const pItem = nearest(cols.paint, hrItems);
      paintHrs = +pItem.s || 0;

      const rest = hrItems.filter(i => i !== pItem);
      if (rest.length) {
        bodyHrs = +(nearest(cols.body, rest).s) || 0;
      }

    } else if (hrItems.length >= 2) {
      // Fallback without column positions: leftmost = body, rightmost = paint
      const byX = [...hrItems].sort((a, b) => a.x - b.x);
      bodyHrs  = +byX[0].s || 0;
      paintHrs = +byX[byX.length - 1].s || 0;

    } else if (hrItems.length === 1) {
      const v = +hrItems[0].s || 0;
      if (/^(?:blend|blnd|refinish)$/i.test(op)) {
        paintHrs = v; // Blend/Refinish lines carry paint hours only
      } else if (cols) {
        const midX = (cols.body + cols.paint) / 2;
        hrItems[0].x >= midX ? (paintHrs = v) : (bodyHrs = v);
      } else {
        bodyHrs = v;
      }
    }

    out.push({
      lineNum,
      op,
      description: descItems.map(i => i.s).join(' ').trim(),
      bodyHrs,
      paintHrs,
    });
  }

  return out;
}
