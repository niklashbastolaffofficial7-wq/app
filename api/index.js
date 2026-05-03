/**
 * Vercel Serverless Function - APK Builder API
 * Lightweight version for Vercel (without APK generation)
 */

const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Health Check ────────────────────────────────────────────────────────────
app.get("/api/healthz", (_req, res) => {
  res.json({ ok: true, message: "APK Builder API is running on Vercel" });
});

// ─── Landing Page ────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers["host"];
  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>APK Builder</title>
      <style>
        body {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: #fff;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100vh;
          margin: 0;
        }
        .container {
          text-align: center;
          padding: 40px;
          background: rgba(0, 0, 0, 0.2);
          border-radius: 10px;
          backdrop-filter: blur(10px);
        }
        h1 { font-size: 48px; margin: 0 0 20px; }
        p { font-size: 18px; margin: 10px 0; }
        .status { color: #4ade80; font-weight: bold; }
        .url { color: #60a5fa; font-family: monospace; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>📱 APK Builder</h1>
        <p>Server is <span class="status">running</span> on Vercel</p>
        <p>API Base: <span class="url">${proto}://${host}</span></p>
        <p style="margin-top: 30px; font-size: 14px; opacity: 0.8;">
          ⚠️ APK generation requires local environment with Java/apktool<br>
          Consider self-hosting on Railway.app or Replit
        </p>
      </div>
    </body>
    </html>
  `;
  res.set("content-type", "text/html; charset=utf-8").send(html);
});

// ─── API Status ──────────────────────────────────────────────────────────────
app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    platform: "vercel",
    features: {
      apkGeneration: false,
      reason: "Requires Java/apktool (not available in Vercel serverless)"
    },
    recommendation: "Deploy to Railway.app or Replit for full APK building"
  });
});

// ─── Catch-all 404 ───────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: "Not Found",
    path: req.path,
    method: req.method
  });
});

// ─── Error Handler ───────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({
    error: "Internal Server Error",
    message: err.message
  });
});

module.exports = app;
