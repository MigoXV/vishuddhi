import { appendFile, chmod, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DIST_DIR = path.resolve("dist");
const APPIMAGE_CACHE_DIR = path.join(os.homedir(), ".cache", "electron-builder", "appimage");

const ARCH_TO_RUNTIME = {
  x64: "runtime-x64",
  arm64: "runtime-arm64",
  ia32: "runtime-ia32",
  arm: "runtime-armv7l",
};

const ARCH_TO_MKSQUASHFS_DIR = {
  x64: "linux-x64",
  arm64: "linux-arm64",
  ia32: "linux-ia32",
  arm: "linux-arm32",
};

async function main() {
  const appImages = await findAppImages(DIST_DIR);
  if (appImages.length === 0) {
    return;
  }

  const runtimePath = await resolveAppImageRuntime();
  const mksquashfsPath = await resolveMksquashfs();

  for (const artifactPath of appImages) {
    await patchArtifact(artifactPath, runtimePath, mksquashfsPath);
  }
}

async function findAppImages(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".AppImage"))
    .map((entry) => path.join(directory, entry.name));
}

async function resolveAppImageRuntime() {
  const runtimeName = ARCH_TO_RUNTIME[process.arch];
  if (!runtimeName) {
    throw new Error(`Unsupported arch for AppImage runtime patching: ${process.arch}`);
  }

  const cacheSubdirs = await listCacheSubdirs();
  for (const subdir of cacheSubdirs) {
    const candidate = path.join(APPIMAGE_CACHE_DIR, subdir, runtimeName);
    if (await exists(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to locate ${runtimeName} under ${APPIMAGE_CACHE_DIR}`);
}

async function resolveMksquashfs() {
  const bundledDir = ARCH_TO_MKSQUASHFS_DIR[process.arch];
  if (bundledDir) {
    const cacheSubdirs = await listCacheSubdirs();
    for (const subdir of cacheSubdirs) {
      const candidate = path.join(APPIMAGE_CACHE_DIR, subdir, bundledDir, "mksquashfs");
      if (await exists(candidate)) {
        return candidate;
      }
    }
  }

  const result = spawnSync("mksquashfs", ["-version"], {
    stdio: "ignore",
  });
  if (result.status === 0) {
    return "mksquashfs";
  }

  throw new Error("Unable to locate mksquashfs for AppImage repacking");
}

async function listCacheSubdirs() {
  let entries;
  try {
    entries = await readdir(APPIMAGE_CACHE_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

async function exists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function patchArtifact(artifactPath, runtimePath, mksquashfsPath) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vishuddhi-appimage-"));

  try {
    run(artifactPath, ["--appimage-extract"], {
      cwd: tempRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
      },
    });

    const appRunPath = path.join(tempRoot, "squashfs-root", "AppRun");
    const appRunSource = await readFile(appRunPath, "utf8");
    const patchedAppRun = patchAppRun(appRunSource);
    await writeFile(appRunPath, patchedAppRun, "utf8");

    const squashfsPath = path.join(tempRoot, "patched.squashfs");
    run(mksquashfsPath, [
      path.join(tempRoot, "squashfs-root"),
      squashfsPath,
      "-all-root",
      "-noappend",
      "-no-progress",
      "-quiet",
      "-no-xattrs",
      "-no-fragments",
    ]);

    const patchedArtifactPath = path.join(tempRoot, path.basename(artifactPath));
    await concatenate(runtimePath, squashfsPath, patchedArtifactPath);
    await chmod(patchedArtifactPath, 0o755);
    await rm(artifactPath, { force: true });
    await rename(patchedArtifactPath, artifactPath);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function patchAppRun(source) {
  const directLaunch = '      exec "$BIN"\n';
  const directLaunchPatched =
    '      exec "$BIN" --no-sandbox --ozone-platform=x11 --disable-gpu\n';
  const forwardedLaunch = '      exec "$BIN" "${args[@]}"\n';
  const forwardedLaunchPatched =
    '      exec "$BIN" --no-sandbox --ozone-platform=x11 --disable-gpu "${args[@]}"\n';

  let next = source.replace(directLaunch, directLaunchPatched);
  next = next.replace(forwardedLaunch, forwardedLaunchPatched);

  if (next === source) {
    throw new Error("Unable to patch AppRun with Linux startup flags");
  }

  return next;
}

async function concatenate(runtimePath, squashfsPath, outputPath) {
  await writeFile(outputPath, await readFile(runtimePath));
  await appendFile(outputPath, await readFile(squashfsPath));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

await main();
