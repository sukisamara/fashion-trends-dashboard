// Tiny no-deps dashboard. Loads docs/data/trends.json and renders.

const DATA_URL = "data/trends.json";
const $ = (sel) => document.querySelector(sel);

const state = {
  data: null,
  category: "All",
  sort: "latest",
};

// ---------- bootstrap ----------
async function init() {
  $("#sort").addEventListener("change", (e) => {
    state.sort = e.target.value;
    render();
  });
  document.querySelectorAll("[data-close]").forEach((el) =>
    el.addEventListener("click", closeModal)
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });

  try {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("no data yet");
    state.data = await res.json();
  } catch (err) {
    console.warn("No data file yet:", err);
    return; // empty state remains
  }
  buildCategoryPills();
  setStamps();
  render();
}

function setStamps() {
  const d = new Date(state.data.generated_at);
  const fmt = d.toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric"
  });
  $("#updated-stamp").textContent = `Updated ${fmt}`;
  $("#edition-meta").textContent = `${fmt.toUpperCase()} · WORLDWIDE EDITION`;

  // Edition number = days since 2025-01-01, padded
  const days = Math.floor((d - new Date("2025-01-01")) / 86400000);
  $("#index-stamp").textContent = "N° " + String(days).padStart(3, "0");

  $("#benchmark-note").textContent =
    `Benchmark: ${state.data.benchmark} · Timeframe: 12 months`;
}

function buildCategoryPills() {
  const cats = ["All", ...new Set(state.data.brands.map((b) => b.category))];
  const wrap = $("#categories");
  wrap.innerHTML = "";
  cats.forEach((cat) => {
    const btn = document.createElement("button");
    btn.className = "cat-pill" + (cat === state.category ? " is-active" : "");
    btn.textContent = cat;
    btn.addEventListener("click", () => {
      state.category = cat;
      document.querySelectorAll(".cat-pill").forEach((p) =>
        p.classList.toggle("is-active", p.textContent === cat)
      );
      render();
    });
    wrap.appendChild(btn);
  });
}

// ---------- render ----------
function render() {
  if (!state.data) return;
  let brands = [...state.data.brands];

  if (state.category !== "All") {
    brands = brands.filter((b) => b.category === state.category);
  }

  const sorters = {
    latest: (a, b) => b.summary.latest - a.summary.latest,
    change: (a, b) => b.summary.change_pct - a.summary.change_pct,
    alpha: (a, b) => a.name.localeCompare(b.name),
  };
  brands.sort(sorters[state.sort]);

  const grid = $("#grid");
  grid.innerHTML = "";
  if (brands.length === 0) {
    grid.innerHTML = `<div class="empty-state"><p class="empty-state__title">No brands</p><p class="empty-state__body">Try a different category.</p></div>`;
    return;
  }

  brands.forEach((b, i) => {
    grid.appendChild(renderCard(b, i + 1));
  });
}

function renderCard(brand, rank) {
  const el = document.createElement("article");
  el.className = "card";
  el.tabIndex = 0;

  const change = brand.summary.change_pct;
  const cls = change > 1.5 ? "up" : change < -1.5 ? "down" : "flat";
  const sign = change > 0 ? "+" : "";

  const topRising = brand.rising_queries[0];
  const risingHtml = topRising
    ? `<em>Rising</em>${escapeHtml(topRising.query)}`
    : `<em>Rising</em><span style="opacity:0.6;">—</span>`;

  el.innerHTML = `
    <div class="card__rank">N° ${String(rank).padStart(3, "0")} · ${escapeHtml(brand.category)}</div>
    <h2 class="card__name">${escapeHtml(brand.name)}</h2>
    ${sparkline(brand.series, 36)}
    <div class="card__meta">
      <span class="card__latest">${brand.summary.latest}</span>
      <span class="card__change ${cls}">${sign}${change.toFixed(1)}%</span>
    </div>
    <div class="card__rising">${risingHtml}</div>
  `;
  el.addEventListener("click", () => openModal(brand));
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openModal(brand);
    }
  });
  return el;
}

// ---------- charts ----------
function sparkline(series, height = 36) {
  if (!series || series.length < 2) {
    return `<svg class="card__spark" viewBox="0 0 100 ${height}" preserveAspectRatio="none"><line x1="0" y1="${height/2}" x2="100" y2="${height/2}" stroke="#bbb" stroke-dasharray="2 3"/></svg>`;
  }
  const values = series.map((p) => p.value);
  const max = Math.max(...values, 1);
  const min = Math.min(...values);
  const range = max - min || 1;
  const w = 100;
  const h = height;
  const pad = 2;
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = pad + (1 - (v - min) / range) * (h - pad * 2);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const last = points[points.length - 1].split(",");
  const fillPts = `0,${h} ${points.join(" ")} ${w},${h}`;
  return `
    <svg class="card__spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <polygon points="${fillPts}" fill="#a8200d" opacity="0.08"/>
      <polyline points="${points.join(" ")}" fill="none" stroke="#161413" stroke-width="1.2" vector-effect="non-scaling-stroke"/>
      <circle cx="${last[0]}" cy="${last[1]}" r="1.6" fill="#a8200d"/>
    </svg>
  `;
}

function detailChart(series, mountEl) {
  if (!series || series.length < 2) {
    mountEl.innerHTML = `<p style="color:var(--ink-mute);font-style:italic;">No series data.</p>`;
    return;
  }
  const w = mountEl.clientWidth || 720;
  const h = 240;
  const padL = 36, padR = 12, padT = 14, padB = 28;
  const values = series.map((p) => p.value);
  const max = Math.max(...values, 1);
  const min = 0;
  const range = max - min || 1;
  const dates = series.map((p) => p.date);

  const x = (i) => padL + (i / (series.length - 1)) * (w - padL - padR);
  const y = (v) => padT + (1 - (v - min) / range) * (h - padT - padB);

  const linePts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const fillPts = `${x(0)},${h - padB} ${linePts} ${x(values.length - 1)},${h - padB}`;

  // Y ticks
  const ticks = [0, max / 2, max].map((v) => Math.round(v));
  const yTicks = ticks.map((v) =>
    `<g><line x1="${padL}" y1="${y(v)}" x2="${w - padR}" y2="${y(v)}" stroke="#cdc6b8" stroke-dasharray="2 4"/>
      <text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end" font-family="IBM Plex Mono" font-size="10" fill="#8a8278">${v}</text></g>`
  ).join("");

  // X labels: first, middle, last
  const firstDate = formatDate(dates[0]);
  const lastDate = formatDate(dates[dates.length - 1]);
  const midIdx = Math.floor(series.length / 2);
  const midDate = formatDate(dates[midIdx]);

  mountEl.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
      ${yTicks}
      <polygon points="${fillPts}" fill="#a8200d" opacity="0.1"/>
      <polyline points="${linePts}" fill="none" stroke="#161413" stroke-width="1.6"/>
      <text x="${x(0)}" y="${h - 8}" font-family="IBM Plex Mono" font-size="10" fill="#4a4540">${firstDate}</text>
      <text x="${x(midIdx)}" y="${h - 8}" text-anchor="middle" font-family="IBM Plex Mono" font-size="10" fill="#4a4540">${midDate}</text>
      <text x="${x(series.length - 1)}" y="${h - 8}" text-anchor="end" font-family="IBM Plex Mono" font-size="10" fill="#4a4540">${lastDate}</text>
    </svg>
  `;
}

// ---------- modal ----------
function openModal(brand) {
  $("#m-name").textContent = brand.name;
  $("#m-category").textContent = brand.category;
  $("#m-latest").textContent = brand.summary.latest;
  $("#m-avg").textContent = brand.summary.avg;
  const ch = brand.summary.change_pct;
  $("#m-change").textContent = (ch > 0 ? "+" : "") + ch.toFixed(1) + "%";
  $("#m-change").style.color = ch > 1.5 ? "var(--positive)" : ch < -1.5 ? "var(--negative)" : "var(--ink)";

  detailChart(brand.series, $("#m-chart"));

  const ol = $("#m-rising");
  if (brand.rising_queries.length === 0) {
    ol.innerHTML = `<li class="none">No rising queries detected this period.</li>`;
  } else {
    ol.innerHTML = brand.rising_queries
      .map((r) => {
        const v = r.value >= 5000
          ? "Breakout"
          : "+" + r.value + "%";
        return `<li><span class="q">${escapeHtml(r.query)}</span><span class="v">${v}</span></li>`;
      })
      .join("");
  }
  $("#modal").setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}
function closeModal() {
  $("#modal").setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

// ---------- utils ----------
function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

init();
