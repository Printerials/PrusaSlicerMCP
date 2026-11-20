import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isGuiCommandLine } from "../../src/gui/index.ts";
import { FLATPAK_ID, linuxConfigHome, locateFlatpak, sandboxDirectories, slicerCommand, type LocatedBinary } from "../../src/slicer/locate.ts";

const flatpak: LocatedBinary = {
  path: "/usr/bin/flatpak",
  appBundle: null,
  flatpak: { id: FLATPAK_ID, files: "/var/lib/flatpak/app/com.prusa3d.PrusaSlicer/current/active/files" },
  source: "default",
};

test("a Flatpak's CLI runs prusa-slicer itself, with the directories outside home added", async () => {
  const dir = await mkdtemp(join(tmpdir(), "psmcp-platform-"));
  try {
    const input = join(dir, "cube.stl");
    await writeFile(input, "solid\nendsolid\n");
    const home = join(homedir(), "models", "part.stl");
    const command = slicerCommand(flatpak, ["--datadir", dir, "--export-gcode", "-o", join(dir, "out", "cube.gcode"), input, home]);
    assert.equal(command.file, "/usr/bin/flatpak");
    assert.deepEqual(command.args, [
      "run",
      `--filesystem=${dir}`,
      `--filesystem=${join(dir, "out")}`,
      "--command=prusa-slicer",
      FLATPAK_ID,
      "--datadir",
      dir,
      "--export-gcode",
      "-o",
      join(dir, "out", "cube.gcode"),
      input,
      home,
    ]);
    // The GUI goes through the app's entrypoint, as its desktop file does.
    assert.deepEqual(slicerCommand(flatpak, []).args, ["run", "--command=prusa-slicer", FLATPAK_ID]);
    assert.deepEqual(slicerCommand(flatpak, [], "gui").args, ["run", FLATPAK_ID]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a binary that is not a Flatpak runs as it is", () => {
  const binary: LocatedBinary = { path: "/usr/bin/prusa-slicer", appBundle: null, flatpak: null, source: "path" };
  assert.deepEqual(slicerCommand(binary, ["--info", "/tmp/a.stl"]), { file: "/usr/bin/prusa-slicer", args: ["--info", "/tmp/a.stl"] });
});

test("sandboxDirectories leaves out home, relative paths, values and paths flatpak cannot take", () => {
  const home = homedir();
  assert.deepEqual(
    sandboxDirectories(["--center", "125,110", "relative/file.stl", join(home, "a.stl"), home, "/tmp/x/y.stl", "/tmp/x/z.stl", "/srv/a:b/c.stl"], home),
    ["/tmp/x"],
  );
});

test("locateFlatpak finds the app in an installation, per-user first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "psmcp-flatpak-"));
  try {
    const user = join(dir, "user");
    const system = join(dir, "system");
    for (const installation of [user, system]) {
      await mkdir(join(installation, "app", FLATPAK_ID, "current", "active", "files", "bin"), { recursive: true });
    }
    await writeFile(join(system, "app", FLATPAK_ID, "current", "active", "files", "bin", "prusa-slicer"), "");
    assert.equal(locateFlatpak(null, [user, system]), null, "without flatpak on PATH there is nothing to run it with");
    assert.equal(locateFlatpak("/usr/bin/flatpak", [user, system])?.flatpak?.files, join(system, "app", FLATPAK_ID, "current", "active", "files"));
    await writeFile(join(user, "app", FLATPAK_ID, "current", "active", "files", "bin", "prusa-slicer"), "");
    assert.equal(locateFlatpak("/usr/bin/flatpak", [user, system])?.flatpak?.files, join(user, "app", FLATPAK_ID, "current", "active", "files"));
    assert.equal(locateFlatpak("/usr/bin/flatpak", [join(dir, "none")]), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a Flatpak keeps its config under ~/.var/app", () => {
  assert.equal(linuxConfigHome(flatpak), join(homedir(), ".var", "app", FLATPAK_ID, "config"));
});

test("isGuiCommandLine: PrusaSlicer without an action is the GUI", () => {
  // The Flatpak's GUI, from its entrypoint, and from the desktop file with a file.
  assert.equal(isGuiCommandLine(["/app/bin/prusa-slicer"]), true);
  assert.equal(isGuiCommandLine(["/app/bin/prusa-slicer", "/run/user/1000/doc/abc/part.3mf"]), true);
  assert.equal(isGuiCommandLine(["/Applications/PrusaSlicer.app/Contents/MacOS/PrusaSlicer", "--single-instance", "a.stl"]), true);
  assert.equal(isGuiCommandLine(["PrusaSlicer-2.8.1+linux-x64-GTK3.AppImage"]), true);
  // CLI runs, and processes that only carry the name in their arguments (measured in a Flatpak).
  assert.equal(isGuiCommandLine(["prusa-slicer", "--printer-profile", "X", "--export-gcode", "-o", "/tmp/a.gcode", "/tmp/a.stl"]), false);
  assert.equal(isGuiCommandLine(["prusa-slicer", "--save=/tmp/c.ini"]), false);
  assert.equal(isGuiCommandLine(["prusa-slicer", "--preset-update-list"]), false);
  assert.equal(isGuiCommandLine(["prusa-slicer", "--gcodeviewer", "a.gcode"]), false);
  assert.equal(isGuiCommandLine(["bwrap", "--args", "36", "--", "prusa-slicer"]), false);
  assert.equal(isGuiCommandLine(["node", "/home/someone/PrusaSlicerMCP/src/index.ts"]), false);
});
