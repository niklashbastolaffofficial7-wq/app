/**
 * APK build tools setup (apktool, aapt2, keystore).
 * Pure Node.js / built-in modules only — no TypeScript.
 */

const { execSync, exec } = require("child_process");
const { existsSync, mkdirSync, writeFileSync, chmodSync } = require("fs");
const path = require("path");
const { promisify } = require("util");
const AdmZip = require("adm-zip");

const execAsync = promisify(exec);

const TOOLS_DIR = path.join(process.cwd(), ".apk-tools");
const APKTOOL_JAR = path.join(TOOLS_DIR, "apktool.jar");
const KEYSTORE_PATH = path.join(TOOLS_DIR, "debug.keystore");
const AAPT2_PATH = path.join(TOOLS_DIR, "aapt2");
const APK_OUTPUT_DIR = path.join(process.cwd(), ".apk-output");

module.exports = {
  TOOLS_DIR,
  APKTOOL_JAR,
  KEYSTORE_PATH,
  AAPT2_PATH,
  APK_OUTPUT_DIR,
  ensureToolsReady,
  findJava,
};

async function ensureToolsReady() {
  mkdirSync(TOOLS_DIR, { recursive: true });
  mkdirSync(APK_OUTPUT_DIR, { recursive: true });
  await ensureApktool();
  await ensureAapt2();
  await ensureKeystore();
}

async function ensureApktool() {
  if (existsSync(APKTOOL_JAR)) {
    console.log("[apk-setup] apktool already present");
    return;
  }
  console.log("[apk-setup] Downloading apktool...");
  const url =
    "https://github.com/iBotPeaches/Apktool/releases/download/v2.9.3/apktool_2.9.3.jar";
  await execAsync(`curl -L --fail -o "${APKTOOL_JAR}" "${url}"`, {
    timeout: 120000,
  });
  console.log("[apk-setup] apktool downloaded");
}

async function ensureAapt2() {
  if (existsSync(AAPT2_PATH)) {
    console.log("[apk-setup] aapt2 already present");
    return;
  }
  console.log("[apk-setup] Downloading aapt2...");
  const aapt2JarPath = path.join(TOOLS_DIR, "aapt2.jar");
  const url =
    "https://dl.google.com/android/maven2/com/android/tools/build/aapt2/8.2.2-10154469/aapt2-8.2.2-10154469-linux.jar";
  await execAsync(`curl -L --fail -o "${aapt2JarPath}" "${url}"`, {
    timeout: 120000,
  });
  console.log("[apk-setup] Extracting aapt2...");
  const zip = new AdmZip(aapt2JarPath);
  const entry = zip.getEntry("aapt2");
  if (!entry) throw new Error("aapt2 binary not found in jar");
  const data = entry.getData();
  writeFileSync(AAPT2_PATH, data);
  chmodSync(AAPT2_PATH, 0o755);
  console.log("[apk-setup] Patching aapt2 ELF for NixOS...");
  const interpreter = getSystemInterpreter();
  await execAsync(
    `patchelf --set-interpreter "${interpreter}" "${AAPT2_PATH}"`,
    { timeout: 15000 },
  );
  const rpath = getNixLibPath();
  if (rpath) {
    await execAsync(`patchelf --set-rpath "${rpath}" "${AAPT2_PATH}"`, {
      timeout: 15000,
    });
  }
  console.log("[apk-setup] aapt2 ready");
}

function getSystemInterpreter() {
  try {
    const out = execSync(
      "patchelf --print-interpreter $(which patchelf) 2>/dev/null",
      { encoding: "utf-8" },
    ).trim();
    if (out) return out;
  } catch {}
  return "/nix/store/zdpby3l6azi78sl83cpad2qjpfj25aqx-glibc-2.40-66/lib/ld-linux-x86-64.so.2";
}

function getNixLibPath() {
  try {
    const out = execSync(
      "patchelf --print-rpath $(which patchelf) 2>/dev/null",
      { encoding: "utf-8" },
    ).trim();
    if (out) return out;
  } catch {}
  try {
    const glibcDir = execSync(
      "dirname $(patchelf --print-interpreter $(which patchelf)) 2>/dev/null",
      { encoding: "utf-8" },
    ).trim();
    if (glibcDir) return glibcDir;
  } catch {}
  return "";
}

async function ensureKeystore() {
  if (existsSync(KEYSTORE_PATH)) {
    console.log("[apk-setup] keystore already present");
    return;
  }
  console.log("[apk-setup] Generating debug keystore...");
  const java = findJava();
  const keytool = java.replace(/java$/, "keytool");
  const cmd = [
    `"${keytool}"`,
    "-genkey",
    "-v",
    "-keystore",
    `"${KEYSTORE_PATH}"`,
    "-alias",
    "androiddebugkey",
    "-keyalg",
    "RSA",
    "-keysize",
    "2048",
    "-validity",
    "10000",
    "-storepass",
    "android",
    "-keypass",
    "android",
    "-dname",
    '"CN=Android Debug,O=Android,C=US"',
  ].join(" ");
  await execAsync(cmd, { timeout: 30000 });
  console.log("[apk-setup] keystore generated");
}

function findJava() {
  const candidates = [
    "/run/current-system/sw/bin/java",
    "/nix/var/nix/profiles/default/bin/java",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  try {
    const which = execSync("which java", { encoding: "utf-8" }).trim();
    if (which) return which;
  } catch {}
  return "java";
}
