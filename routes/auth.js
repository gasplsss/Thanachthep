const express = require('express');
const router = express.Router();

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const authRequired = require('../middleware/authRequired');
const auth = require('../controllers/authController');

const pool = require('../db');
const transporter = require('../config/mailer');

const APP_NAME = process.env.APP_NAME || 'LOOK UP';
const FRONTEND = process.env.FRONTEND_ORIGIN || 'http://localhost:3000';
const MAIL_DRIVER = (process.env.MAIL_DRIVER || 'disabled').toLowerCase();

// --- auth เดิมของคุณ ---
router.post('/register', auth.register);
router.post('/login', auth.login);
router.get('/me', authRequired, auth.me);
router.post('/logout', auth.logout);

// Helper สำหรับ mysql2/promise
const q = async (sql, params = []) => {
  const [rows] = await pool.query(sql, params);
  return rows;
};
const genToken = () => crypto.randomBytes(32).toString('hex');

// ======================= ลืมรหัสผ่านแบบลิงก์อีเมล =======================
// POST /api/auth/forgot  { email }
router.post('/forgot', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ message: 'กรุณากรอกอีเมล' });

    const user = (await q('SELECT id, email FROM users WHERE email=? LIMIT 1', [email]))[0];

    // ตอบเหมือนกันแม้ไม่พบ เพื่อลดการเดาอีเมล
    if (!user) return res.json({ ok: true, message: 'ถ้ามีอีเมลนี้ ระบบได้ส่งลิงก์รีเซ็ตแล้ว' });

    const token = genToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 ชม.

    await q('DELETE FROM password_resets WHERE email=? OR expires_at < NOW()', [email]);
    await q('INSERT INTO password_resets (user_id,email,token,expires_at,used) VALUES (?,?,?,?,0)',
      [user.id, user.email, token, expiresAt]
    );

    const resetLink = `${FRONTEND}/reset.html?token=${token}`;

    if (MAIL_DRIVER === 'smtp' && transporter) {
      await transporter.sendMail({
        from: process.env.MAIL_FROM || `${APP_NAME} <${process.env.SMTP_USER}>`,
        to: user.email,
        subject: `[${APP_NAME}] ลิงก์สำหรับตั้งรหัสผ่านใหม่`,
        text: `คลิกลิงก์เพื่อตั้งรหัสผ่านใหม่ (มีอายุ 1 ชั่วโมง): ${resetLink}`,
        html: `<p>คลิกลิงก์เพื่อตั้งรหัสผ่านใหม่ (มีอายุ 1 ชั่วโมง):<br>
               <a href="${resetLink}">${resetLink}</a></p>`,
      });
      return res.json({ ok: true, message: 'ส่งลิงก์ตั้งรหัสผ่านแล้ว โปรดตรวจสอบอีเมล' });
    }

    // โหมด dev/disabled: คืน token ให้ redirect ได้ทันที
    return res.json({ ok: true, token });
  } catch (err) {
    console.error('POST /api/auth/forgot', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในระบบ' });
  }
});

// GET /api/auth/reset/verify?token=...
router.get('/reset/verify', async (req, res) => {
  try {
    const { token } = req.query || {};
    if (!token) return res.status(400).json({ message: 'ไม่มี token' });

    const pr = (await q(
      'SELECT email, expires_at, used FROM password_resets WHERE token=? LIMIT 1',
      [token]
    ))[0];

    if (!pr) return res.status(400).json({ message: 'token ไม่ถูกต้อง' });
    if (pr.used) return res.status(400).json({ message: 'token ถูกใช้ไปแล้ว' });
    if (new Date(pr.expires_at) < new Date()) return res.status(400).json({ message: 'token หมดอายุ' });

    res.json({ ok: true, email: pr.email });
  } catch (err) {
    console.error('GET /api/auth/reset/verify', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในระบบ' });
  }
});

// POST /api/auth/reset  { token, password }
router.post('/reset', async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) return res.status(400).json({ message: 'ข้อมูลไม่ครบ' });

    const pr = (await q(
      'SELECT id, user_id, expires_at, used FROM password_resets WHERE token=? AND used=0 LIMIT 1',
      [token]
    ))[0];

    if (!pr) return res.status(400).json({ message: 'token ไม่ถูกต้อง' });
    if (new Date(pr.expires_at) < new Date()) return res.status(400).json({ message: 'token หมดอายุ' });

    const hash = await bcrypt.hash(password, 10);
    await q('UPDATE users SET password=? WHERE id=?', [hash, pr.user_id]);
    await q('UPDATE password_resets SET used=1 WHERE id=?', [pr.id]);

    res.json({ ok: true, message: 'ตั้งรหัสผ่านใหม่สำเร็จ' });
  } catch (err) {
    console.error('POST /api/auth/reset', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในระบบ' });
  }
});

module.exports = router;
