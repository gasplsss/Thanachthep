const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('../db');

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES || '7d' });
}

exports.register = async (req, res) => {
  try {
    const { full_name, email, password, phone } = req.body || {};
    if (!full_name || !email || !password) {
      return res.status(400).json({ message: 'กรอกข้อมูลไม่ครบ' });
    }

    const conn = await pool.getConnection();
    try {
      const [dup] = await conn.query('SELECT id FROM users WHERE email = ?', [email]);
      if (dup.length) return res.status(409).json({ message: 'อีเมลนี้ถูกใช้แล้ว' });

      const roleId = 2; // 1=admin, 2=user
      const hash = await bcrypt.hash(password, 10);
      await conn.query(
        'INSERT INTO users (full_name, email, password, phone, role_id) VALUES (?, ?, ?, ?, ?)',
        [full_name, email, hash, phone || null, roleId]
      );
      return res.status(201).json({ message: 'สมัครสำเร็จ' });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error('REGISTER', e);
    return res.status(500).json({ message: 'server error' });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password)
      return res.status(400).json({ message: 'กรุณากรอกอีเมลและรหัสผ่าน' });

    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        'SELECT id, full_name, email, password, role_id, is_active FROM users WHERE email = ?',
        [email]
      );
      if (!rows.length) return res.status(401).json({ message: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });

      const user = rows[0];
      if (!user.is_active) return res.status(403).json({ message: 'บัญชีถูกปิดการใช้งาน' });

      const isBcrypt = typeof user.password === 'string' && user.password.startsWith('$2');
      let ok = false;
      if (isBcrypt) {
        ok = await bcrypt.compare(password, user.password);
      } else {
        ok = (password === user.password);
      }
      if (!ok) {
        return res.status(401).json({ message: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
      }

      // Seamless upgrade: if stored as plain, rehash now
      if (!isBcrypt) {
        try {
          const newHash = await bcrypt.hash(password, 10);
          await conn.query('UPDATE users SET password=? WHERE id=?', [newHash, user.id]);
        } catch (_) { /* ignore upgrade failures */ }
      }

      const token = signToken({
        id: user.id,
        email: user.email,
        role_id: user.role_id,
        full_name: user.full_name
      });

      res.cookie('token', token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
        maxAge: 7 * 24 * 60 * 60 * 1000
      });

      return res.json({
        message: 'เข้าสู่ระบบสำเร็จ',
        user: {
          id: user.id,
          full_name: user.full_name,
          email: user.email,
          role_id: user.role_id
        }
      });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error('LOGIN', e);
    return res.status(500).json({ message: 'server error' });
  }
};

exports.me = async (_req, res) => {
  return res.json({ user: _req.user });
};

exports.logout = async (_req, res) => {
  res.clearCookie('token', { httpOnly: true, sameSite: 'lax', secure: false });
  return res.json({ message: 'ออกจากระบบสำเร็จ' });
};

