// Parking Tracker website. Talks to Supabase's REST API directly with fetch (no libraries).
// Re-reads the spots every 3 s, so the page follows the ESP32 or the camera without reloading.
//
// Reservation check:
//   Model lot (A1-A4, ESP32):  booking gives a 6-digit OTP; after parking, type it in "Verify your arrival".
//   Car park  (P1-P3, camera): booking needs a plate; the camera reads the plate and compares.

const { SUPABASE_URL, SUPABASE_KEY } = window.PARKING_CONFIG;
const API = SUPABASE_URL.replace(/\/+$/, "").replace(/\/rest\/v1$/, "") + "/rest/v1";
const HEADERS = { apikey: SUPABASE_KEY, "Content-Type": "application/json" };
const OFFLINE_AFTER_S = 90;   // no report for 90 s = sensor/camera offline
const REFRESH_MS = 3000;

const LOT = new URLSearchParams(location.search).get("lot") === "real" ? "real" : "model";
const USES_OTP = LOT === "model";
let spots = [];
let bookings = [];

const $ = (id) => document.getElementById(id);

// "Today" in Thailand, as YYYY-MM-DD (the database uses the same rule)
function todayBangkok() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
}

// Show only the start and end of a plate: กข1234 -> กข••34
function maskPlate(p) {
  const s = (p || "").replace(/\s+/g, "");
  return s.length <= 4 ? s : s.slice(0, 2) + "•".repeat(s.length - 4) + s.slice(-2);
}

async function api(path, options = {}) {
  const r = await fetch(API + path, { ...options, headers: { ...HEADERS, ...(options.headers || {}) } });
  if (!r.ok) {
    let body = {};
    try { body = await r.json(); } catch (_) {}
    const err = new Error(body.message || `HTTP ${r.status}`);
    err.code = body.code;
    throw err;
  }
  return r.status === 204 ? null : r.json();
}

const rpc = (name, body) => api("/rpc/" + name, { method: "POST", body: JSON.stringify(body) });

// Booked today and not yet verified with its OTP -> counts as reserved
function openBookingsToday() {
  const today = todayBangkok();
  return new Set(bookings.filter((b) => b.date === today && !b.verified_at).map((b) => b.spot_id));
}

function spotState(s, reservedToday) {
  const age = s.last_seen ? (Date.now() - new Date(s.last_seen)) / 1000 : Infinity;
  if (age > OFFLINE_AFTER_S) return "offline";
  if (s.occupied) {
    if (USES_OTP && reservedToday.has(s.id)) return "waiting";
    return s.plate_status === "mismatch" ? "mismatch" : "occupied";
  }
  return reservedToday.has(s.id) ? "reserved" : "free";
}

const STATE_TEXT = {
  free: "Free", reserved: "Reserved", waiting: "Waiting for OTP", occupied: "Occupied",
  mismatch: "Wrong car", offline: "Offline",
};

function render() {
  const today = todayBangkok();
  const reservedToday = openBookingsToday();
  const verifiedToday = new Set(bookings.filter((b) => b.date === today && b.verified_at).map((b) => b.spot_id));
  let free = 0;

  $("spots").innerHTML = "";
  for (const s of spots) {
    const state = spotState(s, reservedToday);
    if (state === "free") free++;
    const el = document.createElement("article");
    el.className = "spot " + state;
    el.innerHTML = `<div class="label"></div><div class="state"></div>`;
    el.querySelector(".label").textContent = s.label;
    el.querySelector(".state").textContent = STATE_TEXT[state];
    const info = document.createElement("div");
    info.className = "plate";
    if (state === "occupied" && USES_OTP && verifiedToday.has(s.id)) {
      info.append(badge("verified", "OTP verified"));
    }
    if (!USES_OTP && s.occupied && state !== "offline") {
      if (s.plate_seen) info.append("Plate " + maskPlate(s.plate_seen));
      if (s.plate_status) info.append(badge(s.plate_status, s.plate_status.replace("-", " ")));
    }
    if (info.childNodes.length) el.append(info);
    $("spots").append(el);
  }
  $("free-count").textContent = `${free} / ${spots.length}`;
  $("updated").textContent = new Date().toLocaleTimeString();

  // Bookings list (this lot, today and later)
  const ids = new Set(spots.map((s) => s.id));
  const label = Object.fromEntries(spots.map((s) => [s.id, s.label]));
  const mine = bookings.filter((b) => ids.has(b.spot_id));
  const list = $("bookings");
  list.innerHTML = "";
  if (!mine.length) list.innerHTML = `<li class="muted">None</li>`;
  for (const b of mine) {
    const li = document.createElement("li");
    const who = USES_OTP ? (b.verified_at ? "verified" : "OTP booking") : maskPlate(b.plate);
    li.append(`${b.date === today ? "Today" : b.date} · ${label[b.spot_id]} · ${who}`);
    if (!b.verified_at) {
      const btn = document.createElement("button");
      btn.className = "small";
      btn.textContent = "Cancel";
      btn.onclick = () => cancelBooking(b);
      li.append(btn);
    }
    list.append(li);
  }
}

function badge(cls, text) {
  const b = document.createElement("span");
  b.className = "badge " + cls;
  b.textContent = text;
  return b;
}

async function refresh() {
  try {
    const today = todayBangkok();
    [spots, bookings] = await Promise.all([
      api(`/spots?select=*&lot=eq.${LOT}&order=id`),
      api(`/reservations?select=id,spot_id,date,plate,verified_at&date=gte.${today}&order=date,spot_id`),
    ]);
    $("error").hidden = true;
    fillSpotSelects();
    render();
  } catch (e) {
    $("error").textContent = "Cannot reach the database: " + e.message;
    $("error").hidden = false;
  }
}

function fillSpotSelects() {
  for (const sel of [$("r-spot"), $("v-spot")]) {
    if (sel.options.length === spots.length) continue;   // keep the user's choice between refreshes
    sel.innerHTML = "";
    for (const s of spots) sel.add(new Option(s.label, s.id));
  }
}

async function reserve(ev) {
  ev.preventDefault();
  const msg = $("r-msg");
  const spotName = $("r-spot").selectedOptions[0].text;
  const body = { p_spot: Number($("r-spot").value), p_date: $("r-date").value };
  if (!USES_OTP) body.p_plate = $("r-plate").value.trim();
  msg.className = "msg";
  msg.textContent = "Saving…";
  $("r-otp").hidden = true;
  try {
    const res = await rpc("make_reservation", body);
    msg.className = "msg ok";
    msg.textContent = `Reserved ${spotName} on ${body.p_date}.`;
    if (res && res.otp) {
      $("r-otp").hidden = false;
      $("r-otp-code").textContent = res.otp;
      $("v-spot").value = body.p_spot;
    }
    $("r-plate").value = "";
    refresh();
  } catch (e) {
    msg.className = "msg bad";
    msg.textContent =
      e.code === "23505" ? "That spot is already booked for that date. Pick another spot or date."
      : e.code === "23514" ? "Please type a plate of 2–20 characters."
      : e.message;
  }
}

const VERIFY_TEXT = {
  verified: ["ok", "Verified! The spot is now yours (red)."],
  "no-car": ["bad", "No car detected in that spot yet. Park first, then verify."],
  "no-booking": ["bad", "That spot has no booking today."],
  "no-otp": ["bad", "That spot is checked by camera, not OTP."],
  locked: ["bad", "Too many wrong tries. Cancel and book again."],
};

async function verify(ev) {
  ev.preventDefault();
  const msg = $("v-msg");
  msg.className = "msg";
  msg.textContent = "Checking…";
  try {
    const res = await rpc("verify_otp", { p_spot: Number($("v-spot").value), p_otp: $("v-otp").value });
    const [cls, text] = res.result === "wrong"
      ? ["bad", `Wrong OTP. ${res.left} tries left.`]
      : VERIFY_TEXT[res.result] || ["bad", res.result];
    msg.className = "msg " + cls;
    msg.textContent = text;
    if (res.result === "verified") $("v-otp").value = "";
    refresh();
  } catch (e) {
    msg.className = "msg bad";
    msg.textContent = "Could not check: " + e.message;
  }
}

async function cancelBooking(b) {
  const what = USES_OTP ? "its 6-digit OTP" : "its full license plate";
  const code = prompt(`To cancel this booking, type ${what}:`);
  if (!code) return;
  try {
    const ok = await rpc("cancel_reservation", { p_id: b.id, p_plate: code });
    alert(ok ? "Booking cancelled." : `That does not match this booking.`);
    refresh();
  } catch (e) {
    alert("Could not cancel: " + e.message);
  }
}

function init() {
  document.querySelectorAll("#lots a").forEach((a) => a.classList.toggle("active", a.dataset.lot === LOT));
  document.body.classList.add(USES_OTP ? "lot-model" : "lot-real");
  $("r-plate").required = !USES_OTP;
  const today = todayBangkok();
  $("r-date").value = today;
  $("r-date").min = today;
  $("reserve").addEventListener("submit", reserve);
  $("verify").addEventListener("submit", verify);
  if (SUPABASE_URL.includes("YOUR-PROJECT") || SUPABASE_KEY.includes("REPLACE_ME")) {
    $("setup-warning").hidden = false;
    return;
  }
  refresh();
  setInterval(refresh, REFRESH_MS);
}

init();
