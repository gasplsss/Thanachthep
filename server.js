// server.js
require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

// ★ สร้าง app ก่อนใช้ทุกครั้ง
const app = express();

// middleware พื้นฐาน
app.use(cors({
  origin: process.env.CORS_ORIGIN || true,
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// เสิร์ฟไฟล์ static
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get('/user.html', (_req, res) => res.redirect('/user/user.html'));

// mount routes หลังจากมี app แล้ว
const authRoutes  = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const userRoutes  = require('./routes/user'); 
const catalogRoutes = require('./routes/catalog');

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/user', userRoutes);
app.use('/api/catalog', catalogRoutes); 

// health check
app.get('/health', (_req, res) => res.json({ ok: true }));

// error handler กลาง (กันเซิฟล้มเวลา throw)
app.use((err, req, res, _next) => {
  console.error('🔥 SERVER ERROR:', err);
  res.status(500).json({ message: 'เกิดข้อผิดพลาดภายในระบบ' });
});

// start server
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
