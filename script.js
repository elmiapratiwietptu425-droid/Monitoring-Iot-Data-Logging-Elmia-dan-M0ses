// ============================================================
//  CONFIG — Ganti URL dengan URL Google Apps Script kamu
// ============================================================
const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyt5vuodHV1pSXCfqMJXdbtrlgYDW4D8UJEcPgSEiwoJesiWf-6NpeX5Ow94n50eHiUlg/exec";

// ============================================================
//  THRESHOLD — nilai dikunci, tidak bisa diubah dari web
// ============================================================
const THRESHOLDS = {
  suhuMin: 23, suhuMax: 30,
  humMin:  70, humMax:  90,
  co2Min: 400, co2Max: 1000,
};

function isOutOfRange(val, min, max) {
  return val < min || val > max;
}

// ============================================================
//  STATE
// ============================================================
let fetchIntervalMs   = 5000;
let fetchTimer        = null;
let loggingActive     = true;
let allData           = [];
let chartData         = { lm35: [], dht: [], hum: [], co2: [], labels: [] };
let activeChartSensor = "lm35";
let sensorChart       = null;

// ============================================================
//  DOM REFS
// ============================================================
const els = {
  date:           document.getElementById("clockDate"),
  time:           document.getElementById("clockTime"),
  liveBadge:      document.getElementById("liveIndicator"),
  liveLabel:      document.getElementById("liveLabel"),
  valLm35:        document.getElementById("val-lm35"),
  valDht:         document.getElementById("val-dht"),
  valHum:         document.getElementById("val-hum"),
  valCo2:         document.getElementById("val-co2"),
  barLm35:        document.getElementById("bar-lm35"),
  barDht:         document.getElementById("bar-dht"),
  barHum:         document.getElementById("bar-hum"),
  barCo2:         document.getElementById("bar-co2"),
  cardLm35:       document.getElementById("card-lm35"),
  cardDht:        document.getElementById("card-dht"),
  cardHum:        document.getElementById("card-hum"),
  cardCo2:        document.getElementById("card-co2"),
  statWifi:       document.getElementById("stat-wifi"),
  statSd:         document.getElementById("stat-sd"),
  statUpdate:     document.getElementById("stat-lastupdate"),
  intervalInput:  document.getElementById("intervalInput"),
  applyBtn:       document.getElementById("applyInterval"),
  loggingToggle:  document.getElementById("loggingToggle"),
  loggingLabel:   document.getElementById("loggingLabel"),
  tableBody:      document.getElementById("tableBody"),
  downloadBtn:    document.getElementById("downloadBtn"),
  alertOverlay:   document.getElementById("alertOverlay"),
  alertMsg:       document.getElementById("alertMsg"),
  swBtns:         document.querySelectorAll(".sw-btn"),
};

// ============================================================
//  CLOCK
// ============================================================
function updateClock() {
  const now  = new Date();
  const dd   = String(now.getDate()).padStart(2, "0");
  const mm   = String(now.getMonth() + 1).padStart(2, "0");
  const yyyy = now.getFullYear();
  const hh   = String(now.getHours()).padStart(2, "0");
  const min  = String(now.getMinutes()).padStart(2, "0");
  const ss   = String(now.getSeconds()).padStart(2, "0");
  els.date.textContent = `${dd}/${mm}/${yyyy}`;
  els.time.textContent = `${hh}:${min}:${ss}`;
}
setInterval(updateClock, 1000);
updateClock();

// ============================================================
//  FETCH DATA
// ============================================================
let lastFetchSuccess = 0;   // timestamp fetch terakhir berhasil
let lastDataTime     = "";  // waktu data terakhir dari sheet

async function fetchData() {
  try {
    const url  = `${SCRIPT_URL}?read=1&_=${Date.now()}`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      // Fetch OK tapi data kosong — tetap LIVE
      setLiveStatus(true, "LIVE");
      return;
    }

    allData = rows;
    lastFetchSuccess = Date.now();

    // Deteksi apakah ada data baru dari ESP32
    const last        = rows[rows.length - 1];
    const currentTime = (last.tanggal || "") + (last.waktu || "");
    const dataUpdated = currentTime !== lastDataTime;
    if (dataUpdated) lastDataTime = currentTime;

    // LIVE = fetch berhasil. Badge berubah warna jika ada data baru
    setLiveStatus(true, dataUpdated ? "LIVE" : "LIVE");

    updateSensorCards(last);

    const MAX = 30;
    chartData.labels = rows.slice(-MAX).map(r => r.waktu || "");
    chartData.lm35   = rows.slice(-MAX).map(r => parseFloat(r.lm35)  || 0);
    chartData.dht    = rows.slice(-MAX).map(r => parseFloat(r.dht22) || 0);
    chartData.hum    = rows.slice(-MAX).map(r => parseFloat(r.hum)   || 0);
    chartData.co2    = rows.slice(-MAX).map(r => parseFloat(r.mq135) || 0);

    updateChart();
    renderTable(rows.slice(-50));

    els.statUpdate.textContent = last.waktu ? `${last.tanggal} ${last.waktu}` : "N/A";

    // ── WiFi status ──
    const wifiRaw  = (last.wifi || "").trim().toLowerCase();
    const wifiOk   = wifiRaw === "connected";
    els.statWifi.textContent = wifiOk ? "Connected" : "Disconnected";
    els.statWifi.style.color = wifiOk ? "var(--green)" : "var(--red)";

    // ── SD Card status ──
    const sdRaw = (last.sd || "").trim().toLowerCase();
    const sdOk  = sdRaw === "ready";
    els.statSd.textContent = sdOk ? "Ready" : "Not Ready";
    els.statSd.style.color = sdOk ? "var(--green)" : "var(--red)";

    // ── Chip border highlight ──
    const chips = document.querySelectorAll(".status-chip");
    chips[0].style.borderColor = wifiOk ? "" : "var(--red)";
    chips[1].style.borderColor = sdOk   ? "" : "var(--red)";

  } catch (err) {
    console.error("Gagal fetch:", err);
    // Hanya OFFLINE jika fetch benar-benar gagal (no internet / CORS / timeout)
    setLiveStatus(false);
  }
}

// ============================================================
//  LIVE STATUS
// ============================================================
let liveOfflineTimer = null;

function setLiveStatus(isLive, label) {
  clearTimeout(liveOfflineTimer);
  if (isLive) {
    els.liveBadge.className   = "live-badge live";
    els.liveLabel.textContent = label || "LIVE";
    // Kalau logging aktif, jangan otomatis OFFLINE
    // Hanya OFFLINE kalau fetch benar-benar error
  } else {
    els.liveBadge.className   = "live-badge offline";
    els.liveLabel.textContent = "OFFLINE";
  }
}

// ============================================================
//  UPDATE SENSOR CARDS
// ============================================================
function isSensorNaN(val) {
  if (val === null || val === undefined) return true;
  const raw = String(val).trim().toLowerCase();
  // Hanya anggap error jika ESP32 kirim string "nan" atau kosong
  // JANGAN anggap "0" sebagai error — bisa nilai valid atau baris WiFi putus
  if (raw === "nan" || raw === "" || raw === "null" || raw === "n/a") return true;
  if (isNaN(parseFloat(raw))) return true;
  return false;
}

function updateSensorCards(row) {
  const rawLm35 = row.lm35;
  const rawDht  = row.dht22;
  const rawHum  = row.hum;
  const rawCo2  = row.mq135;

  const nanLm35 = isSensorNaN(rawLm35);
  const nanDht  = isSensorNaN(rawDht);
  const nanHum  = isSensorNaN(rawHum);
  const nanCo2  = isSensorNaN(rawCo2);

  const lm35 = nanLm35 ? 0 : parseFloat(rawLm35);
  const dht  = nanDht  ? 0 : parseFloat(rawDht);
  const hum  = nanHum  ? 0 : parseFloat(rawHum);
  const co2  = nanCo2  ? 0 : parseFloat(rawCo2);

  setSensorDisplay(els.valLm35, els.cardLm35, nanLm35, lm35.toFixed(1));
  setSensorDisplay(els.valDht,  els.cardDht,  nanDht,  dht.toFixed(1));
  setSensorDisplay(els.valHum,  els.cardHum,  nanHum,  hum.toFixed(1));
  setSensorDisplay(els.valCo2,  els.cardCo2,  nanCo2,  Math.round(co2));

  setBar(els.barLm35, nanLm35 ? 0 : lm35, 0, 60);
  setBar(els.barDht,  nanDht  ? 0 : dht,  0, 60);
  setBar(els.barHum,  nanHum  ? 0 : hum,  0, 100);
  setBar(els.barCo2,  nanCo2  ? 0 : co2,  0, 2000);

  // Card state: warn = mendekati batas (5% dari range), danger = keluar range
  if (!nanLm35) setCardStateRange(els.cardLm35, lm35, THRESHOLDS.suhuMin, THRESHOLDS.suhuMax);
  if (!nanDht)  setCardStateRange(els.cardDht,  dht,  THRESHOLDS.suhuMin, THRESHOLDS.suhuMax);
  if (!nanHum)  setCardStateRange(els.cardHum,  hum,  THRESHOLDS.humMin,  THRESHOLDS.humMax);
  if (!nanCo2)  setCardStateRange(els.cardCo2,  co2,  THRESHOLDS.co2Min,  THRESHOLDS.co2Max);

  const suhuBahaya = (!nanLm35 && isOutOfRange(lm35, THRESHOLDS.suhuMin, THRESHOLDS.suhuMax))
                  || (!nanDht  && isOutOfRange(dht,  THRESHOLDS.suhuMin, THRESHOLDS.suhuMax));
  const humBahaya  = !nanHum && isOutOfRange(hum, THRESHOLDS.humMin,  THRESHOLDS.humMax);
  const co2Bahaya  = !nanCo2 && isOutOfRange(co2, THRESHOLDS.co2Min,  THRESHOLDS.co2Max);

  triggerAlert(suhuBahaya, humBahaya, co2Bahaya, lm35, dht, hum, co2, nanLm35, nanDht, nanHum, nanCo2);
}

function setCardStateRange(card, val, minV, maxV) {
  card.classList.remove("warn", "danger");
  const range   = maxV - minV;
  const warnGap = range * 0.1; // 10% dari range = zona kuning
  const tooLow  = val < minV;
  const tooHigh = val > maxV;
  const nearMin = val >= minV && val < minV + warnGap;
  const nearMax = val <= maxV && val > maxV - warnGap;
  if (tooLow || tooHigh)       card.classList.add("danger");
  else if (nearMin || nearMax) card.classList.add("warn");
}

function setSensorDisplay(valEl, cardEl, isNan, normalVal) {
  if (isNan) {
    valEl.textContent      = "Error";
    valEl.style.color      = "#EF4444";
    valEl.style.fontSize   = "1.4rem";
    cardEl.classList.remove("warn", "danger");
    cardEl.classList.add("sensor-nan");
  } else {
    valEl.textContent      = normalVal;
    valEl.style.color      = "";
    valEl.style.fontSize   = "";
    cardEl.classList.remove("sensor-nan");
  }
}

function setBar(el, val, min, max) {
  const pct = Math.min(100, Math.max(0, ((val - min) / (max - min)) * 100));
  el.style.width = pct + "%";
}

function setCardState(card, val, warnAt, dangerAt) {
  card.classList.remove("warn", "danger");
  if (val >= dangerAt)    card.classList.add("danger");
  else if (val >= warnAt) card.classList.add("warn");
}

// ============================================================
//  ALERT
// ============================================================
function triggerAlert(suhuBahaya, humBahaya, co2Bahaya, lm35, dht, hum, co2, nanLm35, nanDht, nanHum, nanCo2) {
  const overlay = els.alertOverlay;
  const msgs = [];

  if (!nanLm35 && isOutOfRange(lm35, THRESHOLDS.suhuMin, THRESHOLDS.suhuMax))
    msgs.push(`SUHU LM35 ${lm35 < THRESHOLDS.suhuMin ? "TERLALU RENDAH" : "TERLALU TINGGI"} (${lm35.toFixed(1)}°C)`);
  if (!nanDht && isOutOfRange(dht, THRESHOLDS.suhuMin, THRESHOLDS.suhuMax))
    msgs.push(`SUHU DHT22 ${dht < THRESHOLDS.suhuMin ? "TERLALU RENDAH" : "TERLALU TINGGI"} (${dht.toFixed(1)}°C)`);
  if (!nanHum && isOutOfRange(hum, THRESHOLDS.humMin, THRESHOLDS.humMax))
    msgs.push(`KELEMBAPAN ${hum < THRESHOLDS.humMin ? "TERLALU RENDAH" : "TERLALU TINGGI"} (${hum.toFixed(1)}%)`);
  if (!nanCo2 && isOutOfRange(co2, THRESHOLDS.co2Min, THRESHOLDS.co2Max))
    msgs.push(`CO₂ ${co2 < THRESHOLDS.co2Min ? "TERLALU RENDAH" : "BERBAHAYA"} (${Math.round(co2)} ppm)`);
  if (nanLm35) msgs.push("SENSOR LM35 TIDAK TERHUBUNG");
  if (nanDht)  msgs.push("SENSOR DHT22 TIDAK TERHUBUNG");
  if (nanHum)  msgs.push("SENSOR KELEMBAPAN TIDAK TERHUBUNG");
  if (nanCo2)  msgs.push("SENSOR MQ135 TIDAK TERHUBUNG");

  if (msgs.length > 0) {
    els.alertMsg.textContent = "⚠ " + msgs.join("  |  ");
    overlay.classList.remove("hidden");
    overlay.classList.add("blinking");
  } else {
    overlay.classList.add("hidden");
    overlay.classList.remove("blinking");
  }
}

// ============================================================
//  CHART
// ============================================================
const chartConfig = {
  lm35: { label: "Suhu LM35 (°C)",   color: "#3B82F6" },
  dht:  { label: "Suhu DHT22 (°C)",  color: "#8B5CF6" },
  hum:  { label: "Kelembapan (%)",   color: "#22C55E" },
  co2:  { label: "CO₂ MQ135 (ppm)", color: "#F59E0B" },
};

function initChart() {
  const ctx = document.getElementById("sensorChart").getContext("2d");
  sensorChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [{
        label: chartConfig.lm35.label,
        data: [],
        borderColor: chartConfig.lm35.color,
        backgroundColor: hexToRgba(chartConfig.lm35.color, 0.07),
        borderWidth: 2,
        pointRadius: 3,
        pointHoverRadius: 5,
        tension: 0.35,
        fill: true,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      plugins: {
        legend: {
          display: true,
          labels: {
            font: { family: "'Space Mono', monospace", size: 11 },
            color: "#7A8A9A",
          }
        },
        tooltip: {
          backgroundColor: "#1A2332",
          titleFont: { family: "'Space Mono', monospace", size: 11 },
          bodyFont:  { family: "'DM Sans', sans-serif", size: 12 },
          padding: 10,
          cornerRadius: 8,
        }
      },
      scales: {
        x: {
          grid: { color: "rgba(0,0,0,0.04)" },
          ticks: {
            font: { family: "'Space Mono', monospace", size: 10 },
            color: "#7A8A9A",
            maxTicksLimit: 8,
          }
        },
        y: {
          grid: { color: "rgba(0,0,0,0.04)" },
          ticks: {
            font: { family: "'Space Mono', monospace", size: 10 },
            color: "#7A8A9A",
          }
        }
      }
    }
  });
}

function updateChart() {
  if (!sensorChart) return;
  const cfg  = chartConfig[activeChartSensor];
  const data = chartData[activeChartSensor];
  sensorChart.data.labels                          = [...chartData.labels];
  sensorChart.data.datasets[0].label              = cfg.label;
  sensorChart.data.datasets[0].data               = [...data];
  sensorChart.data.datasets[0].borderColor        = cfg.color;
  sensorChart.data.datasets[0].backgroundColor    = hexToRgba(cfg.color, 0.07);
  sensorChart.update("none");
}

els.swBtns.forEach(btn => {
  btn.addEventListener("click", () => {
    els.swBtns.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeChartSensor = btn.dataset.sensor;
    updateChart();
  });
});

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ============================================================
//  TABLE RENDER
// ============================================================
function fmtVal(raw, decimals) {
  if (isSensorNaN(raw)) return '<span style="color:#EF4444;font-style:italic;font-weight:700">Error</span>';
  const n = parseFloat(raw);
  return decimals === 0 ? Math.round(n) : n.toFixed(decimals);
}

function renderTable(rows) {
  if (!rows || rows.length === 0) {
    els.tableBody.innerHTML = `<tr><td colspan="9" class="empty-row">Belum ada data.</td></tr>`;
    return;
  }
  const reversed = [...rows].reverse();
  els.tableBody.innerHTML = reversed.map((r, i) => {
    const lm35 = parseFloat(r.lm35)  || 0;
    const dht  = parseFloat(r.dht22) || 0;
    const hum  = parseFloat(r.hum)   || 0;
    const co2  = parseFloat(r.mq135) || 0;
    const isDanger = (!isSensorNaN(r.lm35)  && lm35 > THRESHOLDS.suhu)
                  || (!isSensorNaN(r.dht22) && dht  > THRESHOLDS.suhu)
                  || (!isSensorNaN(r.hum)   && hum  > THRESHOLDS.hum)
                  || (!isSensorNaN(r.mq135) && co2  > THRESHOLDS.co2);
    const rowStyle = isDanger ? 'style="background:rgba(239,68,68,0.04)"' : "";

    const wifiOk = (r.wifi||"").toLowerCase() === "connected";
    const sdOk   = (r.sd  ||"").toLowerCase() === "ready";
    const wifiTxt = wifiOk  ? "Connected"    : (r.wifi ? "Disconnected" : "N/A");
    const sdTxt   = sdOk    ? "Ready"         : (r.sd   ? "Not Ready"   : "N/A");
    const wifiColor = wifiOk ? "#22C55E" : "#EF4444";
    const sdColor   = sdOk   ? "#22C55E" : "#EF4444";

    return `<tr ${rowStyle}>
      <td>${rows.length - i}</td>
      <td>${r.tanggal || "N/A"}</td>
      <td>${r.waktu   || "N/A"}</td>
      <td>${fmtVal(r.lm35,  1)}</td>
      <td>${fmtVal(r.dht22, 1)}</td>
      <td>${fmtVal(r.hum,   1)}</td>
      <td>${fmtVal(r.mq135, 0)}</td>
      <td><span style="color:${wifiColor};font-weight:700">${wifiTxt}</span></td>
      <td><span style="color:${sdColor};font-weight:700">${sdTxt}</span></td>
    </tr>`;
  }).join("");
}

// ============================================================
//  BUKA GOOGLE SPREADSHEET
// ============================================================
const SPREADSHEET_URL = "https://docs.google.com/spreadsheets/d/1uL2Yz_IilXGDTbYcOIz9y1fQaUsF1heuZeX6NQEdEw8/edit?gid=0#gid=0";

els.downloadBtn.addEventListener("click", () => {
  window.open(SPREADSHEET_URL, "_blank");
});

// ============================================================
//  LOGGING CONTROL
// ============================================================
els.loggingToggle.addEventListener("change", () => {
  loggingActive = els.loggingToggle.checked;
  if (loggingActive) {
    els.loggingLabel.textContent = "LOGGING AKTIF";
    els.loggingLabel.classList.remove("stopped");
    startFetchLoop();
  } else {
    els.loggingLabel.textContent = "LOGGING BERHENTI";
    els.loggingLabel.classList.add("stopped");
    stopFetchLoop();
    setLiveStatus(false);
  }
});

els.applyBtn.addEventListener("click", () => {
  const val = parseInt(els.intervalInput.value);
  if (isNaN(val) || val < 5) { alert("Interval minimal 5 detik."); return; }
  fetchIntervalMs = val * 1000;
  if (loggingActive) { stopFetchLoop(); startFetchLoop(); }
  els.applyBtn.textContent = "✓ Diterapkan";
  setTimeout(() => els.applyBtn.textContent = "Terapkan", 2000);
});

// ============================================================
//  FETCH LOOP
// ============================================================
function startFetchLoop() {
  // Langsung set LIVE saat logging dinyalakan, sebelum fetch selesai
  setLiveStatus(true, "LIVE");
  fetchData();
  fetchTimer = setInterval(fetchData, fetchIntervalMs);
}

function stopFetchLoop() {
  clearInterval(fetchTimer);
  fetchTimer = null;
  setLiveStatus(false);
}

// ============================================================
//  INIT
// ============================================================
initChart();
startFetchLoop();

// ============================================================
//  SNOW ANIMATION
// ============================================================
(function initSnow() {
  const canvas = document.getElementById("snowCanvas");
  const ctx    = canvas.getContext("2d");
  let W = window.innerWidth;
  let H = window.innerHeight;
  canvas.width  = W;
  canvas.height = H;

  window.addEventListener("resize", () => {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
    flakes.forEach(f => { f.x = Math.random() * W; });
  });

  const FLAKE_COUNT = 90;
  const flakes = Array.from({ length: FLAKE_COUNT }, () => makeFlake());

  function makeFlake() {
    return {
      x:      Math.random() * W,
      y:      Math.random() * H,
      r:      1.2 + Math.random() * 3.2,
      speed:  0.5 + Math.random() * 1.4,
      drift:  (Math.random() - 0.5) * 0.4,
      opacity: 0.25 + Math.random() * 0.45,
      wobble: Math.random() * Math.PI * 2,
      wobbleSpeed: 0.008 + Math.random() * 0.012,
    };
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    flakes.forEach(f => {
      f.wobble += f.wobbleSpeed;
      f.x += f.drift + Math.sin(f.wobble) * 0.3;
      f.y += f.speed;

      if (f.y > H + 10) {
        f.y = -10;
        f.x = Math.random() * W;
      }
      if (f.x > W + 10) f.x = -10;
      if (f.x < -10)    f.x = W + 10;

      // Snowflake shape — soft circle with slight glow
      const grad = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r);
      grad.addColorStop(0, `rgba(147, 197, 253, ${f.opacity})`);       // blue-200
      grad.addColorStop(0.6, `rgba(96, 165, 250, ${f.opacity * 0.7})`); // blue-400
      grad.addColorStop(1,   `rgba(59, 130, 246, 0)`);                   // fade

      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
    });
    requestAnimationFrame(draw);
  }

  draw();
})();