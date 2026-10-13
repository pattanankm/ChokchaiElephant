import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import config from './config/index.js';
import routes from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../public');

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

  // เสิร์ฟหน้าเว็บ Frontend (index.html, activities.html, admin.html ฯลฯ)
  app.use(express.static(publicDir, { extensions: ['html'] }));

  // ถ้าผู้ใช้เปิดผ่านเบราว์เซอร์แล้วไม่พบเส้นทาง ให้เปิด index.html
  app.get('*', (req, res, next) => {
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
