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

  // Every <img> declares whether it carries the scene or merely decorates
  // it. The engine preloads both, but only a "content" image failing makes
  // a scene worth skipping — a photo scene with no photo is an empty
  // frame, whereas a missing watermark or corner mark is invisible.
  // photoId, when given, is the id gallery.json/curated-photos.json already
  // carries per photo (e.g. "military-art/thumb-1920-374856.jpg" or a
  // gallery scrape id) — surfaced only through ?diag=1 (diagnostics.js), so
  // a bad crop or composition found on the wall can be pointed back at the
  // exact source file without guessing from the rendered src.
  function img(className, src, role, photoId) {
    var node = el("img", className);
    node.src = src;
    node.alt = "";
    node.setAttribute("data-vhf-role", role);
    if (photoId) node.setAttribute("data-vhf-photo-id", photoId);
    return node;
  }

  // URLs that definitively failed to load during this run: a 404, a
  // gallery object deleted after gallery.json was published, a CDN that
  // refused the request. The engine reports them here so a dead photo is
  // drawn once and then never again — without this, one dead URL in the
  // pool costs a skipped scene every time the bag comes back around to it.
  var failedSrc = {};

  function markImageFailed(src) {
    if (src) failedSrc[src] = true;
  }

  function isUsablePhoto(photo) {
    return !!(photo && photo.src && !failedSrc[photo.src]);
  }

  function usablePhotos(photos) {
    var out = [];
    for (var i = 0; i < photos.length; i++) {
      if (isUsablePhoto(photos[i])) out.push(photos[i]);
    }
    return out;
  }

  function brand(container) {
    container.appendChild(img("scene__brand", "content/artwork/brand/vhf-logo.webp", "decoration"));
  }

  // Full logo + wordmark at ~280px, used on the two scenes with room to
  // spare and the highest chance of being read (D1.3): the opening Welcome
  // scene and the announcement scene.
  function lockup(container, extraClass) {
    var className = extraClass ? "scene__lockup " + extraClass : "scene__lockup";
    container.appendChild(img(className, "content/artwork/brand/vhf-logo.webp", "decoration"));
  }

  // A faint (~16%) full-bleed photo behind text content — a watermark, not a
  // photo scene. Same card pattern as the site's own program cards: a photo
  // wash behind a soft-tan fill, content on top unaffected. Silently does
  // nothing if no photos are available — this is decoration, never
  // something a scene should fail over.
  //
  // When programId names a hand-curated set (content/artwork/curated/<id>/,
  // built into content/generated/curated-photos.json), the wash is drawn
  // from that set instead of the general gallery pool — e.g. the
  // "program-pottery" information/event scenes show an actual pottery photo
  // rather than a random farm photo.
  function curatedSet(data, id) {
    return (id && data && data.curated && data.curated[id]) || [];
  }

  // programId may be a single curated-set id (the common case) or an array
  // of them — a slide whose text names several programs (e.g. "Designed to
  // Heal" mentioning equine therapy, art therapy, blacksmithing and herbal
  // medicine) draws its wash from the union of those sets instead of one
  // id that can't represent "any of these," so the photo actually matches
  // what the slide is talking about rather than a generic farm photo.
  function appendWash(scene, data, programId) {
    var ids = Array.isArray(programId) ? programId : [programId];
    var curated = [];
    for (var i = 0; i < ids.length; i++) {
      curated = curated.concat(usablePhotos(curatedSet(data, ids[i])));
    }
    var photos = curated.length > 0 ? curated : usablePhotos((data && data.gallery && data.gallery.photos) || []);
    if (photos.length === 0) return;
    var photo = photos[Math.floor(Math.random() * photos.length)];
    scene.appendChild(img("scene__wash", photo.src, "decoration", photo.id));
  }

  // Curated sets that hold an organization's logo rather than candid photos
  // of a program: cropping a badge full-bleed at low opacity (.scene__wash)
  // turns it into an unrecognizable sliver, so these render small and plain
  // instead (.scene__partner-logo) — see buildEventScene.
  var LOGO_PROGRAM_IDS = ["program-hendersonville-womans-club"];

  function appendPartnerLogo(scene, data, programId) {
    var photos = usablePhotos(curatedSet(data, programId));
    if (photos.length === 0) return false;
    scene.appendChild(img("scene__partner-logo", photos[0].src, "decoration", photos[0].id));
    return true;
  }

  // Curated sets that hold designed graphics (an event badge, a medal or
  // shirt mockup) rather than candid photos: same unreadable-wash problem as
  // LOGO_PROGRAM_IDS, but these are portrait print assets on a white ground,
  // not a small round mark, so they get a bigger contained card
  // (.scene__event-graphic) instead of the circular treatment. Cycles
  // through whichever of the set's assets is on deck via drawPhotos so a
  // folder with several designs (logo, medal, shirt) rotates instead of
  // always showing the same one.
  var GRAPHIC_PROGRAM_IDS = ["program-5k-fundraiser"];

  // Maps an announcement's own id (announcements.json) to the curated-set
  // id it should show its designed graphic from — see renderAnnouncement.
  var ANNOUNCEMENT_GRAPHIC_SOURCES = {
    "veterans-day-5k-registration-open": "program-5k-fundraiser"
  };

  function appendEventGraphic(scene, data, programId) {
    var photos = usablePhotos(curatedSet(data, programId));
    if (photos.length === 0) return false;
    var pick = drawPhotos(programId, photos, 1)[0];
    if (!pick) return false;
    scene.appendChild(img("scene__event-graphic", pick.src, "decoration", pick.id));
    return true;
  }

  /*
   * Event times are the one thing on this display that can be wrong without
   * looking wrong.
   *
   * events.json stores UTC. Formatting it with getHours()/getDay() means
   * "whatever this television believes local time is" — and nobody checks a
   * television's clock settings. A wrong or reset time zone shifts every event
   * time by a fixed offset, and a late-evening event lands on the wrong day,
   * with no visible symptom at all. So the display pins its own zone, read
   * from `timezone` in settings.json rather than hardcoded here, and the
   * engine hands it over before the first scene renders.
   */
  var displayTimeZone = null;

  function setTimeZone(tz) {
    displayTimeZone = tz || null;
  }

  /* Falls back to device-local formatting where Intl cannot do time zones —
     wrong-but-rendered beats a blank line. compat.js records when this
     happens, so the degradation is at least visible somewhere. */
  function zoneSupported() {
    return displayTimeZone && window.VhfCompat && VhfCompat.intlTimeZone;
  }

  function formatEventDate(startIso) {
    var d = new Date(startIso);
    if (isNaN(d.getTime())) return "";
    if (zoneSupported()) {
      return d.toLocaleDateString("en-US", {
        timeZone: displayTimeZone,
        weekday: "short",
        month: "short",
        day: "numeric"
      });
    }
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
      if (zoneSupported()) {
        /* "4:00 PM" -> "4 PM": an on-the-hour start reads better without the
           zeroes at television distance, which is what the manual formatter
           below did and what the rest of the display expects. */
        return d
          .toLocaleTimeString("en-US", {
            timeZone: displayTimeZone,
            hour: "numeric",
            minute: "2-digit"
          })
          .replace(":00 ", " ");
      }
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

  // titleContainsAny: true if evt.title contains any of the given
  // substrings, case-insensitive. Used both to pull a recurring program's
  // occurrences into their own consolidated list (content.titleContains on
  // an "events" scene) and to keep those same occurrences from also
  // showing individually (content.excludeTitleContains on an "event"/
  // "event-pool" scene) — one program's events, one slide, not both.
  function titleContainsAny(title, substrings) {
    var lower = (title || "").toLowerCase();
    for (var i = 0; i < substrings.length; i++) {
      if (lower.indexOf(substrings[i].toLowerCase()) !== -1) return true;
    }
    return false;
  }

  function upcomingEvents(data, limit, offset, opts) {
    var events = (data.events && data.events.events) || [];
    var now = Date.now();
    var upcoming = events.filter(function (e) {
      var end = e.end || e.start;
      return new Date(end).getTime() >= now;
    });
    if (opts && opts.titleContains) {
      upcoming = upcoming.filter(function (e) { return titleContainsAny(e.title, opts.titleContains); });
    }
    if (opts && opts.excludeTitleContains) {
      upcoming = upcoming.filter(function (e) { return !titleContainsAny(e.title, opts.excludeTitleContains); });
    }
    upcoming.sort(function (a, b) {
      return new Date(a.start).getTime() - new Date(b.start).getTime();
    });
    return upcoming.slice(offset || 0, (offset || 0) + (limit || 5));
  }

  // Cycles through a pool before any photo repeats, instead of picking
  // uniformly at random (which can show the same handful of photos over and
  // over out of a 1000+ photo gallery). Kept per pool identity (the general
  // gallery pool, or each named curated set) rather than one shared bag —
  // several distinct pools now feed different scenes in the same session
  // (D2.1/curated-photos), and a single bag would hand back the wrong
  // pool's photos whenever two different pools' draws interleave.
  var photoPoolShuffledByKey = {};

  function drawPhotos(key, photos, count) {
    // Refill from the live pool minus anything known dead, so a failed URL
    // leaves the rotation permanently instead of returning every cycle.
    var pool = usablePhotos(photos);
    var drawn = [];
    // The bag can still hold entries that died after it was filled, and a
    // refill mid-draw can hand back one already drawn; both are skipped
    // rather than shown. Bounded so neither case can spin.
    var attempts = 0;
    var maxAttempts = pool.length * 2 + count + 10;
    var bag = photoPoolShuffledByKey[key] || [];
    while (drawn.length < count && pool.length > 0 && attempts < maxAttempts) {
      attempts++;
      if (bag.length === 0) {
        bag = pool.slice();
        for (var j = bag.length - 1; j > 0; j--) {
          var k = Math.floor(Math.random() * (j + 1));
          var tmp = bag[j];
          bag[j] = bag[k];
          bag[k] = tmp;
        }
      }
      var pick = bag.pop();
      if (!isUsablePhoto(pick)) continue;
      if (drawn.indexOf(pick) !== -1) continue;
      drawn.push(pick);
    }
    photoPoolShuffledByKey[key] = bag;
    return drawn;
  }

  function renderInformation(item, data) {
    var content = item.content || {};
    // Same 1-in-N throttle renderPhotoPool uses (content.showEvery) — an
    // information slide can be over-shown relative to its content just as
    // easily as a thin photo pool can.
    if (throttled(item.id, content.showEvery)) {
      throw new Error("throttled: showing 1 in " + content.showEvery + " passes");
    }
    var className = "scene scene--information";
    // content.family lets a small subset of "information" slides (impact
    // numbers, the crisis-line slide) opt into a different ground/anchor
    // instead of the default story treatment — see docs/DESIGN_PLAN.md D2.1.
    if (content.family === "impact") className += " scene--impact";
    if (content.family === "crisis") className += " scene--crisis";
    var scene = el("div", className);
    // Information slides for a specific program (id "program-agritherapy"
    // etc., matching a content/artwork/curated/ folder 1:1) get that
    // program's own photos as the wash instead of a random farm photo.
    // content.washSources overrides this for a slide that names several
    // programs in its own text rather than being about just one.
    appendWash(scene, data, content.washSources || item.id);
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
      lockup(scene, "scene__lockup--welcome");
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
    // An announcement about a specific program can show that program's
    // designed graphic (the same badge/medal/shirt card the event scene
    // uses) rather than the plain solid-color ground every other
    // announcement gets — reuses appendEventGraphic since the treatment
    // (contained card, portrait print asset) is identical.
    var graphicSource = ANNOUNCEMENT_GRAPHIC_SOURCES[announcement.id];
    if (graphicSource) appendEventGraphic(scene, data, graphicSource);
    scene.appendChild(el("div", "scene__fade"));
    lockup(scene);
    var body = el("div", "scene__content");
    body.appendChild(el("h1", "scene__title", announcement.title));
    if (announcement.body) body.appendChild(el("p", "scene__body", announcement.body));
    scene.appendChild(body);
    return scene;
  }

  function buildPhotoScene(src, fit, focus, eyebrow, photoId, caption) {
    var scene = el("div", "scene scene--photo");
    var photo = img("scene__photo-img", src, "content", photoId);
    photo.style.objectFit = fit === "contain" ? "contain" : "cover";
    // A generic photo of unknown composition crops slightly better favoring
    // the upper-middle by default (avoids cutting off heads more often than
    // it cuts off feet/ground) than a dead-center crop would.
    photo.style.objectPosition = focus || "center 35%";
    scene.appendChild(photo);
    scene.appendChild(el("div", "scene__fade scene__fade--subtle"));
    // A standalone curated category (In Uniform, Military Art) names itself
    // so it doesn't just look like an unlabeled random photo. A photo with
    // its own hand-written caption (curated-photos.json's optional
    // per-photo `caption`, from a captions.json next to the images) adds a
    // second, smaller line under the eyebrow for that photo's own story —
    // e.g. Iwo Jima's history — rather than replacing the category label.
    if (eyebrow || caption) {
      var label = el("div", "scene__content scene__content--photo-label");
      if (eyebrow) label.appendChild(el("p", "scene__eyebrow", eyebrow));
      if (caption) label.appendChild(el("p", "scene__caption", caption));
      scene.appendChild(label);
    }
    brand(scene);
    return scene;
  }

  function renderPhoto(item) {
    var content = item.content || {};
    if (!content.src) throw new Error("photo scene missing content.src");
    return buildPhotoScene(content.src, content.fit, content.focus, null, item.id);
  }

  // Every playlist item comes up exactly once per loop — there's no
  // per-item weighting. A thin/low-variety pool (2 photos) can still feel
  // over-shown at that same cadence as everything else, so content.showEvery
  // throttles it: skip this slot on all but 1 of every N passes. A skipped
  // pass throws, which the engine already treats as "move on immediately,"
  // (verified by tests/engine.test.mjs) so this reads as the item simply not
  // being in rotation that time, not as a stall or an error.
  var passCounters = {};

  function throttled(itemId, showEvery) {
    if (!showEvery || showEvery <= 1) return false;
    passCounters[itemId] = (passCounters[itemId] || 0) + 1;
    return passCounters[itemId] % showEvery !== 0;
  }

  function renderPhotoPool(item, data) {
    var content = item.content || {};
    if (throttled(item.id, content.showEvery)) {
      throw new Error("throttled: showing 1 in " + content.showEvery + " passes");
    }
    // content.source names a hand-curated set (content/artwork/curated/<id>/)
    // instead of the general recency-weighted gallery pool — used for
    // standalone categories like "in-uniform" and "military-art" that aren't
    // tied to a specific program or event. The default (no source) pool is
    // the scraped gallery plus "gen-pop-additions" — hand-picked photos
    // dropped in locally rather than pulled from the website scrape, folded
    // into the same general rotation rather than given their own scene.
    var photos = content.source
      ? curatedSet(data, content.source)
      : ((data.gallery && data.gallery.photos) || []).concat(curatedSet(data, "gen-pop-additions"));
    if (photos.length === 0) throw new Error("photo pool '" + (content.source || "gallery") + "' is empty");

    var poolKey = content.source || "gallery";

    var photo = drawPhotos(poolKey, photos, 1)[0];
    if (!photo) throw new Error("photo pool has no usable photos left");
    return buildPhotoScene(photo.src, "cover", null, content.eyebrow, photo.id, photo.caption);
  }

  function renderCustom(item) {
    var content = item.content || {};
    if (!content.src) throw new Error("custom scene missing content.src");
    var scene = el("div", "scene scene--custom");
    scene.appendChild(img("scene__photo-img", content.src, "content", item.id));
    return scene;
  }

  function buildEventScene(evt, data) {
    var scene = el("div", "scene scene--event");
    // evt.programId is set PC-side (sources/calendar/index.mjs) by matching
    // the event title against a known program's keywords, so a "Pottery
    // with resident potter Sophia" event shows an actual pottery photo
    // instead of a random farm photo.
    if (LOGO_PROGRAM_IDS.indexOf(evt.programId) !== -1) {
      if (!appendPartnerLogo(scene, data, evt.programId)) appendWash(scene, data, evt.programId);
    } else if (GRAPHIC_PROGRAM_IDS.indexOf(evt.programId) !== -1) {
      if (!appendEventGraphic(scene, data, evt.programId)) appendWash(scene, data, evt.programId);
    } else {
      appendWash(scene, data, evt.programId);
    }
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
    var content = item.content || {};
    var upcoming = upcomingEvents(data, 999, 0, { excludeTitleContains: content.excludeTitleContains });
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
    var upcoming = upcomingEvents(data, content.limit || 8, content.offset || 0, { titleContains: content.titleContains });
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

  // Quiet hours: a plain black frame with no images to warm, so it can
  // never be skipped as "unusable" and never costs a preload budget.
  function renderBlank() {
    return el("div", "scene scene--blank");
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
    renderError: renderError,
    renderBlank: renderBlank,
    markImageFailed: markImageFailed,
    setTimeZone: setTimeZone
  };
})();
