/* HySav — shared session + API helpers.
   The backend issues opaque bearer tokens (POST /api/v1/auth/login|register);
   we keep the token in localStorage and attach it to API calls. No secrets
   live in this file — the Razorpay key_secret never reaches the browser, and
   even the publishable key id arrives from the backend per checkout. */
var HySav = (function () {
  var TOKEN_KEY = "hysav_token";

  function token() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
  function clearToken() { localStorage.removeItem(TOKEN_KEY); }

  /* fetch wrapper: JSON in/out, bearer auth, throws {message, status} on error */
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    if (token()) opts.headers.Authorization = "Bearer " + token();
    if (opts.body && typeof opts.body !== "string") opts.body = JSON.stringify(opts.body);
    return fetch("/api/v1" + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) {
          var err = new Error(data.error || "Request failed (" + r.status + ")");
          err.status = r.status;
          throw err;
        }
        return data;
      });
    });
  }

  function logout() {
    var done = function () { clearToken(); window.location.href = "index.html"; };
    api("/auth/logout", { method: "POST" }).then(done, done);
  }

  return { token: token, setToken: setToken, clearToken: clearToken, api: api, logout: logout };
})();
