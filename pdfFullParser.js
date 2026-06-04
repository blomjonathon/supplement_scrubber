'use strict';

const _OP  = /^(?:remove\/replace|remove\/install|repair|straighten|blend|sublet|refinish|inspect|overhaul|r&r|r&i|r\/r|r\/i|repl|rpr|blnd|incl|o\/h|a\/m|subl{1,2})$/i;
const _PT  = /^(?:OEM|A\/M|LKQ|Other|Sublet|Rechr|Reman|Recor|RECOND)$/;
const _LT  = /^(?:Body|Mech|Mechanical|Ref|Struc|Elec)$/;
const _VER = /^[A-Z]\d+$/;

// ── Entry point ───────────────────────────────────────────────────────────────

async function parseEstimatePDF(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const all = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page    = await pdf.getPage(p);
    const content = await page.getTextContent();
    const { height } = page.getViewport({ scale: 1 });
    for (const item of content.items) {
      const s = item.str.trim();
      if (s) all.push({ s, x: item.transform[4], y: height - item.transform[5], page: p });
    }
  }

  const rows    = _groupByY(all);
  const rawText = rows.map(r => r.map(i => i.s).join(' ')).join('\n');
  const cols    = _findCols(rows);

  return {
    document:          _parseDoc(rawText),
    line_items:        _parseItems(rows, cols),
    totals:            _parseTotals(rawText),
    estimate_versions: _parseVersions(rawText),
    payments:          _parsePayments(rawText),
  };
}

function downloadParsedJSON(data, roNumber) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `RO_${roNumber || 'estimate'}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Row grouping ──────────────────────────────────────────────────────────────

function _groupByY(items, tol = 2.5) {
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

// ── Column bounds from header row ─────────────────────────────────────────────
// Finds the "Line Ver Operation Description Qty Extended Price $ Part Type Labor Type Paint" row
// and records each column's x-coordinate.

function _findCols(rows) {
  for (const row of rows) {
    const strs = row.map(i => i.s);
    if (!strs.includes('Line') || !strs.includes('Operation') || !strs.includes('Paint')) continue;

    const b = {};
    const typeItems = [];
    for (const item of row) {
      switch (item.s) {
        case 'Line':        b.line    = item.x; break;
        case 'Ver':         b.ver     = item.x; break;
        case 'Operation':   b.op      = item.x; break;
        case 'Description': b.desc    = item.x; break;
        case 'Qty':         b.qty     = item.x; break;
        case 'Extended':    b.price   = item.x; break;
        case 'Part':        b.pt      = item.x; break;
        case 'Labor':       b.labor   = item.x; break;
        case 'Paint':       b.paint   = item.x; break;
        case 'Type':        typeItems.push(item); break;
      }
    }
    // Two "Type" columns exist: "Part Type" and "Labor Type".
    // The rightmost one (higher x) is the Labor Type column.
    if (typeItems.length >= 2) {
      typeItems.sort((a, b) => a.x - b.x);
      b.lt = typeItems[typeItems.length - 1].x;
    } else if (typeItems.length === 1) {
      b.lt = typeItems[0].x;
    }

    if (b.labor != null && b.paint != null && b.paint > b.labor) return b;
  }
  return null;
}

// ── Line items ────────────────────────────────────────────────────────────────

function _parseItems(rows, cols) {
  const out = [];
  for (const row of rows) {
    const item = _parseLine(row, cols);
    if (item) out.push(item);
  }
  return out;
}

function _parseLine(row, cols) {
  const strs = row.map(i => i.s);

  // Every valid line item starts with a line number then a Ver code (e.g. E01, S02)
  if (!strs[0] || !/^\d{1,3}$/.test(strs[0])) return null;
  if (!strs[1] || !_VER.test(strs[1]))         return null;

  const lineNum = parseInt(strs[0]);
  const ver     = strs[1];
  let idx = 2;

  // Operation (optional — section headers have none)
  const operation = (strs[idx] && _OP.test(strs[idx])) ? strs[idx++] : null;

  // Remaining items after line#, ver, [op]
  const tail = row.slice(idx);

  // ── Keyword fields (position-independent) ─────────────────────────────────
  const ptStr = tail.find(i => _PT.test(i.s))?.s ?? null;  // part type
  const ltStr = tail.find(i => _LT.test(i.s))?.s ?? null;  // labor type

  // ── Section header detection ──────────────────────────────────────────────
  // All-caps description, no operation, no numeric values
  const tailText = tail.map(i => i.s).join(' ');
  if (!operation && !/\d/.test(tailText) && /^[A-Z0-9\s&\/\-\.]+$/.test(tailText.trim())) {
    return {
      line: lineNum, ver, operation: null,
      description: tailText.trim(),
      qty: null, extended_price: null, taxable: false,
      part_type: null, labor: null, type: null, paint: null,
      section_header: true,
    };
  }

  // ── Numeric fields via column x-proximity ─────────────────────────────────
  let desc = '', qty = null, extended_price = null, taxable = false;
  let labor = null, paint = null;

  if (cols) {
    // Description: items to the left of the Qty column
    const qtyX = cols.qty ?? cols.price ?? Infinity;
    desc = tail
      .filter(i => i.x < qtyX - 10 && !_PT.test(i.s) && !_LT.test(i.s))
      .map(i => i.s).join(' ').trim();

    // Right-side items: assign to nearest column
    const right = tail.filter(i => i.x >= qtyX - 10);
    const near  = (targetX) => {
      if (targetX == null) return null;
      let best = null;
      for (const item of right) {
        const d = Math.abs(item.x - targetX);
        if (d < 20 && (!best || d < Math.abs(best.x - targetX))) best = item;
      }
      return best;
    };

    const qtyI   = near(cols.qty);
    const priceI = near(cols.price);
    const laborI = near(cols.labor);
    const paintI = near(cols.paint);

    if (qtyI && /^\d{1,3}$/.test(qtyI.s))        qty = parseInt(qtyI.s);
    if (priceI) {
      const ps = priceI.s.replace(',', '');
      taxable = ps.endsWith('T');
      extended_price = parseFloat(taxable ? ps.slice(0, -1) : ps) || null;
    }
    if (laborI && /^\d*\.?\d+$/.test(laborI.s))   labor = parseFloat(laborI.s) || null;
    if (paintI) {
      const ps = paintI.s;
      if (/^\(\d+\.?\d*\)$/.test(ps))  paint = -(parseFloat(ps.slice(1, -1)) || 0);
      else if (/^\d*\.?\d+$/.test(ps)) paint = parseFloat(ps) || null;
    }
  } else {
    // Fallback: keyword-anchor parsing without column positions
    const ltIdx = tail.findIndex(i => _LT.test(i.s));
    const ptIdx = tail.findIndex(i => _PT.test(i.s));

    // Description: tokens before the first keyword anchor, excluding numbers
    const anchorIdx = Math.min(
      ltIdx >= 0 ? ltIdx : Infinity,
      ptIdx >= 0 ? ptIdx : Infinity,
    );
    desc = tail
      .slice(0, anchorIdx === Infinity ? tail.length : anchorIdx)
      .filter(i => !/^\d*\.?\d+T?$/.test(i.s.replace(',', '')))
      .map(i => i.s).join(' ').trim();

    // Labor: number immediately before labor type
    if (ltIdx > 0 && /^\d*\.?\d+$/.test(strs[idx + ltIdx - 1])) {
      labor = parseFloat(strs[idx + ltIdx - 1]) || null;
    }
    // Paint: number after labor type
    const afterLt = ltIdx >= 0 ? tail.slice(ltIdx + 1) : [];
    const paintStr = afterLt.find(i => /^\(?\d+\.?\d*\)?$/.test(i.s));
    if (paintStr) {
      const ps = paintStr.s;
      if (/^\(\d+\.?\d*\)$/.test(ps)) paint = -(parseFloat(ps.slice(1, -1)) || 0);
      else paint = parseFloat(ps) || null;
    }
    // Price: token ending in T
    const priceI = tail.find(i => /^\d+[\d,]*\.?\d*T$/.test(i.s));
    if (priceI) {
      taxable = true;
      extended_price = parseFloat(priceI.s.replace(',', '').slice(0, -1)) || null;
    }
    // Qty: small integer before the part type
    if (ptIdx > 0) {
      const before = tail.slice(0, ptIdx).map(i => i.s);
      const qtyStr = [...before].reverse().find(s => /^\d{1,3}$/.test(s));
      if (qtyStr) qty = parseInt(qtyStr);
    }
  }

  return {
    line: lineNum, ver, operation,
    description: desc || tail.filter(i => !_PT.test(i.s) && !_LT.test(i.s)).map(i => i.s).join(' ').trim(),
    qty: qty || null,
    extended_price: extended_price || null,
    taxable,
    part_type: ptStr,
    labor: labor || null,
    type: ltStr,
    paint: paint || null,
    section_header: false,
  };
}

// ── Document header ───────────────────────────────────────────────────────────

function _parseDoc(raw) {
  const m  = (re, g = 1) => { const x = raw.match(re); return x?.[g]?.trim() ?? null; };
  const pf = (re, g = 1) => { const x = raw.match(re); return x ? parseFloat(x[g].replace(/,/g, '')) : null; };

  return {
    shop: {
      name:        m(/^(.*?(?:AUTO BODY|COLLISION|GLASS|REPAIR|CENTER).*?)$/im),
      address:     m(/Phone:.*?\n(.*?)\nPhone:/s) ?? m(/\n(\d+[^\n]+(?:Blvd|Ave|St|Dr|Rd|Ln)[^\n]*)\n/i),
      phone:       m(/Phone:\s*([\(\d\)\s\-\.]+)/),
      workfile_id: m(/Workfile ID:\s*(\w+)/),
      federal_id:  m(/Federal ID:\s*([\d\-]+)/),
    },
    ro_number:   m(/RO Number:\s*(\d+)/),
    type:        m(/(Final Bill|Estimate)/i),
    create_date: m(/Create Date:\s*([\d\/]+)/),
    estimator:   m(/Estimator:\s*([^\n\r]+)/),
    customer: {
      name:         m(/Customer:[^\n]*\n([A-Z][a-zA-Z,\.\s]+?)(?:\s{2,}|\n)/),
      address:      m(/\n(\d+\s+[A-Z][^\n]+(?:St|Ave|Blvd|Dr|Rd|Ln|Way)[^\n]*)\n/i),
      city_state_zip: m(/\n([A-Z][a-zA-Z\s]+,\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?)\n/),
      phone:        m(/(\(\d{3}\)\s*\d{3}-\d{4})/),
    },
    insurance: {
      company:    m(/Insurance:[^\n]*\n([A-Z][A-Z\s]+)(?:\n|Phone:)/),
      carrier:    m(/Insurance:[^\n]*\n[A-Z][A-Z\s]+\n([A-Z][a-zA-Z\s]+)\n/),
      claim:      m(/Claim[:\s#]+([A-Z0-9\-]+)/i),
      loss_date:  m(/Loss Date:\s*([\d\/]+)/),
      deductible: pf(/Deductible:\s*([\d,\.]+)/),
    },
    vehicle: {
      description:    m(/\n(20\d\d\s+[A-Z]{2,4}\s+[^\n]{10,})/m),
      vin:            m(/VIN:\s*([A-HJ-NPR-Z0-9]{17})/i),
      exterior_color: m(/Exterior Color:\s*([^\n]+?)(?:\s{3,}|$)/m),
      interior_color: m(/Interior Color:\s*([^\n]+?)(?:\s{3,}|$)/m),
      mileage_in:     pf(/Mileage In:\s*([\d,]+)/),
      mileage_out:    pf(/Mileage Out:\s*([\d,]+)/),
      production_date: m(/Production Date:\s*([^\s\n][^\n]+)/),
    },
  };
}

// ── Totals ────────────────────────────────────────────────────────────────────

function _parseTotals(raw) {
  const pf  = s  => s  ? parseFloat(s.replace(/[,\(\)]/g, '')) : null;
  const m3  = re => { const x = raw.match(re); return x ? [pf(x[1]), pf(x[2]), pf(x[3])] : null; };
  const mN  = re => { const x = raw.match(re); return x ? pf(x[1]) : null; };

  const body = m3(/Labor,?\s*Body\s+([\d,\.]+)\s+([\d,\.]+)\s+([\d,\.]+)/i);
  const ref  = m3(/Labor,?\s*Refinish\s+([\d,\.]+)\s+([\d,\.]+)\s+([\d,\.]+)/i);
  const mech = m3(/Labor,?\s*Mechanical\s+([\d,\.]+)\s+([\d,\.]+)\s+([\d,\.]+)/i);
  const misc = raw.match(/Miscellaneous\s+([\d,\.]+)\s+([\d,\.]+)/i);

  return {
    parts:            mN(/Parts\s+([\d,\.]+)/),
    labor_body:       body ? { rate: body[0], hours: body[1], total: body[2] } : null,
    labor_refinish:   ref  ? { rate: ref[0],  hours: ref[1],  total: ref[2] }  : null,
    labor_mechanical: mech ? { rate: mech[0], hours: mech[1], total: mech[2] } : null,
    material_paint:   mN(/Material,?\s*Paint\s+([\d,\.]+)/i),
    miscellaneous:    misc ? { markup: pf(misc[1]), total: pf(misc[2]) } : null,
    subtotal:         mN(/Subtotal\s+([\d,\.]+)/i),
    sales_tax:        mN(/Sales Tax\s+([\d,\.]+)/i),
    grand_total:      mN(/Grand Total\s+([\d,\.]+)/i),
    deductible:       mN(/Deductible\s+\(?([\d,\.]+)\)?/i),
    net_total:        mN(/Net Total\s+([\d,\.]+)/i),
  };
}

// ── Estimate versions ─────────────────────────────────────────────────────────

function _parseVersions(raw) {
  const out = [];
  const re  = /^(Original|Supplement\s+\w+)\s+([\d,\.]+|\([\d,\.]+\))/gim;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const raw_total = m[2].replace(/,/g, '');
    const negative  = raw_total.startsWith('(');
    out.push({
      version: m[1].trim(),
      total: parseFloat(raw_total.replace(/[\(\)]/g, '')) * (negative ? -1 : 1),
    });
  }
  return out;
}

// ── Payments ──────────────────────────────────────────────────────────────────

function _parsePayments(raw) {
  const pf = s => parseFloat(s.replace(/,/g, ''));

  const insReceived = raw.match(/Received from Insurance \$:\s*([\d,\.]+)/i);
  const insBal      = raw.match(/Balance due from Insurance \$:\s*([\d,\.]+)/i);
  const custTotal   = raw.match(/Customer Total \$:\s*([\d,\.]+)/i);
  const custRcvd    = raw.match(/Received from Customer \$:\s*([\d,\.]+)/i);
  const custBal     = raw.match(/Balance due from Customer \$:\s*([\d,\.]+)/i);

  // Insurance payment records: "COMPANY NAME  MM/DD/YYYY  amount"
  const insRecords = [];
  const insRe = /([A-Z][A-Z\s]+(?:COMPANY|INSURANCE))\s+([\d]{1,2}\/[\d]{1,2}\/[\d]{4})\s+([\d,\.]+)/g;
  let im;
  while ((im = insRe.exec(raw)) !== null) {
    insRecords.push({ payer: im[1].trim(), date: im[2], amount: pf(im[3]) });
  }

  // Customer payment records: "Name, First  MM/DD/YYYY  amount"
  const custRecords = [];
  const custRe = /([A-Z][a-z]+,\s+[A-Z][a-z]+)\s+([\d]{1,2}\/[\d]{1,2}\/[\d]{4})\s+([\d,\.]+)/g;
  let cm;
  while ((cm = custRe.exec(raw)) !== null) {
    custRecords.push({ payer: cm[1].trim(), date: cm[2], amount: pf(cm[3]) });
  }

  return {
    insurance: {
      total_received: insReceived ? pf(insReceived[1]) : null,
      records: insRecords,
      balance_due: insBal ? pf(insBal[1]) : null,
    },
    customer: {
      total: custTotal ? pf(custTotal[1]) : null,
      total_received: custRcvd ? pf(custRcvd[1]) : null,
      records: custRecords,
      balance_due: custBal ? pf(custBal[1]) : null,
    },
  };
}
