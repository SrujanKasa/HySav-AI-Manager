/* HySav — shared site behavior (rename: find & replace "HySav") */

// Lucide icons
if (window.lucide) { window.lucide.createIcons(); }

// Auth-aware nav link (requires auth.js loaded first; degrades if absent)
(function () {
  var nav = document.querySelector(".nav-links");
  if (!nav || typeof HySav === "undefined") return;
  var a = document.createElement("a");
  if (HySav.token()) { a.href = "account.html"; a.textContent = "Account"; }
  else { a.href = "login.html"; a.textContent = "Log in"; }
  nav.insertBefore(a, nav.querySelector(".btn"));
})();

// Reveal-on-scroll
(function () {
  var els = document.querySelectorAll(".rv");
  if (!("IntersectionObserver" in window)) {
    els.forEach(function (el) { el.classList.add("in"); });
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) {
        e.target.classList.add("in");
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.12 });
  els.forEach(function (el) { io.observe(el); });
})();

// Hero mini-dashboard bars animate in
(function () {
  var bars = document.querySelectorAll(".hc-bar i");
  if (!bars.length) return;
  setTimeout(function () {
    bars.forEach(function (b) {
      b.style.width = (b.getAttribute("data-w") || "0") + "%";
    });
  }, 350);
})();

// (The old mocked waitlist form is gone — signup.html is the real front door.)
