/*! Boustan "Sauvez le poulet" embed loader (PRD EMB-04). Keep under 3 KB.
 * <div data-boustan-game data-lang="fr" data-src="PARTNER_ID"></div>
 * <script src="https://GAME_HOST/embed.js" async></script>
 * Optional: data-utm-source, data-utm-medium, data-utm-campaign, data-utm-content, data-muted.
 * Game events go to window.dataLayer as boustan_game_<type>; send commands with
 * window.boustanGame.send("pause" | "resume" | "mute" | "setLanguage", value).
 */
(function () {
  var s = document.currentScript;
  if (!s || window.boustanGame) return;
  var origin = new URL(s.src).origin;
  var frames = [];
  var keys = ["lang", "src", "utm_source", "utm_medium", "utm_campaign", "utm_content", "muted"];

  function mount(el) {
    if (el.getAttribute("data-boustan-mounted")) return;
    el.setAttribute("data-boustan-mounted", "1");
    var q = new URLSearchParams();
    keys.forEach(function (k) {
      var v = el.getAttribute("data-" + k.replace("_", "-"));
      if (v) q.set(k, v);
    });
    var w = el.clientWidth || 360;
    var f = document.createElement("iframe");
    f.src = origin + "/?" + q;
    f.title = "Boustan — Sauvez le poulet / Save the Chicken";
    f.allow = "clipboard-write; fullscreen; web-share";
    f.loading = "lazy";
    // Portrait on narrow containers, landscape on wide ones; the game then reports its height.
    f.style.cssText =
      "border:0;display:block;background:#073F36;width:100%;height:" +
      Math.max(400, Math.round(w < 600 ? w * 1.3 : w * 0.75)) +
      "px";
    el.appendChild(f);
    frames.push(f);
  }

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (e.origin !== origin || !d || d.ns !== "boustan-game" || d.v !== 1) return;
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow !== e.source) continue;
      if (d.type === "resize") {
        var h = +(d.data && d.data.height);
        if (h >= 300 && h <= 3000) frames[i].style.height = h + "px";
      } else {
        (window.dataLayer = window.dataLayer || []).push({
          event: "boustan_game_" + d.type,
          boustan_game: d.data || {},
        });
      }
    }
  });

  window.boustanGame = {
    send: function (cmd, value) {
      frames.forEach(function (f) {
        if (f.contentWindow) {
          f.contentWindow.postMessage({ ns: "boustan-game", v: 1, cmd: cmd, value: value }, origin);
        }
      });
    },
  };

  function scan() {
    document.querySelectorAll("[data-boustan-game]").forEach(mount);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan);
  else scan();
})();
