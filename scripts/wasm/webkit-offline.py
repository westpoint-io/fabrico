#!/usr/bin/python3 -I
"""Open the offline examples file in WebKitGTK and check every board in it, from outside the page.

Playwright's WebKit build doesn't run on every Linux, and WebKitGTK is the engine a GNOME reader
opens a local HTML file in, so this leg drives the system WebKitGTK through its GObject bindings.

USAGE
  xvfb-run -a -s "-screen 0 1280x1024x24" /usr/bin/python3 -I scripts/wasm/webkit-offline.py \\
      frontend/dist-examples/fabrico-examples.html

It needs the system Python, because the `gi` bindings live in the system packages:
  Arch:   webkit2gtk-4.1 python-gobject python-cairo xorg-server-xvfb
  Ubuntu: xvfb python3-gi python3-gi-cairo gir1.2-webkit2-4.1 libgl1-mesa-dri

WHAT IT CHECKS. It opens a 1280 by 900 window holding a WebView, with a script that runs before the
page and wraps HTMLCanvasElement.prototype.getContext to count WebGL contexts and context losses
on canvases that were shown (the embed marks the canvases it tears down on purpose), records page
errors, and presses Continue whenever a caption holds a board. Then it reads the board names from
the page's sections and, for each one:

  1. sets location.hash to the board's section and waits until the board reports it is mounted
     and running;
  2. picks 0.25x and presses Restart, so its belts move whatever tick it had reached, slowly
     enough that a single item crossing a belt stays in view for several snapshots;
  3. reads the board's frame count twice and fails unless it rose by 2 or more;
  4. takes snapshots of the visible view with WebKitWebView.get_snapshot, which reads what
     WebKitGTK composited rather than anything the page says, and hashes each of the board's belt
     tiles (coordinates from the board's probe, read before and after each snapshot, keeping the
     tiles in both lists) every 500 ms until one tile's pixels differ, at most 20 tries. The probe
     leaves out tiles under machines, cables and the DOM chips over the canvas, so the pixels that
     change are belts and items. A board that doesn't draw is reported and the harness goes on to
     the next step, so one run names every board that failed;
  5. picks 4x, waits for the end tick, and reads the hash badge's verdict and text, and compares
     the end hash with examples/boards/hashes.manifest read from the repo beside this script.

OUTPUT, one line on stdout:
  WEBKIT_OFFLINE boards=<sections> drawn=<n> matched=<n>
and a `webkit-offline: ...` line on stderr for each failure.

EXIT CODES
  0  every board in the file drew and ended on its pinned hash, with no lost context and no page
     error.
  1  a board failed, a wait timed out, the page threw, or the page holds no board.
  2  usage error, or the file doesn't exist.
"""

import hashlib
import json
import os
import sys

# The window belongs on the X display xvfb-run made. GTK picks Wayland first when the shell that
# started it runs in a Wayland session, which would put the window on the user's own desktop and
# let the compositor throttle a window it doesn't show; so the X11 backend is forced, before GTK
# loads.
os.environ["GDK_BACKEND"] = "x11"
os.environ.pop("WAYLAND_DISPLAY", None)

import gi  # noqa: E402

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

WIDTH, HEIGHT = 1280, 900
POLL_MS = 500
SNAPSHOT_TRIES = 20
MOUNT_TIMEOUT_MS = 30_000
FRAMES_TIMEOUT_MS = 10_000
END_TIMEOUT_MS = 180_000
READY_TIMEOUT_MS = 30_000
WATCHDOG_S = 900

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, "..", "..", "examples", "boards", "hashes.manifest")

# Runs in the page before any of its own scripts. The context counting follows the Playwright
# legs' installGlCounter: a canvas counts as shown once a frame sees it in the document.
BEFORE_PAGE = r"""
(function () {
  var entries = [];
  var lost = 0;
  var errors = [];
  window.addEventListener('error', function (e) { errors.push(String(e.message)); });
  window.addEventListener('unhandledrejection', function (e) { errors.push('unhandled rejection: ' + String(e.reason)); });
  function markShown() {
    for (var i = 0; i < entries.length; i++) {
      if (!entries[i].shown && entries[i].canvas.isConnected) entries[i].shown = true;
    }
  }
  function watch() { markShown(); requestAnimationFrame(watch); }
  requestAnimationFrame(watch);
  var original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type) {
    var ctx = original.apply(this, arguments);
    var isGl = type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl';
    if (isGl && ctx !== null && !entries.some(function (e) { return e.ctx === ctx; })) {
      var entry = { canvas: this, ctx: ctx, shown: false };
      entries.push(entry);
      this.addEventListener('webglcontextlost', function () {
        markShown();
        if (entry.shown && !entry.canvas.hasAttribute('data-fab-teardown')) lost += 1;
      });
    }
    return ctx;
  };
  window.__fabGl = {
    counts: function () {
      markShown();
      var alive = entries.filter(function (e) { return !e.ctx.isContextLost(); });
      return {
        live: alive.filter(function (e) { return e.shown; }).length,
        lost: lost,
        made: entries.length
      };
    },
    errors: function () { return errors.slice(); }
  };
  setInterval(function () {
    var boards = document.querySelectorAll('fabrico-board');
    for (var i = 0; i < boards.length; i++) {
      var root = boards[i].shadowRoot;
      var play = root && root.querySelector('button[data-control="play"][aria-label="Continue"]');
      if (play && !play.disabled) play.click();
    }
  }, 50);
})();
"""


class Failure(Exception):
    """A check failed; the message names the board and what was seen."""


def board_js(name, body):
    """A page expression that finds the board by name as `el` and returns JSON of `body`."""
    return (
        "(function(){var el=document.querySelector('fabrico-board[name=\"%s\"]');"
        "if(el===null)return JSON.stringify({missing:true});"
        "return JSON.stringify(%s);})()" % (name, body)
    )


def set_speed_js(name, value):
    """Pick a speed in the board's select, the way a reader's choice fires `change`."""
    return board_js(name, "(function(s){s.value='%s';s.dispatchEvent(new Event('change'));return s.value;})"
                          "(el.shadowRoot.querySelector('select'))" % value)


def probe_js(name):
    return board_js(name, "el.fabricoProbe()")


def manifest_hashes():
    """The pinned end hash of every board, by board id, from hashes.manifest."""
    out = {}
    with open(MANIFEST, encoding="utf-8") as f:
        for line in f:
            parts = line.split()
            if len(parts) != 3 or not parts[0].startswith("examples/boards/"):
                continue
            rel = parts[0][len("examples/boards/") : -len(".board.ron")]
            out[rel.replace("/", "-")] = (int(parts[1]), parts[2])
    return out


def tile_key(rect):
    """A tile's cell and its box on screen. When the page's layout moves the board, its tiles get
    new keys rather than counting as changed pixels."""
    return "%d,%d@%.2f,%.2f,%.2f,%.2f" % (rect["cellX"], rect["cellY"], rect["x"], rect["y"], rect["width"], rect["height"])


def tile_hashes(surface, tiles, keep, scale):
    """sha256 of the snapshot's pixels inside each tile (CSS px, viewport-relative) whose key is in
    `keep`, by tile key."""
    surface.flush()
    width, height, stride = surface.get_width(), surface.get_height(), surface.get_stride()
    data = bytes(surface.get_data())
    out = {}
    for rect in tiles:
        key = tile_key(rect)
        if key not in keep:
            continue
        x0 = max(0, int(round(rect["x"] * scale)))
        y0 = max(0, int(round(rect["y"] * scale)))
        x1 = min(width, int(round((rect["x"] + rect["width"]) * scale)))
        y1 = min(height, int(round((rect["y"] + rect["height"]) * scale)))
        if x1 - x0 < 1 or y1 - y0 < 1:
            continue
        digest = hashlib.sha256()
        for y in range(y0, y1):
            digest.update(data[y * stride + x0 * 4 : y * stride + x1 * 4])
        out[key] = digest.hexdigest()
    return out


def fold_sample(seen, sample):
    """Add each new tile key's hash to `seen`; True when a tile already there has new pixels."""
    changed = False
    for key, value in sample.items():
        if key not in seen:
            seen[key] = value
        elif seen[key] != value:
            changed = True
    return changed


def check_file(pinned, counts):
    """The checks, as a generator. Each `yield` is a request the driver below answers."""
    deadline_ready = GLib.get_monotonic_time() + READY_TIMEOUT_MS * 1000
    while True:
        ready = yield ("js", "JSON.stringify(customElements.get('fabrico-board')!==undefined)")
        if ready:
            break
        if GLib.get_monotonic_time() > deadline_ready:
            raise Failure("the page never defined <fabrico-board>")
        yield ("sleep", POLL_MS)

    names = yield (
        "js",
        "JSON.stringify(Array.from(document.querySelectorAll('main > section fabrico-board'))"
        ".map(function(e){return e.getAttribute('name');}))",
    )
    counts["boards"] = len(names)
    if not names:
        raise Failure("the page holds no board section")
    inner_width = yield ("js", "JSON.stringify(window.innerWidth)")

    for name in names:
        yield ("js", "JSON.stringify(location.hash = '#%s')" % name)

        waited = 0
        while True:
            p = yield ("js", probe_js(name))
            if p.get("missing"):
                raise Failure("%s: no board element by that name" % name)
            if p["state"] == "running" and p["mounted"]:
                break
            if p["state"] == "error" or waited >= MOUNT_TIMEOUT_MS:
                raise Failure("%s: never mounted and ran (state %s, mounted %s, noWebGL %s, error %r)"
                              % (name, p["state"], p["mounted"], p["noWebGL"], p["error"]))
            yield ("sleep", POLL_MS)
            waited += POLL_MS

        # A quarter speed, then Restart: some boards carry a single item over their longest belt
        # for well under a second at 1x, so the slower run gives the snapshots time to see it.
        yield ("js", set_speed_js(name, "0.25"))
        yield ("js", board_js(name, "el.shadowRoot.querySelector('button[data-control=\"restart\"]').click()===undefined"))

        frames_before = (yield ("js", probe_js(name)))["frames"]
        waited = 0
        while True:
            yield ("sleep", POLL_MS)
            waited += POLL_MS
            frames = (yield ("js", probe_js(name)))["frames"]
            if frames - frames_before >= 2:
                break
            if waited >= FRAMES_TIMEOUT_MS:
                raise Failure("%s: its frame count went from %d to %d in %d ms" % (name, frames_before, frames, waited))

        first = None
        seen = {}
        samples = 0
        drew = False
        for _ in range(SNAPSHOT_TRIES):
            tiles = (yield ("js", probe_js(name)))["beltTiles"]
            if not tiles:
                yield ("sleep", POLL_MS)
                continue
            surface = yield ("snap",)
            still = {tile_key(t) for t in (yield ("js", probe_js(name)))["beltTiles"]}
            # The snapshot is in device pixels and the tiles in CSS px.
            sample = tile_hashes(surface, tiles, still, surface.get_width() / inner_width)
            samples += 1
            if not sample:
                # The board moved while the snapshot was taken, so no tile is in both lists.
                yield ("sleep", POLL_MS)
                continue
            if first is None:
                first = sample
                seen = dict(sample)
            elif fold_sample(seen, sample):
                drew = True
                break
            yield ("sleep", POLL_MS)
        if first is None:
            counts["failures"].append("%s: reports no belt tiles on screen" % name)
        elif not drew:
            counts["failures"].append("%s: its %d belt tiles showed the same pixels in %d snapshots over %d ms"
                                      % (name, len(seen), samples, (samples - 1) * POLL_MS))
        else:
            counts["drawn"] += 1
        if not drew:
            print("webkit-offline: %s" % counts["failures"][-1], file=sys.stderr, flush=True)

        yield ("js", set_speed_js(name, "4"))
        waited = 0
        while True:
            p = yield ("js", probe_js(name))
            if p["verdict"] is not None:
                break
            if waited >= END_TIMEOUT_MS:
                raise Failure("%s: at tick %d of %d after %d ms at 4x" % (name, p["tick"], p["endTick"], waited))
            yield ("sleep", POLL_MS)
            waited += POLL_MS
        badge = yield ("js", board_js(name, "el.shadowRoot.querySelector('.badge').textContent.trim()"))
        want = pinned.get(name)
        if want is None:
            raise Failure("%s: hashes.manifest has no line for it" % name)
        if p["verdict"] != "match" or p["tick"] != want[0] or p["endHash"] != want[1]:
            raise Failure("%s: ended on tick %d with hash %s, verdict %s; pinned tick %d hash %s"
                          % (name, p["tick"], p["endHash"], p["verdict"], want[0], want[1]))
        if badge != "final state %s match" % want[1][:8]:
            raise Failure("%s: the badge reads %r" % (name, badge))

        gl = yield ("js", "JSON.stringify(window.__fabGl.counts())")
        if gl["lost"] != 0:
            raise Failure("%s: %d WebGL contexts lost on mounted boards" % (name, gl["lost"]))
        errors = yield ("js", "JSON.stringify(window.__fabGl.errors())")
        if errors:
            raise Failure("%s: the page threw: %s" % (name, "; ".join(errors)))
        counts["matched"] += 1
        print("webkit-offline: %s %s (%d snapshots) and ended on tick %d, %s match, live contexts %d"
              % (name, "drew" if drew else "didn't draw", samples, p["tick"], want[1][:8], gl["live"]),
              file=sys.stderr, flush=True)


def main():
    if len(sys.argv) != 2:
        print("usage: webkit-offline.py <fabrico-examples.html>", file=sys.stderr)
        return 2
    if not os.environ.get("DISPLAY"):
        print("webkit-offline: DISPLAY is unset. Run it under xvfb-run.", file=sys.stderr)
        return 2
    page = os.path.abspath(sys.argv[1])
    if not os.path.isfile(page):
        print("webkit-offline: %s doesn't exist. Run scripts/build-embed.sh first." % page, file=sys.stderr)
        return 2
    pinned = manifest_hashes()

    content = WebKit2.UserContentManager()
    content.add_script(WebKit2.UserScript.new(
        BEFORE_PAGE,
        WebKit2.UserContentInjectedFrames.TOP_FRAME,
        WebKit2.UserScriptInjectionTime.START,
        None,
        None,
    ))
    view = WebKit2.WebView.new_with_user_content_manager(content)
    window = Gtk.Window()
    window.set_default_size(WIDTH, HEIGHT)
    view.set_size_request(WIDTH, HEIGHT)
    window.add(view)
    window.show_all()

    counts = {"boards": 0, "drawn": 0, "matched": 0, "failures": []}
    result = {"failure": None}
    gen = check_file(pinned, counts)

    def finish(failure):
        if result["failure"] is None and failure is not None:
            result["failure"] = failure
        Gtk.main_quit()

    def advance(send=None, throw=None):
        try:
            request = gen.throw(throw) if throw is not None else gen.send(send)
        except StopIteration:
            finish(None)
            return
        except Failure as e:
            finish(str(e))
            return
        except Exception as e:  # noqa: BLE001 - any harness error fails the run
            finish("harness error: %s: %s" % (type(e).__name__, e))
            return
        kind = request[0]
        if kind == "js":
            def done(obj, res):
                try:
                    value = obj.evaluate_javascript_finish(res)
                    advance(send=json.loads(value.to_string()))
                except GLib.Error as e:
                    advance(throw=Failure("page script failed: %s" % e.message))
            view.evaluate_javascript(request[1], -1, None, None, None, done)
        elif kind == "sleep":
            GLib.timeout_add(request[1], lambda: advance() and False)
        elif kind == "snap":
            def snapped(obj, res):
                try:
                    advance(send=obj.get_snapshot_finish(res))
                except GLib.Error as e:
                    advance(throw=Failure("get_snapshot failed: %s" % e.message))
            view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, snapped)
        else:
            finish("harness error: unknown request %r" % (kind,))

    started = {"done": False}

    def on_load(_view, event):
        # Start once: the checks move between sections by hash, which loads nothing new.
        if event == WebKit2.LoadEvent.FINISHED and not started["done"]:
            started["done"] = True
            advance()

    def on_failed(_view, _event, uri, error):
        finish("the page didn't load: %s (%s)" % (uri, error.message))
        return True

    def watchdog():
        finish("timed out after %d s" % WATCHDOG_S)
        return False

    view.connect("load-changed", on_load)
    view.connect("load-failed", on_failed)
    GLib.timeout_add_seconds(WATCHDOG_S, watchdog)
    view.load_uri(GLib.filename_to_uri(page, None))
    Gtk.main()

    print("WEBKIT_OFFLINE boards=%d drawn=%d matched=%d" % (counts["boards"], counts["drawn"], counts["matched"]),
          flush=True)
    if result["failure"] is not None:
        print("webkit-offline: %s" % result["failure"], file=sys.stderr, flush=True)
        return 1
    for failure in counts["failures"]:
        print("webkit-offline: %s" % failure, file=sys.stderr, flush=True)
    if counts["boards"] == 0 or counts["drawn"] != counts["boards"] or counts["matched"] != counts["boards"]:
        print("webkit-offline: %d boards, %d drew, %d matched" % (counts["boards"], counts["drawn"], counts["matched"]),
              file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
