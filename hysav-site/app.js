/* HySav — the real logged-in dashboard (dashboard.html).
   Everything renders from the workspace's own data via the API:
   tools + computed waste (/workspaces/:id/dashboard + /tools), team
   (/workspaces/:id + invites + member management), settings (notification
   prefs + integrations), and the plan banner (trial / subscribe / active).
   Requires auth.js + billing.js. */
(function () {
  "use strict";

  /* Google OAuth drops the session token in the URL fragment — capture it
     before the auth gate runs (fragments never reach any server). */
  var hashTok = location.hash.match(/token=([^&]+)/);
  if (hashTok) {
    HySav.setToken(hashTok[1]);
    history.replaceState(null, "", location.pathname);
  }
  if (!HySav.token()) { window.location.href = "login.html"; return; }

  /* ---------- state ---------- */
  var S = {
    user: null, ws: null, role: "member",
    tools: [], dash: null, members: [], billing: null,
    catalog: [], filter: "all", editingToolId: null,
  };

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function rupees(n) { return "₹" + Math.round(n).toLocaleString("en-IN"); }

  /* ---------- plan banner + 402 handling ---------- */
  function showBanner(html, tone) {
    var b = $("plan-banner");
    b.className = "plan-banner " + (tone || "info");
    b.innerHTML = html;
    b.style.display = "";
  }
  function renderPlanBanner() {
    var b = S.billing;
    if (!b) return;
    var amount = rupees(b.quote.amountPaise / 100);
    if (b.paidUntil && b.active && b.reasonPaid !== false && b.paidUntil > new Date().toISOString()) {
      $("plan-banner").style.display = "none"; // paid — stay out of the way
      return;
    }
    if (b.trial && b.trial.active) {
      var daysLeft = Math.max(1, Math.ceil((new Date(b.trial.endsAt) - Date.now()) / 86400000));
      showBanner(
        "Free trial — <strong>" + daysLeft + " day" + (daysLeft > 1 ? "s" : "") + " left</strong>. " +
        "Everything works; subscribe to keep it that way. " +
        (b.configured ? '<button class="btn btn-primary btn-sm" id="banner-pay">Subscribe — ' + amount + "/mo</button>"
                      : '<span class="muted">Payments are being switched on — check back shortly.</span>'),
        "warn",
      );
    } else {
      showBanner(
        "<strong>Your trial has ended.</strong> Your data is safe and readable — subscribe to keep adding tools and tracking usage. " +
        (b.configured ? '<button class="btn btn-primary btn-sm" id="banner-pay">Subscribe — ' + amount + "/mo</button>"
                      : '<span class="muted">Payments are being switched on — check back shortly.</span>'),
        "bad",
      );
    }
    var pay = $("banner-pay");
    if (pay) pay.addEventListener("click", startSubscribe);
  }
  function startSubscribe() {
    var pay = $("banner-pay");
    if (pay) { pay.disabled = true; pay.textContent = "Opening secure checkout…"; }
    HySavBilling.startCheckout({
      workspaceId: S.ws.id,
      onSuccess: function () {
        showBanner("🎉 <strong>Payment confirmed — you're in.</strong> The whole product is yours; this banner will get out of your way now.", "ok");
        setTimeout(function () { $("plan-banner").style.display = "none"; }, 6000);
        HySav.api("/workspaces/" + S.ws.id + "/billing").then(function (b) { S.billing = b; });
      },
      onError: function (msg) { showBanner("Payment didn't complete: " + esc(msg) + " — nothing was charged. Try again whenever.", "bad"); renderRetry(); },
      onDismiss: function () { renderPlanBanner(); },
    }).catch(function (e) {
      showBanner(esc(e.message), "bad");
      renderRetry();
    });
    function renderRetry() {
      var again = document.createElement("button");
      again.className = "btn btn-primary btn-sm";
      again.textContent = "Try again";
      again.addEventListener("click", startSubscribe);
      $("plan-banner").appendChild(again);
    }
  }
  /* any write that comes back 402 lands here */
  function handleWriteError(e) {
    if (e.status === 402) { renderPlanBanner(); showBanner(esc(e.message), "bad"); window.scrollTo({ top: 0, behavior: "smooth" }); }
    else alert(e.message);
  }

  /* ---------- stats + alerts ---------- */
  function renderStats() {
    var spend = 0, wasted = 0, renewSoon = 0;
    (S.dash.tools || []).forEach(function (t) {
      spend += t.cost; wasted += t.wasted || 0;
      if (t.resetsIn <= 7) renewSoon++;
    });
    var active = S.tools.filter(function (t) { return t.status !== "cancelled"; }).length;
    $("st-spend").textContent = rupees(spend);
    $("st-spend-sub").textContent = active + " tools · " + S.members.length + " people";
    $("st-tools").textContent = active;
    $("st-waste").textContent = rupees(wasted);
    $("st-renew").textContent = renewSoon;
  }
  function renderAlerts() {
    $("alerts").innerHTML = (S.dash.alerts || []).map(function (a) {
      return '<div class="alert sev-' + esc(a.sev) + '">' +
        '<span class="a-ico"><i data-lucide="' + esc(a.ico) + '"></i></span>' +
        '<span class="a-txt">' + a.html + "</span></div>"; /* a.html is backend-escaped */
    }).join("");
    if (window.lucide) window.lucide.createIcons();
  }

  /* ---------- tools ---------- */
  function ringSVG(pct, color) {
    var r = 26, c = 2 * Math.PI * r;
    return '<svg width="64" height="64" viewBox="0 0 64 64">' +
      '<circle class="ring-track" cx="32" cy="32" r="' + r + '" fill="none" stroke-width="7"/>' +
      '<circle class="ring-val" cx="32" cy="32" r="' + r + '" fill="none" stroke="' + color +
      '" stroke-width="7" stroke-dasharray="' + c + '" stroke-dashoffset="' + (c * (1 - pct / 100)) + '"/>' +
      '<text x="32" y="37" text-anchor="middle">' + Math.round(pct) + "%</text></svg>";
  }
  var STATUS_META = {
    healthy: { label: "Healthy", cls: "b-healthy", ring: "#1E8F63" },
    under: { label: "Underused", cls: "b-under", ring: "#C98A1B" },
    waste: { label: "Waste risk", cls: "b-waste", ring: "#CE4141" },
    dup: { label: "Duplicate", cls: "b-dup", ring: "#6B5CD6" },
  };
  function dashInfo(toolId) {
    return (S.dash.tools || []).find(function (d) { return d.toolId === toolId; }) || null;
  }
  function memberByUserId(uid) {
    return S.members.find(function (m) { return m.id === uid; });
  }

  function toolCard(t) {
    var info = dashInfo(t.id);
    var cancelled = t.status === "cancelled";
    var meta = info ? STATUS_META[info.status] : null;
    var monthly = t.billingCycle === "annual" ? t.costCents / 12 : t.costCents;
    var users = (t.members || []).map(function (m) {
      var mem = memberByUserId(m.userId);
      return mem ? '<span class="t-user"><span class="av" style="background:' + esc(mem.color) + '">' + esc(mem.initials) + "</span>" + esc(mem.name.split(" ")[0]) + "</span>" : "";
    }).join("");

    return '<div class="tool-card' + (cancelled ? " cancelled" : "") + '" data-id="' + esc(t.id) + '">' +
      '<div class="t-top">' +
        '<span class="t-logo"><img src="assets/logos/' + esc(t.slug) + '.png" alt="" onerror="this.parentElement.textContent=\'' + esc((t.name[0] || "?").toUpperCase()) + '\'"/></span>' +
        '<span class="t-id"><span class="t-name">' + esc(t.name) + '</span><br/><span class="t-plan">' + esc(t.plan || t.category) +
          (t.usageSource && t.usageSource !== "manual" ? ' <span class="auto-tag" title="Usage updates automatically via ' + esc(t.usageSource) + '">⚡ auto</span>' : "") +
        "</span></span>" +
        '<span class="t-cost"><span class="c">' + rupees(monthly / 100) + '</span><br/><span class="per">/month</span></span>' +
      "</div>" +
      (info && !cancelled
        ? '<div class="t-usage">' +
            '<span class="ring">' + ringSVG(info.usage, meta.ring) + "</span>" +
            '<span class="t-usage-meta">' + info.usage + "% of " + esc(info.unit) + " used" +
            '<br/><span class="reset">Renews in ' + info.resetsIn + ' days</span>' +
            '<br/><span class="t-badge ' + meta.cls + '">' + meta.label + "</span></span>" +
          "</div>"
        : '<div class="t-usage"><span class="t-usage-meta muted">' + (cancelled ? "Marked cancelled." : "No usage reported yet — add a reading below.") + "</span></div>") +
      '<div class="t-detail">' +
        (info && info.note ? '<div class="t-note">' + esc(info.note) + "</div>" : "") +
        '<div class="t-users">' + users + "</div>" +
        '<div class="t-actions">' +
          (S.role !== "admin"
            ? (cancelled ? "" : '<button class="btn btn-sm btn-ghost" data-act="usage">Report usage</button>')
            : cancelled
              ? '<button class="btn btn-sm undo" data-act="restore">Restore</button>' +
                '<button class="btn btn-sm danger" data-act="delete">Delete permanently</button>'
              : '<button class="btn btn-sm btn-ghost" data-act="usage">Report usage</button>' +
                '<button class="btn btn-sm btn-ghost" data-act="edit">Edit</button>' +
                '<button class="btn btn-sm danger" data-act="cancel">Mark cancelled</button>') +
        "</div>" +
      "</div></div>";
  }

  function renderTools() {
    var list = S.tools.slice();
    if (S.filter === "cancelled") list = list.filter(function (t) { return t.status === "cancelled"; });
    else {
      list = list.filter(function (t) { return t.status !== "cancelled"; });
      if (S.filter !== "all") {
        list = list.filter(function (t) { var i = dashInfo(t.id); return i && i.status === S.filter; });
      }
    }
    list.sort(function (a, b) { return b.costCents - a.costCents; });
    $("tool-grid").innerHTML = list.map(toolCard).join("");
    $("tools-empty").style.display = S.tools.length === 0 ? "" : "none";
  }

  /* ---------- team ---------- */
  function renderTeam() {
    var isAdmin = S.role === "admin";
    $("invite-panel").style.display = isAdmin ? "" : "none";
    $("team-list").innerHTML = S.members.map(function (m) {
      var mine = S.tools.filter(function (t) {
        return t.status !== "cancelled" && (t.members || []).some(function (x) { return x.userId === m.id; });
      });
      var chips = mine.map(function (t) { return '<span class="m-tool">' + esc(t.name) + "</span>"; }).join("");
      var controls = "";
      if (isAdmin) {
        controls =
          '<span class="m-controls">' +
          '<select data-role-for="' + esc(m.id) + '">' +
            '<option value="member"' + (m.role === "member" ? " selected" : "") + ">Member</option>" +
            '<option value="admin"' + (m.role === "admin" ? " selected" : "") + ">Admin</option>" +
          "</select>" +
          (m.id !== S.user.id ? '<button class="btn btn-sm danger" data-remove="' + esc(m.id) + '">Remove</button>' : "") +
          "</span>";
      }
      return '<div class="member-card">' +
        '<span class="av" style="background:' + esc(m.color) + '">' + esc(m.initials) + "</span>" +
        '<span class="m-id"><span class="m-name">' + esc(m.name) + '</span><br/><span class="m-role">' + esc(m.title || m.role) + " · " + esc(m.email) + "</span></span>" +
        '<span class="m-tools">' + (chips || '<span class="muted small">no tools yet</span>') + "</span>" +
        controls +
        "</div>";
    }).join("");
  }

  /* ---------- settings ---------- */
  function renderIntegrations(data) {
    $("integrations-list").innerHTML = data.providers
      .filter(function (p) { return p.id !== "manual"; })
      .map(function (p) {
        var conn = data.connected.find(function (c) { return c.provider === p.id; });
        return '<div class="int-row">' +
          "<strong>" + esc(p.displayName) + "</strong> — " +
          (conn
            ? 'connected (•••• ' + esc(conn.keyLast4) + ")" +
              (conn.lastSyncedAt ? ", synced " + esc(conn.lastSyncedAt.slice(0, 10)) : ", never synced") +
              (p.supportsLiveSync ? ' <button class="btn btn-sm btn-ghost" data-sync="' + esc(p.id) + '">Sync now</button>' : "")
            : '<span class="muted">' + esc(p.integrationStatus) + "</span>") +
          "</div>";
      }).join("");
  }
  function loadIntegrations() {
    HySav.api("/workspaces/" + S.ws.id + "/integrations").then(renderIntegrations);
  }
  function loadPrefs() {
    HySav.api("/workspaces/" + S.ws.id + "/notification-prefs").then(function (p) {
      $("pref-waste").checked = p.wasteAlerts;
      $("pref-renewal").checked = p.renewalAlerts;
      $("pref-digest").checked = p.weeklyDigest;
    });
  }
  function savePrefs() {
    HySav.api("/workspaces/" + S.ws.id + "/notification-prefs", {
      method: "PATCH",
      body: { wasteAlerts: $("pref-waste").checked, renewalAlerts: $("pref-renewal").checked, weeklyDigest: $("pref-digest").checked },
    }).then(function () {
      $("pref-result").style.display = "";
      setTimeout(function () { $("pref-result").style.display = "none"; }, 1500);
    });
  }

  /* ---------- add / edit tool modal ---------- */
  function openModal(tool) {
    S.editingToolId = tool ? tool.id : null;
    $("modal-title").textContent = tool ? "Edit " + tool.name : "Add a tool";
    $("tf-err").classList.remove("show");
    $("tf-catalog").value = "";
    $("tf-name").value = tool ? tool.name : "";
    $("tf-category").value = tool ? tool.category : "llm-chat";
    $("tf-cost").value = tool ? Math.round(tool.costCents / 100) : "";
    $("tf-renewal").value = tool ? tool.renewalDate.slice(0, 10) : new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    $("tf-limit").value = tool && tool.creditLimit != null ? tool.creditLimit : "";
    $("tf-unit").value = tool && tool.creditUnit ? tool.creditUnit : "";
    $("tf-plan").value = tool ? tool.plan : "";
    $("tf-status").value = tool ? tool.status : "active";
    $("tf-used").value = "";
    $("tf-members").innerHTML = S.members.map(function (m) {
      var on = tool && (tool.members || []).some(function (x) { return x.userId === m.id; });
      return '<label class="t-user" style="cursor:pointer"><input type="checkbox" value="' + esc(m.id) + '"' + (on ? " checked" : "") + ' style="margin-right:6px"/>' + esc(m.name.split(" ")[0]) + "</label>";
    }).join("");
    $("tool-modal").style.display = "";
  }
  function closeModal() { $("tool-modal").style.display = "none"; }

  function saveTool(e) {
    e.preventDefault();
    var err = $("tf-err");
    err.classList.remove("show");
    var body = {
      name: $("tf-name").value.trim(),
      category: $("tf-category").value,
      costCents: Math.round(Number($("tf-cost").value || 0) * 100),
      renewalDate: $("tf-renewal").value,
      creditLimit: $("tf-limit").value ? Number($("tf-limit").value) : null,
      creditUnit: $("tf-unit").value.trim() || null,
      plan: $("tf-plan").value.trim(),
      status: $("tf-status").value,
      memberIds: Array.prototype.map.call($("tf-members").querySelectorAll("input:checked"), function (c) { return c.value; }),
    };
    var picked = $("tf-catalog").value === "" ? null : S.catalog[Number($("tf-catalog").value)];
    if (!S.editingToolId && picked) { body.slug = picked.slug; body.usageSource = picked.usageSource; }
    if (!body.name || !body.renewalDate || !Number.isFinite(body.costCents)) {
      err.textContent = "Name, monthly cost, and renewal date are required.";
      err.classList.add("show");
      return;
    }
    var req = S.editingToolId
      ? HySav.api("/tools/" + S.editingToolId, { method: "PATCH", body: body })
      : HySav.api("/workspaces/" + S.ws.id + "/tools", { method: "POST", body: body });
    $("tf-save").disabled = true;
    req.then(function (saved) {
      var used = $("tf-used").value;
      if (used !== "" && Number(used) >= 0) {
        return HySav.api("/tools/" + (saved.id || S.editingToolId) + "/usage", { method: "POST", body: { used: Number(used) } });
      }
    }).then(function () {
      closeModal();
      return loadAll();
    }).catch(function (e2) {
      if (e2.status === 402) { closeModal(); handleWriteError(e2); }
      else { err.textContent = e2.message; err.classList.add("show"); }
    }).then(function () { $("tf-save").disabled = false; });
  }

  /* ---------- events ---------- */
  document.addEventListener("click", function (e) {
    var tab = e.target.closest(".demo-tab");
    if (tab) {
      document.querySelectorAll(".demo-tab").forEach(function (b) { b.classList.toggle("on", b === tab); });
      ["tools", "team", "settings"].forEach(function (v) {
        $("view-" + v).style.display = tab.getAttribute("data-tab") === v ? "" : "none";
      });
      return;
    }
    var chip = e.target.closest(".fchip");
    if (chip) {
      S.filter = chip.getAttribute("data-f");
      document.querySelectorAll(".fchip").forEach(function (c) { c.classList.toggle("on", c === chip); });
      renderTools();
      return;
    }
    var act = e.target.closest("[data-act]");
    if (act) {
      var card = act.closest(".tool-card");
      var tool = S.tools.find(function (t) { return t.id === card.getAttribute("data-id"); });
      var kind = act.getAttribute("data-act");
      if (kind === "edit") openModal(tool);
      if (kind === "usage") {
        var unit = tool.creditUnit || "units";
        var v = prompt("How much of " + tool.name + "'s " + unit + " has been used this billing period?");
        if (v !== null && v !== "" && Number(v) >= 0) {
          HySav.api("/tools/" + tool.id + "/usage", { method: "POST", body: { used: Number(v) } }).then(loadAll, handleWriteError);
        }
      }
      if (kind === "cancel") HySav.api("/tools/" + tool.id, { method: "PATCH", body: { status: "cancelled" } }).then(loadAll, handleWriteError);
      if (kind === "restore") HySav.api("/tools/" + tool.id, { method: "PATCH", body: { status: "active" } }).then(loadAll, handleWriteError);
      if (kind === "delete" && confirm("Delete " + tool.name + " and its usage history for good?")) {
        HySav.api("/tools/" + tool.id, { method: "DELETE" }).then(loadAll, handleWriteError);
      }
      return;
    }
    var card2 = e.target.closest(".tool-card");
    if (card2 && !e.target.closest("a,button,select,input")) { card2.classList.toggle("open"); return; }
    var rm = e.target.closest("[data-remove]");
    if (rm && confirm("Remove this person from the workspace?")) {
      HySav.api("/workspaces/" + S.ws.id + "/members/" + rm.getAttribute("data-remove"), { method: "DELETE" })
        .then(loadAll, function (e2) { alert(e2.message); });
      return;
    }
    var sync = e.target.closest("[data-sync]");
    if (sync) {
      sync.disabled = true; sync.textContent = "Syncing…";
      HySav.api("/workspaces/" + S.ws.id + "/integrations/" + sync.getAttribute("data-sync") + "/sync", { method: "POST" })
        .then(function (r) {
          var ok = r.synced.filter(function (x) { return x.ok; }).length;
          $("int-result").textContent = "Synced " + ok + "/" + r.synced.length + " tools." +
            (ok < r.synced.length ? " Errors: " + r.synced.filter(function (x) { return !x.ok; }).map(function (x) { return x.name + " (" + x.error + ")"; }).join(", ") : "");
          $("int-result").style.display = "";
          loadIntegrations();
          return loadAll();
        }, function (e2) { $("int-result").textContent = e2.message; $("int-result").style.display = ""; loadIntegrations(); });
    }
  });

  document.addEventListener("change", function (e) {
    var roleSel = e.target.closest("[data-role-for]");
    if (roleSel) {
      HySav.api("/workspaces/" + S.ws.id + "/members/" + roleSel.getAttribute("data-role-for"), {
        method: "PATCH", body: { role: roleSel.value },
      }).then(loadAll, function (e2) { alert(e2.message); loadAll(); });
    }
    if (e.target.id === "tf-catalog") {
      var c = S.catalog[Number(e.target.value)];
      if (c) {
        $("tf-name").value = c.name;
        $("tf-category").value = c.category;
        $("tf-unit").value = c.creditUnit || "";
        $("tf-plan").value = c.typicalPlans[0] || "";
      }
    }
    if (e.target.id === "pref-waste" || e.target.id === "pref-renewal" || e.target.id === "pref-digest") savePrefs();
  });

  $("add-tool-btn").addEventListener("click", function () { openModal(null); });
  $("tf-cancel").addEventListener("click", closeModal);
  $("tool-modal").addEventListener("click", function (e) { if (e.target === $("tool-modal")) closeModal(); });
  $("tool-form").addEventListener("submit", saveTool);
  $("logout-btn").addEventListener("click", HySav.logout);
  $("inv-btn").addEventListener("click", function () {
    var email = $("inv-email").value.trim();
    if (!email) return;
    $("inv-btn").disabled = true;
    HySav.api("/workspaces/" + S.ws.id + "/invites", { method: "POST", body: { email: email, role: $("inv-role").value } })
      .then(function (r) {
        $("inv-result").innerHTML = "Invite sent to <strong>" + esc(r.email) + "</strong>. Share this link too (expires in " + r.expiresInDays + " days):<br/><code style=\"user-select:all;word-break:break-all\">" + esc(r.inviteLink) + "</code>";
        $("inv-result").style.display = "";
        $("inv-email").value = "";
      }, function (e2) { $("inv-result").textContent = e2.message; $("inv-result").style.display = ""; if (e2.status === 402) handleWriteError(e2); })
      .then(function () { $("inv-btn").disabled = false; });
  });
  $("int-connect").addEventListener("click", function () {
    var key = $("int-key").value.trim();
    if (!key) return;
    $("int-connect").disabled = true;
    HySav.api("/workspaces/" + S.ws.id + "/integrations", { method: "POST", body: { provider: $("int-provider").value, apiKey: key } })
      .then(function (r) {
        $("int-result").textContent = r.provider + " connected (•••• " + r.keyLast4 + "). Point a tool's usage source at it, then Sync.";
        $("int-result").style.display = "";
        $("int-key").value = "";
        loadIntegrations();
      }, function (e2) { $("int-result").textContent = e2.message; $("int-result").style.display = ""; if (e2.status === 402) handleWriteError(e2); })
      .then(function () { $("int-connect").disabled = false; });
  });

  /* ---------- boot ---------- */
  function loadAll() {
    return Promise.all([
      HySav.api("/workspaces/" + S.ws.id + "/tools"),
      HySav.api("/workspaces/" + S.ws.id + "/dashboard"),
      HySav.api("/workspaces/" + S.ws.id),
      HySav.api("/workspaces/" + S.ws.id + "/billing"),
    ]).then(function (r) {
      S.tools = r[0]; S.dash = r[1]; S.members = r[2].members; S.billing = r[3];
      renderStats(); renderAlerts(); renderTools(); renderTeam(); renderPlanBanner();
    });
  }

  HySav.api("/auth/me").then(function (me) {
    if (!me.workspaces.length) throw Object.assign(new Error("No workspace"), { status: 401 });
    S.user = me.user;
    S.ws = me.workspaces[0];
    S.role = me.workspaces[0].role;
    $("hello").textContent = "Morning, " + me.user.name.split(" ")[0] + " 👋";
    $("hello-sub").textContent = "Here's what " + S.ws.name + " is paying for in AI — and what it's actually using.";
    $("ws-badge").textContent = S.ws.name + " · " + S.role;
    // members can view everything and report usage; workspace changes are admin-only
    if (S.role !== "admin") $("add-tool-btn").style.display = "none";
    return Promise.all([
      loadAll(),
      HySav.api("/catalog/tools").then(function (c) {
        S.catalog = c;
        $("tf-catalog").innerHTML = '<option value="">— Custom tool —</option>' + c.map(function (x, i) {
          return '<option value="' + i + '">' + esc(x.name) + "</option>";
        }).join("");
      }),
    ]).then(function () { loadPrefs(); loadIntegrations(); });
  }).catch(function (e) {
    if (e.status === 401) { HySav.clearToken(); window.location.href = "login.html"; }
    else {
      $("hello").textContent = "Couldn't load your workspace";
      $("hello-sub").textContent = e.message + " — refresh to retry.";
    }
  });
})();
