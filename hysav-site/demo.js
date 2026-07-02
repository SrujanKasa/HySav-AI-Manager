/* ============================================================
   HySav — interactive dashboard demo (self-contained mock data)
   Fictional company: Otterworks (6-person startup)
   Rename: find & replace "HySav"
   ============================================================ */

var MEMBERS = {
  MK: { name: "Maya Kern",   role: "Founder / CEO", color: "#E4570F" },
  DO: { name: "Dev Osei",    role: "Engineering",   color: "#1E8F63" },
  SR: { name: "Sam Ruiz",    role: "Design",        color: "#6B5CD6" },
  PN: { name: "Priya Nair",  role: "Marketing",     color: "#C98A1B" },
  JW: { name: "Jonas Weber", role: "Engineering",   color: "#2B7DB8" },
  TO: { name: "Tess Okafor", role: "Ops",           color: "#CE4141" }
};

var TOOLS = [
  {
    id: "chatgpt", name: "ChatGPT Team", plan: "Team · 7 seats", cost: 175,
    logo: "C", color: "#10A37F", usage: 82, unit: "messages quota",
    resetsIn: 12, status: "healthy",
    note: "Solid usage across every seat. Nothing to do here — enjoy a tool that's earning its keep.",
    users: ["MK", "DO", "SR", "PN", "JW", "TO"], idle: [], wasted: 0
  },
  {
    id: "claude", name: "Claude Team", plan: "Team · 6 seats", cost: 150,
    logo: "Cl", color: "#C96442", usage: 88, unit: "usage allowance",
    resetsIn: 12, status: "healthy",
    note: "Heaviest-used tool in the stack. Engineering and marketing both live in it.",
    users: ["MK", "DO", "PN", "JW"], idle: [], wasted: 0
  },
  {
    id: "cursor", name: "Cursor", plan: "Pro · 4 seats", cost: 160,
    logo: "Cu", color: "#1D1B16", usage: 62, unit: "fast-request credits",
    resetsIn: 9, status: "healthy",
    note: "62% of fast-request credits used with 9 days left in the cycle. On pace — no waste expected.",
    users: ["DO", "JW", "MK"], idle: [], wasted: 0
  },
  {
    id: "midjourney", name: "Midjourney", plan: "Standard · 2 seats", cost: 60,
    logo: "M", color: "#5865F2", usage: 11, unit: "GPU hours",
    resetsIn: 17, status: "waste",
    note: "No images generated in 26 days. Both seats renew July 19. If the brand refresh is done, this is a cancel.",
    users: ["SR", "PN"], idle: ["PN"], wasted: 53
  },
  {
    id: "perplexity", name: "Perplexity Pro", plan: "Pro · 3 seats", cost: 60,
    logo: "P", color: "#20808D", usage: 41, unit: "pro searches",
    resetsIn: 21, status: "under",
    note: "Two seats active, one fully idle. Tess hasn't run a search in 31 days — drop to 2 seats and save $20/mo.",
    users: ["MK", "PN", "TO"], idle: ["TO"], wasted: 20
  },
  {
    id: "jasper", name: "Jasper", plan: "Creator · 1 seat", cost: 59,
    logo: "J", color: "#8B3DFF", usage: 9, unit: "word credits",
    resetsIn: 5, status: "dup",
    note: "Priya's seat. 78% feature overlap with Copy.ai (Sam's seat). Pick one, save the other's full cost.",
    users: ["PN"], idle: [], wasted: 54
  },
  {
    id: "copyai", name: "Copy.ai", plan: "Pro · 1 seat", cost: 49,
    logo: "Co", color: "#2D42FF", usage: 24, unit: "word credits",
    resetsIn: 14, status: "dup",
    note: "Sam's seat. Overlaps heavily with Jasper. Whichever the team prefers, one of these should go.",
    users: ["SR"], idle: [], wasted: 0
  },
  {
    id: "elevenlabs", name: "ElevenLabs", plan: "Creator · 1 seat", cost: 22,
    logo: "E", color: "#1D1B16", usage: 93, unit: "character quota",
    resetsIn: 22, status: "healthy",
    note: "93% of character quota used with 22 days left. Heads up: at this pace you'll hit the cap around July 24. The next tier is +$22/mo — cheaper than overage.",
    users: ["PN"], idle: [], wasted: 0
  },
  {
    id: "notion", name: "Notion AI", plan: "Add-on · 6 seats", cost: 60,
    logo: "N", color: "#37352F", usage: 47, unit: "AI responses",
    resetsIn: 12, status: "under",
    note: "Half the team uses it weekly, half never touched it. Worth a quick ask before renewal.",
    users: ["MK", "DO", "SR", "PN", "JW", "TO"], idle: ["JW", "TO"], wasted: 33
  },
  {
    id: "runway", name: "Runway", plan: "Pro · 1 seat", cost: 76,
    logo: "R", color: "#E0447C", usage: 6, unit: "generation credits",
    resetsIn: 3, status: "waste",
    note: "Free trial auto-converted to paid on May 30. Two videos rendered since. Renews again in 3 days — this is the classic forgotten trial.",
    users: ["SR"], idle: [], wasted: 71
  },
  {
    id: "gamma", name: "Gamma", plan: "Plus · 2 seats", cost: 40,
    logo: "G", color: "#7B48F5", usage: 18, unit: "AI credits",
    resetsIn: 25, status: "under",
    note: "Bought for the fundraise deck in April. Barely opened since. Pause until the next raise?",
    users: ["MK", "TO"], idle: [], wasted: 33
  }
];

var ALERTS = [
  {
    id: "a1", sev: "red", ico: "flame",
    html: "<strong>Runway renews in 3 days ($76).</strong> Trial auto-converted May 30 — two videos rendered since. Cancel or keep?"
  },
  {
    id: "a2", sev: "amber", ico: "hourglass",
    html: "<strong>Midjourney is idle.</strong> No images generated in 26 days. Both seats renew July 19 ($60)."
  },
  {
    id: "a3", sev: "amber", ico: "copy",
    html: "<strong>Duplicate tools detected.</strong> Jasper (Priya) and Copy.ai (Sam) overlap on ~78% of features — $108/mo combined."
  },
  {
    id: "a4", sev: "info", ico: "trending-up",
    html: "<strong>ElevenLabs will hit its cap ~July 24.</strong> Upgrading now (+$22/mo) is cheaper than overage. Good problem to have."
  }
];

var STATUS_META = {
  healthy: { label: "Healthy",     cls: "b-healthy", ring: "#1E8F63" },
  under:   { label: "Underused",   cls: "b-under",   ring: "#C98A1B" },
  waste:   { label: "Waste risk",  cls: "b-waste",   ring: "#CE4141" },
  dup:     { label: "Duplicate",   cls: "b-dup",     ring: "#6B5CD6" }
};

var state = { filter: "all", sort: "cost", cancelled: {}, tab: "overview" };

function fmt(n) { return "$" + n.toLocaleString("en-US"); }

/* ---------- summary stats ---------- */
function renderStats() {
  var active = TOOLS.filter(function (t) { return !state.cancelled[t.id]; });
  var total = active.reduce(function (s, t) { return s + t.cost; }, 0);
  var wasted = active.reduce(function (s, t) { return s + t.wasted; }, 0);
  var wasteTools = active.filter(function (t) { return t.wasted > 0; }).length;
  var soon = active.filter(function (t) { return t.resetsIn <= 7; }).length;

  document.getElementById("st-spend").textContent = fmt(total);
  document.getElementById("st-tools").textContent = active.length;
  document.getElementById("st-waste").textContent = fmt(wasted);
  document.getElementById("st-waste-sub").textContent = "across " + wasteTools + " tools this month";
  document.getElementById("st-renew").textContent = soon;
}

/* ---------- usage ring (SVG) ---------- */
function ringSVG(pct, color) {
  var r = 26, c = 2 * Math.PI * r;
  var off = c * (1 - pct / 100);
  return '<svg width="64" height="64" viewBox="0 0 64 64">' +
    '<circle class="ring-track" cx="32" cy="32" r="' + r + '" fill="none" stroke-width="7"/>' +
    '<circle class="ring-val" cx="32" cy="32" r="' + r + '" fill="none" stroke="' + color +
    '" stroke-width="7" stroke-dasharray="' + c + '" stroke-dashoffset="' + c + '" data-off="' + off + '"/>' +
    '<text x="32" y="37" text-anchor="middle">' + pct + '%</text></svg>';
}

/* ---------- tool cards ---------- */
function toolCard(t) {
  var meta = STATUS_META[t.status];
  var cancelled = !!state.cancelled[t.id];
  var users = t.users.map(function (u) {
    var m = MEMBERS[u];
    var idle = t.idle.indexOf(u) !== -1;
    return '<span class="t-user' + (idle ? " idle" : "") + '">' +
      '<span class="av" style="background:' + m.color + '">' + u + "</span>" +
      m.name.split(" ")[0] + (idle ? " · idle 30d+" : "") + "</span>";
  }).join("");

  return '<div class="tool-card' + (cancelled ? " cancelled" : "") + '" data-id="' + t.id + '">' +
    '<div class="t-top">' +
      '<span class="t-logo" style="background:' + t.color + '">' + t.logo + "</span>" +
      '<span class="t-id"><span class="t-name">' + t.name + '</span><br/>' +
      '<span class="t-plan">' + t.plan + "</span></span>" +
      '<span class="t-cost"><span class="c">' + fmt(t.cost) + '</span><br/><span class="per">/month</span></span>' +
    "</div>" +
    '<div class="t-usage">' +
      '<span class="ring">' + ringSVG(t.usage, meta.ring) + "</span>" +
      '<span class="t-usage-meta">' + t.usage + "% of " + t.unit + " used" +
      '<br/><span class="reset">Resets in ' + t.resetsIn + ' days</span>' +
      '<br/><span class="t-badge ' + meta.cls + '">' +
      (cancelled ? "Marked to cancel" : meta.label) + "</span></span>" +
    "</div>" +
    '<div class="t-detail">' +
      '<div class="t-note">' + t.note + "</div>" +
      '<div class="t-users">' + users + "</div>" +
      '<div class="t-actions">' +
        (cancelled
          ? '<button class="btn btn-sm undo" data-act="undo">Undo — keep this tool</button>'
          : '<button class="btn btn-sm danger" data-act="cancel">Mark for cancellation</button>' +
            '<button class="btn btn-sm btn-ghost" data-act="remind">Remind me before renewal</button>') +
      "</div>" +
    "</div></div>";
}

function renderTools() {
  var list = TOOLS.slice();

  if (state.filter !== "all") {
    list = list.filter(function (t) { return t.status === state.filter; });
  }
  if (state.sort === "cost") list.sort(function (a, b) { return b.cost - a.cost; });
  if (state.sort === "usage") list.sort(function (a, b) { return a.usage - b.usage; });
  if (state.sort === "waste") list.sort(function (a, b) { return b.wasted - a.wasted; });
  if (state.sort === "renewal") list.sort(function (a, b) { return a.resetsIn - b.resetsIn; });

  var openIds = Array.from(document.querySelectorAll(".tool-card.open"))
    .map(function (el) { return el.getAttribute("data-id"); });

  document.getElementById("tool-grid").innerHTML = list.map(toolCard).join("");

  openIds.forEach(function (id) {
    var el = document.querySelector('.tool-card[data-id="' + id + '"]');
    if (el) el.classList.add("open");
  });

  // animate rings in
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      document.querySelectorAll(".ring-val").forEach(function (c) {
        c.style.strokeDashoffset = c.getAttribute("data-off");
      });
    });
  });
}

/* ---------- team view ---------- */
function renderTeam() {
  var dupTools = { jasper: true, copyai: true };
  var rows = Object.keys(MEMBERS).map(function (key) {
    var m = MEMBERS[key];
    var mine = TOOLS.filter(function (t) {
      return t.users.indexOf(key) !== -1 && !state.cancelled[t.id];
    });
    var cost = mine.reduce(function (s, t) { return s + Math.round(t.cost / t.users.length); }, 0);
    var chips = mine.map(function (t) {
      var idle = t.idle.indexOf(key) !== -1;
      return '<span class="m-tool' + (dupTools[t.id] ? " overlap" : "") + '">' +
        t.name + (idle ? " · idle" : "") + (dupTools[t.id] ? " ⚠" : "") + "</span>";
    }).join("");
    return '<div class="member-card">' +
      '<span class="av" style="background:' + m.color + '">' + key + "</span>" +
      '<span class="m-id"><span class="m-name">' + m.name + '</span><br/><span class="m-role">' + m.role + "</span></span>" +
      '<span class="m-tools">' + chips + "</span>" +
      '<span class="m-cost">' + fmt(cost) + '<span class="per">est. share /mo</span></span>' +
      "</div>";
  }).join("");
  document.getElementById("team-list").innerHTML = rows;
}

/* ---------- alerts ---------- */
function renderAlerts() {
  var wrap = document.getElementById("alerts");
  wrap.innerHTML = ALERTS.map(function (a) {
    return '<div class="alert sev-' + a.sev + '" data-id="' + a.id + '">' +
      '<span class="a-ico"><i data-lucide="' + a.ico + '"></i></span>' +
      '<span class="a-txt">' + a.html + "</span>" +
      '<button class="a-dismiss" title="Dismiss" aria-label="Dismiss alert">✕</button></div>';
  }).join("");
  if (window.lucide) window.lucide.createIcons();
}

/* ---------- savings ticker ---------- */
function renderSavings() {
  var saved = TOOLS.reduce(function (s, t) {
    return s + (state.cancelled[t.id] ? t.cost : 0);
  }, 0);
  var bar = document.getElementById("savings-bar");
  document.getElementById("savings-val").textContent = fmt(saved) + "/mo";
  bar.classList.toggle("show", saved > 0);
}

/* ---------- events ---------- */
document.addEventListener("click", function (e) {
  // dismiss alert
  var dis = e.target.closest(".a-dismiss");
  if (dis) {
    var al = dis.closest(".alert");
    al.classList.add("bye");
    setTimeout(function () { al.remove(); }, 300);
    return;
  }

  // tool card actions
  var actBtn = e.target.closest("[data-act]");
  if (actBtn) {
    var card = actBtn.closest(".tool-card");
    var id = card.getAttribute("data-id");
    var act = actBtn.getAttribute("data-act");
    if (act === "cancel") state.cancelled[id] = true;
    if (act === "undo") delete state.cancelled[id];
    if (act === "remind") {
      actBtn.textContent = "✓ Reminder set";
      actBtn.disabled = true;
      return;
    }
    renderTools(); renderStats(); renderSavings(); renderTeam();
    return;
  }

  // expand / collapse card
  var tcard = e.target.closest(".tool-card");
  if (tcard) { tcard.classList.toggle("open"); return; }

  // tabs
  var tab = e.target.closest(".demo-tab");
  if (tab) {
    state.tab = tab.getAttribute("data-tab");
    document.querySelectorAll(".demo-tab").forEach(function (b) {
      b.classList.toggle("on", b === tab);
    });
    document.getElementById("view-overview").style.display = state.tab === "overview" ? "" : "none";
    document.getElementById("view-team").style.display = state.tab === "team" ? "" : "none";
    return;
  }

  // filter chips
  var chip = e.target.closest(".fchip");
  if (chip) {
    state.filter = chip.getAttribute("data-f");
    document.querySelectorAll(".fchip").forEach(function (c) {
      c.classList.toggle("on", c === chip);
    });
    renderTools();
  }
});

document.getElementById("sort-select").addEventListener("change", function (e) {
  state.sort = e.target.value;
  renderTools();
});

/* ---------- embed mode (hide chrome inside iframe) ---------- */
if (location.search.indexOf("embed=1") !== -1) {
  document.body.classList.add("embedded");
  var tb = document.querySelector(".demo-topbar");
  if (tb) tb.style.display = "none";
  var ret = document.querySelector(".demo-return");
  if (ret) ret.style.display = "none";
}

/* ---------- init ---------- */
renderAlerts();
renderStats();
renderTools();
renderTeam();
renderSavings();
