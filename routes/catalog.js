// routes/catalog.js
const express = require('express');
const router = express.Router();
const pool = require('../db');

// แบรนด์ (สำหรับหน้า shop)
router.get('/brands', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, brand_name FROM brands ORDER BY brand_name ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error('catalog /brands', err);
    res.status(500).json({ message: 'โหลดแบรนด์ล้มเหลว' });
  }
});

// สินค้ารวม + filter (สาธารณะ)
router.get('/products', async (req, res) => {
  try {
    const { brand_id, type, is_new, q } = req.query;
    const wh = ['p.is_active = 1'];
    const params = [];

    if (brand_id) { wh.push('p.brand_id = ?'); params.push(brand_id); }

    if (type) {
      // map ค่าจาก UI -> ค่าไทยใน schema
      const map = { Eyeglasses: 'สายตา', Sunglasses: 'กันแดด', Filter: 'กรองแสง' };
      const t = map[type] || type;
      wh.push('p.glasses_type = ?'); params.push(t);
    }

    if (is_new === '1') wh.push('p.is_new = 1');

    if (q && q.trim()) {
      const kw = `%${q.trim()}%`;
      wh.push('(p.name LIKE ? OR p.model LIKE ?)');
      params.push(kw, kw);
    }

    const sql = `
      SELECT p.*, b.brand_name
      FROM products p
      LEFT JOIN brands b ON b.id = p.brand_id
      WHERE ${wh.join(' AND ')}
      ORDER BY p.created_at DESC
      LIMIT 200
    `;
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('catalog /products', err);
    res.status(500).json({ message: 'โหลดสินค้าล้มเหลว' });
  }
});

// รายละเอียดสินค้า (สาธารณะ)
router.get('/products/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.*, b.brand_name
       FROM products p
       LEFT JOIN brands b ON b.id = p.brand_id
       WHERE p.id = ? AND p.is_active = 1
       LIMIT 1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ message: 'ไม่พบสินค้า' });
    res.json(rows[0]);
  } catch (err) {
    console.error('catalog /products/:id', err);
    res.status(500).json({ message: 'โหลดรายละเอียดล้มเหลว' });
  }
});

module.exports = router;
