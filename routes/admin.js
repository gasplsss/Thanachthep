require('dotenv').config();

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const pool = require('../db');
const authRequired = require('../middleware/authRequired');
const adminOnly = require('../middleware/adminOnly');

/* -------------------- Upload dir ensure -------------------- */
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* -------------------- Multer upload config -------------------- */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '');
    cb(null, `prod_${Date.now()}${ext}`);
  }
});
const upload = multer({ storage });

/* -------------------- Helpers (Reports) -------------------- */
function getDateRange(q) {
  let { from, to } = q || {};
  if (!from || !to) {
    const d = new Date();
    const y = d.getFullYear();
    const m = d.getMonth();
    from = new Date(y, m, 1).toISOString().slice(0, 10);
    to   = new Date(y, m + 1, 0).toISOString().slice(0, 10);
  }
  return { from, to, start: `${from} 00:00:00`, end: `${to} 23:59:59` };
}
function statusWhere(includePending) {
  return includePending
    ? `o.status IN ('pending','paid','shipped','completed')`
    : `o.status IN ('paid','shipped','completed')`;
}

/* -------------------- Stock helpers (ข้อ 2 + ใช้ในข้อ 3) -------------------- */
/**
 * ปรับสต๊อกตามรายการสินค้าในออเดอร์
 * @param {PoolConnection} conn - connection ที่อยู่ใน transaction
 * @param {number} orderId
 * @param {number} sign -1 เพื่อตัดสต๊อก, +1 เพื่อคืนสต๊อก
 */
async function adjustStockForOrder(conn, orderId, sign) {
  const [items] = await conn.query(
    `SELECT product_id, qty FROM order_items WHERE order_id=?`,
    [orderId]
  );

  for (const it of items) {
    // lock แถวสินค้าเพื่อกัน race
    const [[p]] = await conn.query(
      `SELECT stock FROM products WHERE id=? FOR UPDATE`,
      [it.product_id]
    );
    if (!p) throw new Error('PRODUCT_NOT_FOUND');

    if (sign < 0) {
      if (Number(p.stock) < Number(it.qty)) {
        throw new Error('STOCK_NOT_ENOUGH');
      }
    }

    await conn.query(
      `UPDATE products SET stock = stock + (? * ?) WHERE id=?`,
      [sign, it.qty, it.product_id]
    );
  }
}

/* ============================== BRANDS ============================== */
router.get('/brands', authRequired, adminOnly, async (_req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, brand_name FROM brands ORDER BY brand_name ASC'
    );
    res.json(rows);
  } catch (err) {
    console.error('❌ /brands error:', err);
    res.status(500).json({ message: 'ไม่สามารถดึงข้อมูลแบรนด์ได้' });
  }
});

/* ============================== PRODUCTS ============================== */
// ดึงสินค้าทั้งหมด (admin)
router.get('/products', authRequired, adminOnly, async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT p.*, b.brand_name
      FROM products p
      LEFT JOIN brands b ON b.id = p.brand_id
      ORDER BY p.id DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('❌ /products error:', err);
    res.status(500).json({ message: 'โหลดสินค้าล้มเหลว' });
  }
});

// ดึงสินค้าเดี่ยว (admin)
router.get('/products/:id', authRequired, adminOnly, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM products WHERE id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'ไม่พบสินค้า' });
    res.json(rows[0]);
  } catch (err) {
    console.error('❌ /products/:id error:', err);
    res.status(500).json({ message: 'โหลดข้อมูลสินค้าไม่สำเร็จ' });
  }
});

// เพิ่มสินค้าใหม่
router.post('/products', authRequired, adminOnly, upload.single('image'), async (req, res) => {
  try {
    const {
      brand_id, product_name, model, description,
      frame_shape, glasses_type_ui,
      lens_width_mm, bridge_mm, temple_mm, front_width_mm,
      status_stock, qty, price, is_new, created_date
    } = req.body;

    if (!product_name || !price) {
      return res.status(400).json({ message: 'กรอกชื่อสินค้าและราคา' });
    }

    // รองรับ Filter ➜ กรองแสง
    const typeMap = { Eyeglasses: 'สายตา', Sunglasses: 'กันแดด', Filter: 'กรองแสง' };
    const glasses_type = typeMap[glasses_type_ui] ?? null;

    const stock = status_stock === 'out' ? 0 : Number(qty || 0);
    const image_url = req.file ? `/uploads/${req.file.filename}` : null;

    await pool.query(
      `INSERT INTO products
        (name, brand_id, model, description, frame_shape, glasses_type,
         lens_width_mm, bridge_mm, temple_mm, front_width_mm,
         price, image_url, stock, is_new, is_active, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
      [
        product_name, brand_id || null, model || null, description || null,
        frame_shape || null, glasses_type,
        lens_width_mm || null, bridge_mm || null, temple_mm || null, front_width_mm || null,
        price, image_url, stock, is_new ? 1 : 0, created_date || new Date()
      ]
    );

    res.json({ message: 'เพิ่มสินค้าเรียบร้อย' });
  } catch (err) {
    console.error('❌ POST /products error:', err);
    res.status(500).json({ message: 'เพิ่มสินค้าไม่สำเร็จ' });
  }
});

// แก้ไขสินค้า
router.put('/products/:id', authRequired, adminOnly, upload.single('image'), async (req, res) => {
  try {
    const { id } = req.params;
    const [exists] = await pool.query('SELECT * FROM products WHERE id=?', [id]);
    if (!exists.length) return res.status(404).json({ message: 'ไม่พบสินค้า' });
    const cur = exists[0];

    const {
      brand_id, product_name, model, description,
      frame_shape, glasses_type_ui,
      lens_width_mm, bridge_mm, temple_mm, front_width_mm,
      status_stock, qty, price, is_new
    } = req.body;

    const typeMap = { Eyeglasses: 'สายตา', Sunglasses: 'กันแดด', Filter: 'กรองแสง' };
    const glasses_type = typeMap[glasses_type_ui] ?? cur.glasses_type;

    const stock = status_stock === 'out' ? 0 : Number(qty ?? cur.stock);
    const image_url = req.file ? `/uploads/${req.file.filename}` : cur.image_url;

    await pool.query(
      `UPDATE products SET
        name=?, brand_id=?, model=?, description=?,
        frame_shape=?, glasses_type=?,
        lens_width_mm=?, bridge_mm=?, temple_mm=?, front_width_mm=?,
        price=?, image_url=?, stock=?, is_new=?
       WHERE id=?`,
      [
        product_name ?? cur.name, brand_id || null, model ?? cur.model, description ?? cur.description,
        frame_shape ?? cur.frame_shape, glasses_type,
        lens_width_mm ?? cur.lens_width_mm, bridge_mm ?? cur.bridge_mm, temple_mm ?? cur.temple_mm, front_width_mm ?? cur.front_width_mm,
        price ?? cur.price, image_url, stock, is_new ?? cur.is_new, id
      ]
    );

    res.json({ message: 'อัปเดตสินค้าเรียบร้อย' });
  } catch (err) {
    console.error('❌ PUT /products/:id error:', err);
    res.status(500).json({ message: 'อัปเดตสินค้าไม่สำเร็จ' });
  }
});

// ลบสินค้า (มีดัก Foreign Key => แนะนำให้ซ่อน)
router.delete('/products/:id', authRequired, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    await pool.query('DELETE FROM products WHERE id=?', [id]);
    res.json({ message: 'ลบสินค้าเรียบร้อย' });
  } catch (err) {
    if (err && (err.code === 'ER_ROW_IS_REFERENCED_2' || err.errno === 1451)) {
      return res.status(409).json({
        message: 'ลบไม่ได้ เนื่องจากมีการอ้างอิงในระบบ แนะนำให้ “ซ่อนสินค้า” แทน',
        hint: 'เรียก PUT /api/admin/products/:id/archive เพื่อซ่อน (is_active=0) และเคลียร์ออกจากตะกร้า'
      });
    }
    console.error('❌ DELETE /products/:id error:', err);
    res.status(500).json({ message: 'ลบสินค้าไม่สำเร็จ' });
  }
});

// ซ่อนสินค้า + เคลียร์ออกจากตะกร้า
router.put('/products/:id/archive', authRequired, adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[prod]] = await conn.query('SELECT id FROM products WHERE id=?', [id]);
    if (!prod) { await conn.rollback(); return res.status(404).json({ message: 'ไม่พบสินค้า' }); }

    await conn.query('DELETE FROM cart_items WHERE product_id=?', [id]);
    await conn.query('UPDATE products SET is_active=0, stock=0, updated_at=NOW() WHERE id=?', [id]);

    await conn.commit();
    res.json({ message: 'ซ่อนสินค้าเรียบร้อย' });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    console.error('PUT /products/:id/archive error:', e);
    res.status(500).json({ message: 'ซ่อนสินค้าไม่สำเร็จ' });
  } finally {
    conn.release();
  }
});

// กู้คืนสินค้า (เปิดขาย)
router.put('/products/:id/restore', authRequired, adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const [aff] = await pool.query(
      'UPDATE products SET is_active=1, updated_at=NOW() WHERE id=?',
      [id]
    );
    if (!aff.affectedRows) return res.status(404).json({ message: 'ไม่พบสินค้า' });
    res.json({ message: 'กู้คืนสินค้าเรียบร้อย' });
  } catch (e) {
    console.error('PUT /products/:id/restore error:', e);
    res.status(500).json({ message: 'กู้คืนสินค้าไม่สำเร็จ' });
  }
});

/* ============================== USERS ============================== */
// ดึงผู้ใช้ทั้งหมด
router.get('/users', authRequired, adminOnly, async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT id, full_name, email, phone, address
      FROM users
      ORDER BY id DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('❌ /users error:', err);
    res.status(500).json({ message: 'โหลดรายชื่อผู้ใช้ไม่สำเร็จ' });
  }
});

// ดูข้อมูลผู้ใช้รายคน
router.get('/users/:id', authRequired, adminOnly, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT id, full_name, email, phone, address
      FROM users
      WHERE id=?
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'ไม่พบผู้ใช้' });
    res.json(rows[0]);
  } catch (err) {
    console.error('❌ /users/:id error:', err);
    res.status(500).json({ message: 'โหลดข้อมูลผู้ใช้ไม่สำเร็จ' });
  }
});

// ดึงคำสั่งซื้อของผู้ใช้แต่ละคน
router.get('/users/:id/orders', authRequired, adminOnly, async (req, res) => {
  try {
    const userId = req.params.id;
    const [rows] = await pool.query(`
      SELECT o.*,
             COUNT(oi.id) AS items_count,
             COALESCE(SUM(oi.qty * oi.price), 0) AS total,
             (SELECT status FROM payments p WHERE p.order_id = o.id LIMIT 1) AS payment_status
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE o.user_id = ?
      GROUP BY o.id
      ORDER BY o.created_at DESC
    `, [userId]);
    res.json(rows);
  } catch (err) {
    console.error('❌ /users/:id/orders error:', err);
    res.status(500).json({ message: 'โหลดประวัติคำสั่งซื้อไม่สำเร็จ' });
  }
});

/* ============================== ORDERS ============================== */
// รายการคำสั่งซื้อทั้งหมด
router.get('/orders', authRequired, adminOnly, async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT o.*, u.full_name, u.email,
             (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS items_count
      FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      ORDER BY o.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('❌ /orders error:', err);
    res.status(500).json({ message: 'โหลดรายการคำสั่งซื้อไม่สำเร็จ' });
  }
});

// รายละเอียดคำสั่งซื้อ
router.get('/orders/:id', authRequired, adminOnly, async (req, res) => {
  try {
    const orderId = req.params.id;
    const [[order]] = await pool.query(`
      SELECT o.*, u.full_name, u.email, u.phone
      FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      WHERE o.id=?
    `, [orderId]);

    if (!order) return res.status(404).json({ message: 'ไม่พบคำสั่งซื้อ' });

    const [items] = await pool.query(`
      SELECT oi.*, p.name, p.model, (oi.qty * oi.price) AS subtotal
      FROM order_items oi
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id=?
    `, [orderId]);

    const [[payment]] = await pool.query(
      `SELECT * FROM payments WHERE order_id=? LIMIT 1`,
      [orderId]
    );

    res.json({ order, items, payment });
  } catch (err) {
    console.error('❌ /orders/:id error:', err);
    res.status(500).json({ message: 'โหลดรายละเอียดคำสั่งซื้อไม่สำเร็จ' });
  }
});

/* -------- ข้อ 3) ตัด/คืนสต๊อกเมื่ออัปเดตสถานะคำสั่งซื้อ -------- */
router.put('/orders/:id/status', authRequired, adminOnly, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;
    const { status, tracking_no } = req.body;
    const valid = ['pending', 'paid', 'shipped', 'completed', 'canceled'];
    if (!valid.includes(status)) {
      conn.release();
      return res.status(400).json({ message: 'สถานะไม่ถูกต้อง' });
    }

    await conn.beginTransaction();

    // lock ออเดอร์ก่อน
    const [[o]] = await conn.query(
      `SELECT id, status, stock_deducted FROM orders WHERE id=? FOR UPDATE`,
      [id]
    );
    if (!o) { await conn.rollback(); conn.release(); return res.status(404).json({ message: 'ไม่พบคำสั่งซื้อ' }); }

    // หากจะเปลี่ยนเป็น paid และยังไม่เคยตัด → ตัดสต๊อก
    if (status === 'paid' && Number(o.stock_deducted) === 0) {
      await adjustStockForOrder(conn, o.id, -1);
      await conn.query(`UPDATE orders SET stock_deducted=1 WHERE id=?`, [o.id]);
    }

    // หากจะเปลี่ยนเป็น canceled และเคยตัดแล้ว → คืนสต๊อก
    if (status === 'canceled' && Number(o.stock_deducted) === 1) {
      // (ถ้ามีกติกาห้ามคืนเมื่อ shipped/completed เพิ่มเงื่อนไขได้)
      await adjustStockForOrder(conn, o.id, +1);
      await conn.query(`UPDATE orders SET stock_deducted=0 WHERE id=?`, [o.id]);
    }

    await conn.query(
      `UPDATE orders SET status=?, tracking_no=? WHERE id=?`,
      [status, tracking_no || null, o.id]
    );

    await conn.commit();
    res.json({ message: 'อัปเดตสถานะคำสั่งซื้อเรียบร้อย' });
  } catch (err) {
    try { await pool.query('ROLLBACK'); } catch {}
    console.error('❌ PUT /orders/:id/status error:', err);
    if (err && err.message === 'STOCK_NOT_ENOUGH') {
      return res.status(400).json({ message: 'สต๊อกไม่พอสำหรับการตัด' });
    }
    res.status(500).json({ message: 'อัปเดตสถานะคำสั่งซื้อไม่สำเร็จ' });
  } finally {
    try { await pool.query('UNLOCK TABLES'); } catch {}
    // ปิดคอนเนคชันที่เปิดไว้
    // (ถ้าใช้ conn ใน catch แล้ว rollback ผ่าน pool อาจไม่จำเป็น แต่เพื่อความชัวร์)
  }
});

/* -------- ผูกการอนุมัติสลิปกับการตัดสต๊อก (verified → paid) -------- */
router.put('/payments/:id/status', authRequired, adminOnly, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;
    const { status } = req.body;
    const valid = ['pending', 'verified', 'rejected'];
    if (!valid.includes(status)) {
      conn.release();
      return res.status(400).json({ message: 'สถานะไม่ถูกต้อง' });
    }

    await conn.beginTransaction();

    // lock payment & order
    const [[pay]] = await conn.query(
      `SELECT * FROM payments WHERE id=? FOR UPDATE`,
      [id]
    );
    if (!pay) { await conn.rollback(); conn.release(); return res.status(404).json({ message: 'ไม่พบข้อมูลการชำระเงิน' }); }

    const [[o]] = await conn.query(
      `SELECT id, status, stock_deducted FROM orders WHERE id=? FOR UPDATE`,
      [pay.order_id]
    );
    if (!o) { await conn.rollback(); conn.release(); return res.status(404).json({ message: 'ไม่พบคำสั่งซื้อ' }); }

    // อัปเดตสถานะสลิปก่อน
    await conn.query('UPDATE payments SET status=? WHERE id=?', [status, id]);

    if (status === 'verified') {
      // set order เป็น paid และตัดสต๊อกถ้ายังไม่ตัด
      if (o.status !== 'paid') {
        await conn.query(`UPDATE orders SET status='paid' WHERE id=?`, [o.id]);
      }
      if (Number(o.stock_deducted) === 0) {
        await adjustStockForOrder(conn, o.id, -1);
        await conn.query(`UPDATE orders SET stock_deducted=1 WHERE id=?`, [o.id]);
      }
    } else if (status === 'rejected') {
      // ถ้าเคยตัดเพราะเคยเป็น paid แล้วถูกปฏิเสธภายหลัง → ย้อนกลับ pending และคืนสต๊อก
      if (o.status === 'paid' && Number(o.stock_deducted) === 1) {
        await adjustStockForOrder(conn, o.id, +1);
        await conn.query(`UPDATE orders SET stock_deducted=0, status='pending' WHERE id=?`, [o.id]);
      } else {
        // แค่รีเซ็ตสถานะเป็น pending ถ้ายังไม่ใช่ shipped/completed
        if (['pending', 'paid'].includes(o.status)) {
          await conn.query(`UPDATE orders SET status='pending' WHERE id=?`, [o.id]);
        }
      }
    }
    // ถ้าเป็น pending ก็แค่อัปเดตสถานะสลิป ไม่ยุ่ง order

    await conn.commit();
    res.json({ message: 'อัปเดตสถานะการชำระเงินเรียบร้อย' });
  } catch (err) {
    try { await pool.query('ROLLBACK'); } catch {}
    console.error('❌ PUT /payments/:id/status error:', err);
    if (err && err.message === 'STOCK_NOT_ENOUGH') {
      return res.status(400).json({ message: 'สต๊อกไม่พอสำหรับการตัด' });
    }
    res.status(500).json({ message: 'อัปเดตสถานะการชำระเงินไม่สำเร็จ' });
  } finally {
    try { await pool.query('UNLOCK TABLES'); } catch {}
  }
});

/* ============================== PROFILE ============================== */
// คืนค่า flat object เพื่อให้ UI อ่าน email ได้ตรง ๆ
router.get('/profile', authRequired, adminOnly, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, full_name, email, role_id FROM users WHERE id=?',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ message: 'ไม่พบผู้ใช้' });
    res.json(rows[0]);
  } catch (err) {
    console.error('❌ /profile error:', err);
    res.status(500).json({ message: 'โหลดโปรไฟล์ไม่สำเร็จ' });
  }
});

/* ============================== REPORTS ============================== */
// รายงานยอดขาย
router.get('/reports/sales', authRequired, adminOnly, async (req, res) => {
  try {
    const { start, end } = getDateRange(req.query);
    const includePending = String(req.query.include_pending || '0') === '1';

    const [[sum]] = await pool.query(`
      SELECT COUNT(*) AS order_count,
             COALESCE(SUM(o.total),0) AS revenue,
             ROUND(COALESCE(AVG(o.total),0), 2) AS avg_order
      FROM orders o
      WHERE ${statusWhere(includePending)} AND o.created_at BETWEEN ? AND ?
    `, [start, end]);

    const [daily] = await pool.query(`
      SELECT DATE(o.created_at) AS date,
             COUNT(*) AS orders,
             COALESCE(SUM(o.total),0) AS revenue
      FROM orders o
      WHERE ${statusWhere(includePending)} AND o.created_at BETWEEN ? AND ?
      GROUP BY DATE(o.created_at)
      ORDER BY DATE(o.created_at) ASC
    `, [start, end]);

    res.json({
      summary: {
        orders: Number(sum?.order_count || 0),
        revenue: Number(sum?.revenue || 0),
        avg_order: Number(sum?.avg_order || 0)
      },
      daily
    });
  } catch (err) {
    console.error('❌ /reports/sales error:', err);
    res.status(500).json({ message: 'โหลดรายงานยอดขายไม่สำเร็จ' });
  }
});

// รายงานสินค้าขายดี
router.get('/reports/top-products', authRequired, adminOnly, async (req, res) => {
  try {
    const { start, end } = getDateRange(req.query);
    const includePending = String(req.query.include_pending || '0') === '1';
    const lim = Math.max(1, Math.min(parseInt(req.query.limit || '10', 10), 100));

    const [rows] = await pool.query(`
      SELECT
        oi.product_id,
        p.name,
        p.model,
        SUM(oi.qty) AS qty_sold,
        SUM(oi.qty * oi.price) AS revenue
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE ${statusWhere(includePending)} AND o.created_at BETWEEN ? AND ?
      GROUP BY oi.product_id, p.name, p.model
      ORDER BY revenue DESC
      LIMIT ${lim}
    `, [start, end]);

    res.json(rows);
  } catch (err) {
    console.error('❌ /reports/top-products error:', err);
    res.status(500).json({ message: 'โหลดรายงานสินค้าขายดีไม่สำเร็จ' });
  }
});

module.exports = router;
