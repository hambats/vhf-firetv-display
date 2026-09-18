(function () {
  "use strict";

  var SCENE_TYPES = ["information", "announcement", "photo", "photo-pool", "event", "events", "custom"];

  // ---- tabs ----
  document.querySelectorAll("nav button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll("nav button").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("panel-" + btn.dataset.tab).classList.add("active");
    });
  });

  function setStatus(el, ok, msg) {
    el.textContent = msg;
    el.className = "status " + (ok ? "ok" : "err");
  }

  async function getJson(name) {
    var res = await fetch("/api/content?file=" + encodeURIComponent(name));
    if (!res.ok) throw new Error("failed to load " + name);
    return res.json();
  }

  async function saveJson(name, doc) {
    var res = await fetch("/api/content?file=" + encodeURIComponent(name), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc)
    });
    var body = await res.json();
    if (!res.ok) throw new Error((body.details || [body.error]).join("; "));
    return body;
  }

  // ---- Playlist ----
  var playlistDoc = null;

  function renderPlaylist() {
    var list = document.getElementById("playlist-list");
    list.innerHTML = "";
    playlistDoc.playlist.forEach(function (item, i) {
      var card = document.createElement("div");
      card.className = "card";
      card.innerHTML =
        '<div class="row">' +
        '<div><label>ID</label><input type="text" data-f="id" style="width:220px"></div>' +
        '<div><label>Type</label><select data-f="type">' +
        SCENE_TYPES.map((t) => '<option value="' + t + '">' + t + "</option>").join("") +
        "</select></div>" +
        '<div><label>Duration (s)</label><input type="number" data-f="duration" min="1"></div>' +
        '<div><label>Enabled</label><input type="checkbox" data-f="enabled" style="width:20px;height:20px;margin-top:6px"></div>' +
        '<div style="margin-left:auto;display:flex;gap:4px;align-self:flex-end">' +
        '<button class="icon" data-a="up">↑</button>' +
        '<button class="icon" data-a="down">↓</button>' +
        '<button class="icon" data-a="delete">✕</button>' +
        "</div></div>" +
        '<label>Content (JSON)</label><textarea data-f="content"></textarea>';

      card.querySelector('[data-f="id"]').value = item.id || "";
      card.querySelector('[data-f="type"]').value = item.type || "information";
      card.querySelector('[data-f="duration"]').value = item.duration || 10;
      card.querySelector('[data-f="enabled"]').checked = item.enabled !== false;
      card.querySelector('[data-f="content"]').value = JSON.stringify(item.content || {}, null, 2);

      card.querySelector('[data-a="up"]').addEventListener("click", function () {
        if (i === 0) return;
        var tmp = playlistDoc.playlist[i - 1];
        playlistDoc.playlist[i - 1] = playlistDoc.playlist[i];
        playlistDoc.playlist[i] = tmp;
        renderPlaylist();
      });
      card.querySelector('[data-a="down"]').addEventListener("click", function () {
        if (i === playlistDoc.playlist.length - 1) return;
        var tmp = playlistDoc.playlist[i + 1];
        playlistDoc.playlist[i + 1] = playlistDoc.playlist[i];
        playlistDoc.playlist[i] = tmp;
        renderPlaylist();
      });
      card.querySelector('[data-a="delete"]').addEventListener("click", function () {
        playlistDoc.playlist.splice(i, 1);
        renderPlaylist();
      });

      list.appendChild(card);
    });
  }

  function collectPlaylistFromDom() {
    var cards = document.querySelectorAll("#playlist-list .card");
    var items = [];
    var error = null;
    cards.forEach(function (card, i) {
      if (error) return;
      var contentText = card.querySelector('[data-f="content"]').value;
      var content;
      try {
        content = JSON.parse(contentText);
      } catch (e) {
        error = "item " + (i + 1) + ": content is not valid JSON (" + e.message + ")";
        return;
      }
      items.push({
        id: card.querySelector('[data-f="id"]').value,
        type: card.querySelector('[data-f="type"]').value,
        duration: Number(card.querySelector('[data-f="duration"]').value) || 10,
        enabled: card.querySelector('[data-f="enabled"]').checked,
        content: content
      });
    });
    if (error) throw new Error(error);
    return items;
  }

  document.getElementById("add-item").addEventListener("click", function () {
    playlistDoc.playlist.push({ id: "new-item-" + Date.now(), type: "information", duration: 10, enabled: true, content: {} });
    renderPlaylist();
  });

  document.getElementById("save-playlist").addEventListener("click", async function () {
    var statusEl = document.getElementById("playlist-status");
    try {
      playlistDoc.playlist = collectPlaylistFromDom();
      await saveJson("playlist", playlistDoc);
      setStatus(statusEl, true, "Saved.");
    } catch (e) {
      setStatus(statusEl, false, "Not saved: " + e.message);
    }
  });

  // ---- Gallery Weights ----
  var settingsDoc = null;

  document.getElementById("save-weights").addEventListener("click", async function () {
    var statusEl = document.getElementById("weights-status");
    try {
      settingsDoc.gallery = settingsDoc.gallery || {};
      settingsDoc.gallery.maxPhotos = Number(document.getElementById("w-maxPhotos").value);
      settingsDoc.gallery.minDimension = Number(document.getElementById("w-minDimension").value);
      settingsDoc.gallery.recencyDecay = Number(document.getElementById("w-recencyDecay").value);
      await saveJson("settings", settingsDoc);
      setStatus(statusEl, true, "Saved. Re-run gallery sync to apply.");
    } catch (e) {
      setStatus(statusEl, false, "Not saved: " + e.message);
    }
  });

  document.getElementById("sync-gallery").addEventListener("click", async function () {
    var statusEl = document.getElementById("weights-status");
    var out = document.getElementById("weights-output");
    var btn = document.getElementById("sync-gallery");
    btn.disabled = true;
    setStatus(statusEl, true, "Running (this can take ~30-60s)...");
    out.style.display = "block";
    out.textContent = "";
    try {
      var res = await fetch("/api/sync-gallery", { method: "POST" });
      var body = await res.json();
      out.textContent = body.output || "";
      setStatus(statusEl, body.ok, body.ok ? "Sync complete." : "Sync failed — see output.");
      loadExcludeTab();
    } catch (e) {
      setStatus(statusEl, false, "Request failed: " + e.message);
    } finally {
      btn.disabled = false;
    }
  });

  // ---- Gallery Exclude ----
  var excludeDoc = null;

  async function loadExcludeTab() {
    var gallery = await getJson("gallery");
    excludeDoc = await getJson("gallery-exclude").catch(() => ({ version: 1, excluded: [] }));

    document.getElementById("pool-count").textContent = (gallery.photos || []).length;

    var grid = document.getElementById("pool-grid");
    grid.innerHTML = "";
    (gallery.photos || []).forEach(function (photo) {
      var div = document.createElement("div");
      div.className = "thumb";
      div.innerHTML =
        '<img loading="lazy" src="' + photo.src + '">' +
        '<button class="icon" title="Exclude">✕</button>' +
        '<div class="id">' + photo.id + "</div>";
      div.querySelector("button").addEventListener("click", function () {
        var reason = prompt('Reason for excluding "' + photo.id + '"?', "");
        if (reason === null) return;
        excludeDoc.excluded.push({ id: photo.id, reason: reason || "excluded via admin UI" });
        saveExclude();
      });
      grid.appendChild(div);
    });

    renderExcludedList();
  }

  function renderExcludedList() {
    var container = document.getElementById("excluded-list");
    container.innerHTML = "";
    excludeDoc.excluded.forEach(function (entry, i) {
      var row = document.createElement("div");
      row.className = "row";
      row.innerHTML =
        '<div style="min-width:200px"><code>' + entry.id + "</code></div>" +
        '<div class="muted" style="flex:1">' + entry.reason + "</div>" +
        '<button class="icon" data-i="' + i + '">Remove</button>';
      row.querySelector("button").addEventListener("click", function () {
        excludeDoc.excluded.splice(i, 1);
        saveExclude();
      });
      container.appendChild(row);
    });
  }

  async function saveExclude() {
    var statusEl = document.getElementById("exclude-status");
    try {
      await saveJson("gallery-exclude", excludeDoc);
      setStatus(statusEl, true, "Saved. Re-run gallery sync (Gallery Weights tab) to apply.");
      renderExcludedList();
    } catch (e) {
      setStatus(statusEl, false, "Not saved: " + e.message);
    }
  }

  document.getElementById("manual-exclude-add").addEventListener("click", function () {
    var id = document.getElementById("manual-exclude-id").value.trim();
    var reason = document.getElementById("manual-exclude-reason").value.trim();
    if (!id) return;
    excludeDoc.excluded.push({ id: id, reason: reason || "excluded via admin UI" });
    document.getElementById("manual-exclude-id").value = "";
    document.getElementById("manual-exclude-reason").value = "";
    saveExclude();
  });

  // ---- Announcements ----
  var announcementsDoc = null;

  function renderAnnouncements() {
    var list = document.getElementById("announcements-list");
    list.innerHTML = "";
    announcementsDoc.announcements.forEach(function (a, i) {
      var card = document.createElement("div");
      card.className = "card";
      card.innerHTML =
        '<div class="field-grid">' +
        '<div><label>ID</label><input type="text" data-f="id"></div>' +
        '<div><label>Title</label><input type="text" data-f="title"></div>' +
        '<div><label>Activation (ISO, optional)</label><input type="text" data-f="activation"></div>' +
        '<div><label>Expiration (ISO, optional)</label><input type="text" data-f="expiration"></div>' +
        "</div>" +
        '<label>Body</label><textarea data-f="body" style="min-height:50px"></textarea>' +
        '<div class="row"><button class="icon" data-a="delete">Delete</button></div>';

      card.querySelector('[data-f="id"]').value = a.id || "";
      card.querySelector('[data-f="title"]').value = a.title || "";
      card.querySelector('[data-f="activation"]').value = a.activation || "";
      card.querySelector('[data-f="expiration"]').value = a.expiration || "";
      card.querySelector('[data-f="body"]').value = a.body || "";

      card.querySelector('[data-a="delete"]').addEventListener("click", function () {
        announcementsDoc.announcements.splice(i, 1);
        renderAnnouncements();
      });

      list.appendChild(card);
    });
  }

  function collectAnnouncementsFromDom() {
    var cards = document.querySelectorAll("#announcements-list .card");
    var items = [];
    cards.forEach(function (card) {
      var a = {
        id: card.querySelector('[data-f="id"]').value,
        title: card.querySelector('[data-f="title"]').value,
        body: card.querySelector('[data-f="body"]').value
      };
      var activation = card.querySelector('[data-f="activation"]').value.trim();
      var expiration = card.querySelector('[data-f="expiration"]').value.trim();
      if (activation) a.activation = activation;
      if (expiration) a.expiration = expiration;
      items.push(a);
    });
    return items;
  }

  document.getElementById("add-announcement").addEventListener("click", function () {
    announcementsDoc.announcements.push({ id: "new-announcement-" + Date.now(), title: "", body: "" });
    renderAnnouncements();
  });

  document.getElementById("save-announcements").addEventListener("click", async function () {
    var statusEl = document.getElementById("announcements-status");
    try {
      announcementsDoc.announcements = collectAnnouncementsFromDom();
      await saveJson("announcements", announcementsDoc);
      setStatus(statusEl, true, "Saved.");
    } catch (e) {
      setStatus(statusEl, false, "Not saved: " + e.message);
    }
  });

  // ---- Build & Deploy ----
  document.getElementById("run-build").addEventListener("click", async function () {
    var out = document.getElementById("deploy-output");
    out.textContent = "Building...";
    var res = await fetch("/api/build", { method: "POST" });
    var body = await res.json();
    out.textContent = body.output || "";
  });

  document.getElementById("run-deploy").addEventListener("click", async function () {
    if (!confirm("Deploy dist/ to the live Netlify site now?")) return;
    var out = document.getElementById("deploy-output");
    out.textContent = "Deploying (this can take a minute)...";
    var res = await fetch("/api/deploy", { method: "POST" });
    var body = await res.json();
    out.textContent = body.output || "";
  });

  // ---- init ----
  async function init() {
    playlistDoc = await getJson("playlist");
    renderPlaylist();

    settingsDoc = await getJson("settings");
    var g = settingsDoc.gallery || {};
    document.getElementById("w-maxPhotos").value = g.maxPhotos != null ? g.maxPhotos : 120;
    document.getElementById("w-minDimension").value = g.minDimension != null ? g.minDimension : 1200;
    document.getElementById("w-recencyDecay").value = g.recencyDecay != null ? g.recencyDecay : 35;

    await loadExcludeTab();

    announcementsDoc = await getJson("announcements");
    renderAnnouncements();
  }

  init().catch(function (e) {
    document.querySelector("main").innerHTML = '<p style="color:#c95d59">Failed to load: ' + e.message + "</p>";
  });
})();
