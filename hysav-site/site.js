/* HySav — shared site behavior (rename: find & replace "HySav") */

// Lucide icons
if (window.lucide) { window.lucide.createIcons(); }

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

// Waitlist form (mocked — no backend)
(function () {
  var form = document.getElementById("waitlist-form");
  if (!form) return;

  // multi-select tool chips
  form.querySelectorAll(".chip").forEach(function (chip) {
    chip.addEventListener("click", function (e) {
      e.preventDefault();
      chip.classList.toggle("on");
    });
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var email = form.querySelector("#wl-email");
    var valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim());
    email.classList.toggle("field-err", !valid);
    if (!valid) { email.focus(); return; }

    // capture (would POST to backend later)
    var payload = {
      email: email.value.trim(),
      teamSize: form.querySelector("#wl-size").value,
      tools: Array.from(form.querySelectorAll(".chip.on")).map(function (c) {
        return c.textContent.trim();
      })
    };
    console.log("Waitlist signup (mock):", payload);

    form.classList.add("done");
  });
})();
