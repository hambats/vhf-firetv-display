/*
 * Scene renderers. Each function takes (item, data) and returns a DOM node,
 * or throws if it cannot render — the engine catches that and skips the scene.
 * `item` is the playlist entry; `data` is the shared content bundle
 * (events, settings) the engine loaded.
 *
 * Kept intentionally conservative (var/function, no optional chaining) so it
 * can later be reused as-is inside the Fire TV WebView shell.
 */
var VhfScenes = (function () {
  "use strict";

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function brand(container) {
    var img = el("img", "scene__brand");
    img.src = "content/artwork/brand/vhf-logo.webp";
    img.alt = "Veterans Healing Farm";
    container.appendChild(img);
  }

  // Full logo + wordmark at ~280px, used on the two scenes with room to
  // spare and the highest chance of being read (D1.3): the opening Welcome
  // scene and the announcement scene.
  function lockup(container) {
    var img = el("img", "scene__lockup");
    img.src = "content/artwork/brand/vhf-logo.webp";
    img.alt = "Veterans Healing Farm";
    container.appendChild(img);
  }

  // A faint (~16%) full-bleed photo behind text content — a watermark, not a
  // photo scene. Same card pattern as the site's own program cards: a photo
  // wash behind a soft-tan fill, content on top unaffected. Silently does
  // nothing if the gallery pool isn't loaded yet — this is decoration, never
  // something a scene should fail over.
  function appendWash(scene, data) {
    var photos = (data && data.gallery && data.gallery.photos) || [];
    if (photos.length === 0) return;
    var photo = photos[Math.floor(Math.random() * photos.length)];
    var wash = el("img", "scene__wash");
    wash.src = photo.src;
    wash.alt = "";
    scene.appendChild(wash);
  }

  function formatEventDate(startIso) {
    var d = new Date(startIso);
    if (isNaN(d.getTime())) return "";
    var days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    var months = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
    ];
    return days[d.getDay()] + ", " + months[d.getMonth()] + " " + d.getDate();
  }

  function formatEventTimeRange(startIso, endIso) {
    function fmt(iso) {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return "";
      var h = d.getHours();
      var m = d.getMinutes();
      var ampm = h >= 12 ? "PM" : "AM";
      var h12 = h % 12;
      if (h12 === 0) h12 = 12;
      var mStr = m < 10 ? "0" + m : String(m);
      return h12 + (m === 0 ? "" : ":" + mStr) + " " + ampm;
    }
    var start = fmt(startIso);
    var end = endIso ? fmt(endIso) : "";
    return end ? start + " – " + end : start;
  }

  function findEvent(data, eventId) {
    var events = (data.events && data.events.events) || [];
    for (var i = 0; i < events.length; i++) {
      if (events[i].id === eventId) return events[i];
    }
    return null;
  }

  function findAnnouncement(data, announcementId) {
    var announcements = (data.announcements && data.announcements.announcements) || [];
    for (var i = 0; i < announcements.length; i++) {
      if (announcements[i].id === announcementId) return announcements[i];
    }
    return null;
  }

  function activeAnnouncements(data) {
    var announcements = (data.announcements && data.announcements.announcements) || [];
    var now = Date.now();
    return announcements.filter(function (a) {
      if (a.activation && now < new Date(a.activation).getTime()) return false;
      if (a.expiration && now > new Date(a.expiration).getTime()) return false;
      return true;
    });
  }

  // Round-robins through however many announcements are currently active, so
  // adding more to announcements.json automatically puts them into rotation
  // without any playlist.json change.
  var announcementRotation = 0;

  function nextAnnouncement(data) {
    var active = activeAnnouncements(data);
    if (active.length === 0) return null;
    var picked = active[announcementRotation % active.length];
    announcementRotation += 1;
    return picked;
  }

  function upcomingEvents(data, limit, offset) {
    var events = (data.events && data.events.events) || [];
    var now = Date.now();
    var upcoming = events.filter(function (e) {
      var end = e.end || e.start;
      return new Date(end).getTime() >= now;
    });
    upcoming.sort(function (a, b) {
      return new Date(a.start).getTime() - new Date(b.start).getTime();
    });
    return upcoming.slice(offset || 0, (offset || 0) + (limit || 5));
  }

  // Cycles through the full gallery pool before any photo repeats, instead of
  // picking uniformly at random (which can show the same handful of photos
  // over and over out of a 1000+ photo gallery).
  var photoPoolShuffled = [];

  function drawPhotos(photos, count) {
    var drawn = [];
    for (var i = 0; i < count && photos.length > 0; i++) {
      if (photoPoolShuffled.length === 0) {
        photoPoolShuffled = photos.slice();
        for (var j = photoPoolShuffled.length - 1; j > 0; j--) {
          var k = Math.floor(Math.random() * (j + 1));
          var tmp = photoPoolShuffled[j];
          photoPoolShuffled[j] = photoPoolShuffled[k];
          photoPoolShuffled[k] = tmp;
        }
      }
      drawn.push(photoPoolShuffled.pop());
    }
    return drawn;
  }

  function renderInformation(item, data) {
    var content = item.content || {};
    var className = "scene scene--information";
    // content.family lets a small subset of "information" slides (impact
    // numbers, the crisis-line slide) opt into a different ground/anchor
    // instead of the default story treatment — see docs/DESIGN_PLAN.md D2.1.
    if (content.family === "impact") className += " scene--impact";
    if (content.family === "crisis") className += " scene--crisis";
    var scene = el("div", className);
    appendWash(scene, data);
    scene.appendChild(el("div", "scene__fade"));
    var body = el("div", "scene__content");
    body.appendChild(el("p", "scene__eyebrow", content.eyebrow || "Veterans Healing Farm"));
    body.appendChild(el("h1", "scene__title", content.title || "Welcome"));
    if (content.body) body.appendChild(el("p", "scene__body", content.body));
    scene.appendChild(body);
    // The Welcome scene gets the full lockup instead of the small corner
    // mark — it's the slide with the most room and the highest chance of
    // being read (D1.3).
    if (content.lockup) {
      lockup(scene);
    } else {
      brand(scene);
    }
    return scene;
  }

  function renderAnnouncement(item, data) {
    var content = item.content || {};
    var announcement;
    if (content.announcementId) {
      announcement = findAnnouncement(data, content.announcementId);
      var now = Date.now();
      if (announcement && announcement.activation && now < new Date(announcement.activation).getTime()) {
        throw new Error("announcement not yet active");
      }
      if (announcement && announcement.expiration && now > new Date(announcement.expiration).getTime()) {
        throw new Error("announcement expired");
      }
    } else {
      announcement = nextAnnouncement(data);
    }
    if (!announcement || !announcement.title) throw new Error("announcement scene missing announcement data");

    var scene = el("div", "scene scene--announcement");
    scene.appendChild(el("div", "scene__fade"));
    lockup(scene);
    var body = el("div", "scene__content");
    body.appendChild(el("h1", "scene__title", announcement.title));
    if (announcement.body) body.appendChild(el("p", "scene__body", announcement.body));
    scene.appendChild(body);
    return scene;
  }

  function buildPhotoScene(src, fit, focus) {
    var scene = el("div", "scene scene--photo");
    var img = el("img", "scene__photo-img");
    img.src = src;
    img.alt = "";
    img.style.objectFit = fit === "contain" ? "contain" : "cover";
    // A generic photo of unknown composition crops slightly better favoring
    // the upper-middle by default (avoids cutting off heads more often than
    // it cuts off feet/ground) than a dead-center crop would.
    img.style.objectPosition = focus || "center 35%";
    scene.appendChild(img);
    scene.appendChild(el("div", "scene__fade scene__fade--subtle"));
    brand(scene);
    return scene;
  }

  function renderPhoto(item) {
    var content = item.content || {};
    if (!content.src) throw new Error("photo scene missing content.src");
    return buildPhotoScene(content.src, content.fit, content.focus);
  }

  function renderPhotoPool(item, data) {
    var photos = (data.gallery && data.gallery.photos) || [];
    if (photos.length === 0) throw new Error("photo pool is empty");
    var content = item.content || {};
    var count = content.count || 1;

    if (count <= 1 || photos.length < count) {
      var photo = drawPhotos(photos, 1)[0] || photos[Math.floor(Math.random() * photos.length)];
      return buildPhotoScene(photo.src, "cover", null);
    }

    var picks = drawPhotos(photos, count);
    var scene = el("div", "scene scene--photo scene--photo-grid scene--photo-grid-" + picks.length);
    picks.forEach(function (p) {
      var cell = el("div", "photo-grid__cell");
      var img = el("img", "photo-grid__img");
      img.src = p.src;
      img.alt = "";
      cell.appendChild(img);
      scene.appendChild(cell);
    });
    scene.appendChild(el("div", "scene__fade scene__fade--subtle"));
    brand(scene);
    return scene;
  }

  function renderCustom(item) {
    var content = item.content || {};
    if (!content.src) throw new Error("custom scene missing content.src");
    var scene = el("div", "scene scene--custom");
    var img = el("img", "scene__photo-img");
    img.src = content.src;
    img.alt = "";
    scene.appendChild(img);
    return scene;
  }

  function buildEventScene(evt, data) {
    var scene = el("div", "scene scene--event");
    appendWash(scene, data);
    scene.appendChild(el("div", "scene__fade"));
    var body = el("div", "scene__content");
    body.appendChild(el("p", "scene__eyebrow", "What's Happening at the Farm"));
    body.appendChild(el("h1", "scene__title", evt.title));
    body.appendChild(el("p", "scene__subtitle", formatEventDate(evt.start)));
    body.appendChild(el("p", "scene__subtitle", formatEventTimeRange(evt.start, evt.end)));
    if (evt.description) body.appendChild(el("p", "scene__body", evt.description));
    if (evt.location) body.appendChild(el("p", "scene__caption", evt.location));
    scene.appendChild(body);
    brand(scene);
    return scene;
  }

  function renderEvent(item, data) {
    var content = item.content || {};
    var evt = content.eventId ? findEvent(data, content.eventId) : content;
    if (!evt || !evt.title || !evt.start) throw new Error("event scene missing event data");
    return buildEventScene(evt, data);
  }

  // Cycles through every currently-upcoming event before any repeats, same
  // shuffle-bag approach as drawPhotos — so a handful of event-pool slots
  // spread through the playlist eventually surface all of them instead of
  // clustering on whichever event random.random() favors.
  var eventPoolShuffled = [];

  function renderEventPool(item, data) {
    var upcoming = upcomingEvents(data, 999, 0);
    if (upcoming.length === 0) throw new Error("no upcoming events for event pool");

    // Drop any stale entries left over from a previous (now-expired) pool
    // before drawing, rather than waiting for the bag to empty naturally.
    var upcomingIds = {};
    upcoming.forEach(function (e) { upcomingIds[e.id || e.start] = true; });
    eventPoolShuffled = eventPoolShuffled.filter(function (e) {
      return upcomingIds[e.id || e.start];
    });

    if (eventPoolShuffled.length === 0) {
      eventPoolShuffled = upcoming.slice();
      for (var j = eventPoolShuffled.length - 1; j > 0; j--) {
        var k = Math.floor(Math.random() * (j + 1));
        var tmp = eventPoolShuffled[j];
        eventPoolShuffled[j] = eventPoolShuffled[k];
        eventPoolShuffled[k] = tmp;
      }
    }

    var evt = eventPoolShuffled.pop();
    return buildEventScene(evt, data);
  }

  function renderEvents(item, data) {
    var content = item.content || {};
    var upcoming = upcomingEvents(data, content.limit || 8, content.offset || 0);
    if (upcoming.length === 0) throw new Error("no upcoming events to show");
    var scene = el("div", "scene scene--events");
    appendWash(scene, data);
    scene.appendChild(el("div", "scene__fade"));
    var body = el("div", "scene__content");
    body.appendChild(el("p", "scene__eyebrow", content.eyebrow || "Upcoming at the Farm"));
    var list = el("div", "events-list");
    upcoming.forEach(function (evt) {
      var row = el("div", "events-list__item");
      row.appendChild(el("div", "events-list__date", formatEventDate(evt.start).toUpperCase()));
      var main = el("div", "events-list__main");
      main.appendChild(el("div", "events-list__title", evt.title));
      var metaBits = [];
      var timeRange = formatEventTimeRange(evt.start, evt.end);
      if (timeRange) metaBits.push(timeRange);
      if (evt.location) metaBits.push(evt.location);
      if (metaBits.length > 0) main.appendChild(el("div", "events-list__meta", metaBits.join(" · ")));
      row.appendChild(main);
      list.appendChild(row);
    });
    body.appendChild(list);
    scene.appendChild(body);
    brand(scene);
    return scene;
  }

  function renderError(item, err) {
    var scene = el("div", "scene scene--error");
    scene.appendChild(el("p", "scene__body", "Scene \"" + item.id + "\" (" + item.type + ") skipped: " + err.message));
    return scene;
  }

  var renderers = {
    information: renderInformation,
    announcement: renderAnnouncement,
    photo: renderPhoto,
    "photo-pool": renderPhotoPool,
    custom: renderCustom,
    event: renderEvent,
    "event-pool": renderEventPool,
    events: renderEvents
  };

  function render(item, data) {
    var fn = renderers[item.type];
    if (!fn) throw new Error("unknown scene type: " + item.type);
    return fn(item, data);
  }

  return {
    render: render,
    renderError: renderError
  };
})();
