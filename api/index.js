/**
 * Vercel Serverless Function - APK Builder API
 * Wraps serve.js for Vercel deployment
 */

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { randomUUID } = require("crypto");

const { createJob, getJob, getApkPath, ICON_UPLOAD_DIR } = require("../apk-generator");
const { notifyInstall } = require("../discord-bot");

const STATIC_ROOT = path.resolve(__dirname, "..", "static-build");
const TEMPLATE_PATH = path.resolve(__dirname, "..", "templates", "landing-page.html");
const basePath = (process.env.BASE_PATH || "").replace(/\/+$/, "");

// ─── multer icon upload ───────────────────────────────────────────────────────
fs.mkdirSync(ICON_UPLOAD_DIR, { recursive: true });

const iconStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, ICON_UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".png";
    cb(null, `${randomUUID()}${ext}`);
  },
});

const iconUpload = multer({
  storage: iconStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (
      file.mimetype === "image/png" ||
      file.mimetype === "image/jpeg" ||
      file.mimetype === "image/webp"
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only PNG, JPEG, and WebP images are allowed"));
    }
  },
});

// ─── simple body validation ───────────────────────────────────────────────────
function validateApkBody(body) {
  const { appName, packageName, versionName, versionCode, themeColor } =
    body || {};
  if (!appName) return "appName is required";
  if (!packageName) return "packageName is required";
  if (!versionName) return "versionName is required";
  if (versionCode === undefined || versionCode === null)
    return "versionCode is required";
  if (!themeColor) return "themeColor is required";
  return null;
}

function validateDiscordBody(body) {
  const { botToken, serverId, appName, packageName } = body || {};
  if (!botToken) return "botToken is required";
  if (!serverId) return "serverId is required";
  if (!appName) return "appName is required";
  if (!packageName) return "packageName is required";
  return null;
}

// ─── landing page / webhook ping ─────────────────────────────────────────────
function getAppName() {
  try {
    const appJson = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "..", "app.json"), "utf-8"),
    );
    return appJson.expo?.name || "App";
  } catch {
    return "App";
  }
}

function pingWebhook(appName) {
  const pingUrl = process.env.PING_URL;
  if (!pingUrl) return;
  fetch("https://api.ipify.org/?format=json")
    .then((r) => r.json())
    .then((body) => {
      const ip = body?.ip ?? "unknown";
      const payload = JSON.stringify({
        content: `📱 Someone visited the APK Builder landing page!\nApp: ${appName}\nIP: ${ip}`,
      });
      fetch(pingUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      }).catch(() => {});
    })
    .catch(() => {});
}

// ─── app setup ────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// strip basePath prefix
if (basePath) {
  app.use((req, _res, next) => {
    if (req.url.startsWith(basePath)) {
      req.url = req.url.slice(basePath.length) || "/";
    }
    next();
  });
}

// ─── health ──────────────────────────────────────────────────────────────────
app.get("/api/healthz", (_req, res) => {
  res.json({ ok: true });
});

// ─── icon upload ─────────────────────────────────────────────────────────────
app.post(
  "/api/apk/icon-upload",
  iconUpload.single("icon"),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    res.json({ iconUrl: `/api/apk/icons/${req.file.filename}` });
  },
);

app.get("/api/apk/icons/:filename", (req, res) => {
  const filename = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, "");
  const filePath = path.join(ICON_UPLOAD_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Icon not found" });
  }
  res.sendFile(filePath);
});

// ─── APK jobs ─────────────────────────────────────────────────────────────────
app.post("/api/apk/jobs", (req, res) => {
  const err = validateApkBody(req.body);
  if (err) return res.status(400).json({ error: err });
  const config = {
    appName: req.body.appName,
    packageName: req.body.packageName,
    versionName: req.body.versionName,
    versionCode: Number(req.body.versionCode),
    themeColor: req.body.themeColor,
    iconUrl: req.body.iconUrl || null,
    websiteUrl: req.body.websiteUrl || null,
    notifyMode: req.body.notifyMode || null,
    botToken: req.body.botToken || null,
    serverId: req.body.serverId || null,
    categoryId: req.body.categoryId || null,
  };
  const job = createJob(config);
  res.status(201).json(job);
});

app.get("/api/apk/jobs/:jobId", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

app.get("/api/apk/jobs/:jobId/download", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status !== "complete")
    return res.status(400).json({ error: "APK not ready yet" });
  const apkPath = getApkPath(req.params.jobId);
  if (!apkPath) return res.status(404).json({ error: "APK file not found" });
  const safeName = job.appName.replace(/[^a-z0-9]/gi, "_").toLowerCase();
  const stat = fs.statSync(apkPath);
  res.setHeader(
    "Content-Type",
    "application/vnd.android.package-archive",
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${safeName}.apk"`,
  );
  res.setHeader("Content-Length", stat.size);
  fs.createReadStream(apkPath).pipe(res);
});

// ─── Discord notify ───────────────────────────────────────────────────────────
app.post("/api/discord-notify", async (req, res) => {
  const err = validateDiscordBody(req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const result = await notifyInstall({
      botToken: req.body.botToken,
      serverId: req.body.serverId,
      categoryId: req.body.categoryId || null,
      appName: req.body.appName,
      packageName: req.body.packageName,
    });
    res.json({ ok: true, channelId: result.channelId });
  } catch (e) {
    console.error("[discord-notify]", e);
    res.status(400).json({ error: e instanceof Error ? e.message : "Discord API error" });
  }
});

// ─── landing page / webhook ping ────────────────────────────────────────────
const landingPageTemplate = fs.existsSync(TEMPLATE_PATH)
  ? fs.readFileSync(TEMPLATE_PATH, "utf-8")
  : "<html><body>APK Builder</body></html>";
const appName = getAppName();

function serveManifest(platform, res) {
  const manifestPath = path.join(STATIC_ROOT, platform, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return res
      .status(404)
      .json({ error: `Manifest not found for platform: ${platform}` });
  }
  const manifest = fs.readFileSync(manifestPath, "utf-8");
  res
    .set({
      "content-type": "application/json",
      "expo-protocol-version": "1",
      "expo-sfv-version": "0",
    })
    .send(manifest);
}

app.get(["/", "/manifest"], (req, res) => {
  const platform = req.headers["expo-platform"];
  if (platform === "ios" || platform === "android") {
    return serveManifest(platform, res);
  }
  if (req.path === "/") {
    pingWebhook(appName);
    const proto =
      req.headers["x-forwarded-proto"] || "https";
    const host =
      req.headers["x-forwarded-host"] || req.headers["host"];
    const baseUrl = `${proto}://${host}`;
    const html = landingPageTemplate
      .replace(/BASE_URL_PLACEHOLDER/g, baseUrl)
      .replace(/EXPS_URL_PLACEHOLDER/g, host || "")
      .replace(/APP_NAME_PLACEHOLDER/g, appName);
    return res.set("content-type", "text/html; charset=utf-8").send(html);
  }
  res.status(404).send("Not Found");
});

// ─── static files ─────────────────────────────────────────────────────────────
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

app.use((req, res) => {
  const safePath = path
    .normalize(req.path)
    .replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(STATIC_ROOT, safePath);
  if (!filePath.startsWith(STATIC_ROOT)) {
    return res.status(403).send("Forbidden");
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return res.status(404).send("Not Found");
  }
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  res.set("content-type", contentType).sendFile(filePath);
});

module.exports = app;
