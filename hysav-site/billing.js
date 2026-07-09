/* HySav — Razorpay Checkout wiring (pricing + account pages).
   Requires auth.js and https://checkout.razorpay.com/v1/checkout.js.

   Flow: POST /billing/create-subscription on our backend (which talks to
   Razorpay with the server-side key_secret and returns only subscription_id
   + the publishable key id) → open Checkout → on success POST the payment/
   subscription ids + signature to /billing/verify-subscription and wait for
   the backend's confirmation before showing any "upgraded" state.
   If Razorpay isn't configured (backend replies 503) the caller degrades to
   the signup/notice CTA instead of breaking. */
var HySavBilling = (function () {
  /* Resolves null only when there's genuinely no session (no token, or the
     backend says 401). Transient failures (network, rate limit, 5xx) reject
     instead — callers must NOT treat those as "logged out". */
  function loadContext() {
    if (!HySav.token()) return Promise.resolve(null);
    return HySav.api("/auth/me").then(function (me) {
      var ws = me.workspaces && me.workspaces[0];
      if (!ws) return null;
      return HySav.api("/workspaces/" + ws.id + "/billing").then(function (billing) {
        return { user: me.user, workspace: ws, billing: billing };
      });
    }).catch(function (e) {
      if (e.status === 401) return null; /* session really is dead */
      throw e;
    });
  }

  /* opts: { workspaceId, onSuccess(result), onError(message), onDismiss() } */
  function startCheckout(opts) {
    return HySav.api("/workspaces/" + opts.workspaceId + "/billing/create-subscription", { method: "POST" })
      .then(function (sub) {
        if (typeof Razorpay === "undefined") {
          throw new Error("Payment widget failed to load — check your connection and retry.");
        }
        var rzp = new Razorpay({
          key: sub.keyId, /* publishable key id only — secret never leaves the backend */
          subscription_id: sub.subscriptionId,
          name: "HySav | AI Monit",
          description: sub.description,
          theme: { color: "#E4570F" },
          modal: {
            ondismiss: function () { if (opts.onDismiss) opts.onDismiss(); }
          },
          handler: function (resp) {
            /* success is only what the BACKEND confirms, not the widget */
            HySav.api("/workspaces/" + opts.workspaceId + "/billing/verify-subscription", {
              method: "POST",
              body: {
                razorpayPaymentId: resp.razorpay_payment_id,
                razorpaySubscriptionId: resp.razorpay_subscription_id,
                razorpaySignature: resp.razorpay_signature
              }
            }).then(opts.onSuccess, function (e) {
              opts.onError("Payment made but verification failed — contact support. (" + e.message + ")");
            });
          }
        });
        rzp.on("payment.failed", function (resp) {
          var why = resp && resp.error && resp.error.description ? resp.error.description : "Payment failed";
          opts.onError(why);
        });
        rzp.open();
      });
  }

  return { loadContext: loadContext, startCheckout: startCheckout };
})();
