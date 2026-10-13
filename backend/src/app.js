import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import config from './config/index.js';
import routes from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../public');

const caseMap = new Map();

function resolveStaticFile(baseDir, reqPath) {
  if (caseMap.has(reqPath)) return caseMap.get(reqPath);

  const parts = reqPath.split('/').filter(Boolean);
  let currentDir = baseDir;

  for (const part of parts) {
    if (!fs.existsSync(currentDir)) {
      caseMap.set(reqPath, null);
      return null;
    }
    const files = fs.readdirSync(currentDir);
    let match = files.find((f) => f === part);
    if (!match) {
      match = files.find((f) => f.toLowerCase() === part.toLowerCase());
    }
    if (!match) {
      caseMap.set(reqPath, null);
      return null;
    }
    currentDir = path.join(currentDir, match);
  }

  caseMap.set(reqPath, currentDir);
  return currentDir;
}

export function createApp() {
  const app = express();

  // รันหลัง nginx หรือ reverse proxy จึงต้องเชื่อ X-Forwarded-For
  app.set('trust proxy', 1);

  // ปิด CSP ชั่วคราวเพื่อให้โหลด CDN Tailwind, Google Fonts และแผนที่ได้
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(
    cors((req, callback) => {
      const { origin, host } = req.headers;
      // หน้าเว็บกับ /api อยู่โดเมนเดียวกันหลัง nginx — เบราว์เซอร์ยังแนบ Origin มากับ POST อยู่ดี
      // เทียบกับ Host แทนการไล่ใส่ทุกโดเมนใน CORS_ORIGINS จึงเปิดผ่าน IP ในวง LAN หรือลิงก์สาธารณะชั่วคราวได้เลย
      // (เว็บอื่นปลอมไม่ได้: เบราว์เซอร์เป็นคนตั้ง Origin และ Host เอง)
      const sameOrigin = Boolean(origin) && URL.canParse(origin) && new URL(origin).host === host;

      // ไม่มี origin = เรียกจาก curl / Postman
      if (!origin || sameOrigin || config.corsOrigins.includes('*') || config.corsOrigins.includes(origin)) {
        return callback(null, {
          origin: true,
          credentials: true,
          // ให้หน้าเว็บที่เปิดข้าม origin (Live Server) อ่านชื่อไฟล์ส่งออกได้
          exposedHeaders: ['Content-Disposition'],
        });
      }
      return callback(new Error(`CORS: ไม่อนุญาต origin ${origin}`));
    }),
  );
  // webhook ของ Stripe ต้องได้ body ดิบ ๆ ไว้ตรวจลายเซ็น จึงต้องดักก่อน express.json()
  app.use('/api/payments/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }));
  // การแจ้งโอนเงินพ่วงรูปสลิปมาด้วย จึงต้องรับ body ใหญ่กว่า endpoint อื่น
  app.use('/api/payments/promptpay/notify', express.json({ limit: '6mb' }));
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));

  if (!config.isProduction) app.use(morgan('dev'));
  else app.use(morgan('combined'));

  app.use('/api', routes);

  // Case-insensitive file resolver สำหรับ Linux (เช่น Render)
  // แก้ปัญหาชื่อไฟล์ .JPG vs .jpg หรือตัวพิมพ์เล็ก-ใหญ่ใน URL รูปภาพ
  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) return next();

    const decodedPath = decodeURIComponent(req.path);
    const ext = path.extname(decodedPath);
    if (!ext) return next();

    const directPath = path.join(publicDir, decodedPath);
    try {
      if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) {
        return next();
      }
    } catch {}

    const resolved = resolveStaticFile(publicDir, decodedPath);
    if (resolved) {
      try {
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
          return res.sendFile(resolved);
        }
      } catch {}
    }

    next();
  });

  // เสิร์ฟหน้าเว็บ Frontend (index.html, activities.html, admin.html ฯลฯ)
  app.use(express.static(publicDir, { extensions: ['html'] }));

  // ถ้าผู้ใช้เปิดผ่านเบราว์เซอร์แล้วไม่พบเส้นทาง (เฉพาะคำขอ HTML ที่ไม่มีนามสกุลไฟล์) ให้เปิด index.html
  app.get('*', (req, res, next) => {
    if (path.extname(req.path)) {
      return next();
    }
    if (req.accepts('html')) {
      return res.sendFile(path.join(publicDir, 'index.html'));
    }
    next();
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
