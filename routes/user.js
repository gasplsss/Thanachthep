require('dotenv').config();

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const pool = require('../db');
const authRequired = require('../middleware/authRequired');
const bcrypt = require('bcryptjs');

/* -------------------- Upload (payments) -------------------- */
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '');
    cb(null, `pay_${Date.now()}${ext}`);
  }
});
const upload = multer({ storage });

/* ============================== PROFILE ============================== */
// ข้อมูลส่วนตัว
router.get('/profile', authRequired, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, full_name, email, phone, address
       FROM users WHERE id=?`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ message: 'ไม่พบผู้ใช้' });
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /api/user/profile', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
  }
});

// แก้ไขข้อมูลส่วนตัว
router.put('/profile', authRequired, async (req, res) => {
  try {
    const { full_name, phone, address } = req.body;
    await pool.query(
      `UPDATE users SET
         full_name = COALESCE(?, full_name),
         phone     = COALESCE(?, phone),
         address   = COALESCE(?, address)
       WHERE id=?`,
      [full_name ?? null, phone ?? null, address ?? null, req.user.id]
    );
    res.json({ message: 'อัปเดตข้อมูลส่วนตัวเรียบร้อย' });
  } catch (err) {
    console.error('PUT /api/user/profile', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
  }
});

// เปลี่ยนรหัสผ่าน
router.put('/change-password', authRequired, async (req, res) => {
  try {
    const userId = req.user.id;
    const { old_password, new_password } = req.body;
    if (!old_password || !new_password) {
      return res.status(400).json({ message: 'กรอกข้อมูลไม่ครบ' });
    }
    const [[me]] = await pool.query('SELECT id, password FROM users WHERE id=?', [userId]);
    if (!me) return res.status(404).json({ message: 'ไม่พบผู้ใช้' });

    const isBcrypt = typeof me.password === 'string' && me.password.startsWith('$2');
    const ok = isBcrypt ? await bcrypt.compare(old_password, me.password)
                        : String(me.password) === String(old_password);
    if (!ok) return res.status(400).json({ message: 'รหัสผ่านเดิมไม่ถูกต้อง' });

    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password=? WHERE id=?', [hash, userId]);
    res.json({ message: 'เปลี่ยนรหัสผ่านสำเร็จ' });
  } catch (err) {
    console.error('PUT /api/user/change-password', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาด' });
  }
});

/* ============================== CART ============================== */
/**
 * หมายเหตุ:
 * - ถ้าสินค้าถูกซ่อน (is_active=0) หรือสต๊อกหมด จะไม่อนุญาตให้สั่ง
 * - ตอนดูตะกร้า จะลบรายการต้องห้ามออกอัตโนมัติ (prune) เพื่อกันออเดอร์พัง
 */

// ดูตะกร้า
router.get('/cart', authRequired, async (req, res) => {
  try {
    const userId = req.user.id;

    // มีตะกร้าหรือไม่
    const [[cart]] = await pool.query('SELECT id FROM carts WHERE user_id=?', [userId]);
    if (!cart) return res.json({ items: [], summary: { total: 0, count: 0 }, pruned: false });

    // ดึงรายการในตะกร้าพร้อมสถานะสินค้า
    const [rows] = await pool.query(
      `SELECT ci.id AS cart_item_id, ci.product_id, ci.qty,
              p.name, p.model, p.price, p.stock, p.is_active, p.image_url,
              (ci.qty * p.price) AS subtotal
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
       WHERE ci.cart_id = ?
       ORDER BY ci.id DESC`,
      [cart.id]
    );

    // คัดออก: สินค้าถูกปิดขาย หรือสต๊อก <= 0
    const invalidIds = rows
      .filter(r => !r || !r.is_active || Number(r.stock) <= 0)
      .map(r => r.cart_item_id);

    if (invalidIds.length) {
      const inClause = invalidIds.map(() => '?').join(',');
      await pool.query(`DELETE FROM cart_items WHERE id IN (${inClause})`, invalidIds);
    }

    // คำนวณใหม่เฉพาะรายการที่ยังถูกต้อง
    const validItems = rows.filter(r => r && r.is_active && Number(r.stock) > 0);
    const total = validItems.reduce((s, r) => s + Number(r.subtotal || 0), 0);

    res.json({
      items: validItems.map(({ cart_item_id, ...rest }) => rest),
      summary: { total, count: validItems.length },
      pruned: invalidIds.length > 0
    });
  } catch (err) {
    console.error('GET /api/user/cart', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในระบบ' });
  }
});

// เพิ่มสินค้าเข้าตะกร้า
router.post('/cart/add', authRequired, async (req, res) => {
  try {
    const userId = req.user.id;
    const { product_id, qty } = req.body;
    const nQty = Math.max(1, parseInt(qty || 1, 10));

    if (!product_id) return res.status(400).json({ message: 'ข้อมูลไม่ครบ (product_id)' });

    // ตรวจสินค้าและสต๊อก + ต้อง active
    const [[prod]] = await pool.query(
      'SELECT id, stock, price, is_active FROM products WHERE id=?',
      [product_id]
    );
    if (!prod) return res.status(404).json({ message: 'ไม่พบสินค้า' });
    if (!prod.is_active) return res.status(400).json({ message: 'สินค้านี้ถูกปิดการขาย' });
    if (prod.stock <= 0) return res.status(400).json({ message: 'สินค้าหมดสต๊อก' });

    // สร้างตะกร้า ถ้ายังไม่มี
    let [[cart]] = await pool.query('SELECT id FROM carts WHERE user_id=?', [userId]);
    if (!cart) {
      const [ins] = await pool.query('INSERT INTO carts (user_id) VALUES (?)', [userId]);
      cart = { id: ins.insertId };
    }

    // รวมจำนวน (กันเกินสต๊อก)
    const [[row]] = await pool.query(
      'SELECT id, qty FROM cart_items WHERE cart_id=? AND product_id=?',
      [cart.id, product_id]
    );
    const newQty = (row ? row.qty : 0) + nQty;
    if (newQty > prod.stock) {
      return res.status(400).json({ message: 'จำนวนเกินสต๊อกคงเหลือ' });
    }

    if (row) {
      await pool.query('UPDATE cart_items SET qty=? WHERE id=?', [newQty, row.id]);
    } else {
      await pool.query(
        'INSERT INTO cart_items (cart_id, product_id, qty) VALUES (?,?,?)',
        [cart.id, product_id, nQty]
      );
    }

    const [[sum]] = await pool.query(
      `SELECT COALESCE(SUM(qty),0) AS items_count FROM cart_items WHERE cart_id=?`,
      [cart.id]
    );

    res.json({
      message: 'เพิ่มลงตะกร้าแล้ว',
      cart_id: cart.id,
      product_id,
      qty: newQty,
      items_count: Number(sum.items_count || 0)
    });
  } catch (err) {
    console.error('POST /api/user/cart/add', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในระบบ' });
  }
});

// แก้จำนวนในตะกร้า
router.put('/cart/item/:product_id', authRequired, async (req, res) => {
  try {
    const userId = req.user.id;
    const pid = Number(req.params.product_id);
    const qty = Math.max(1, parseInt(req.body.qty || 1, 10));

    let [[cart]] = await pool.query('SELECT id FROM carts WHERE user_id=?', [userId]);
    if (!cart) return res.status(404).json({ message: 'ไม่พบตะกร้า' });

    const [[prod]] = await pool.query('SELECT id, stock, is_active FROM products WHERE id=?', [pid]);
    if (!prod) return res.status(404).json({ message: 'ไม่พบสินค้า' });
    if (!prod.is_active) return res.status(400).json({ message: 'สินค้านี้ถูกปิดการขาย' });
    if (qty > prod.stock) return res.status(400).json({ message: 'จำนวนเกินสต๊อก' });

    const [aff] = await pool.query(
      'UPDATE cart_items SET qty=? WHERE cart_id=? AND product_id=?',
      [qty, cart.id, pid]
    );
    if (!aff.affectedRows) return res.status(404).json({ message: 'ไม่มีสินค้านี้ในตะกร้า' });

    res.json({ message: 'อัปเดตจำนวนแล้ว' });
  } catch (err) {
    console.error('PUT /api/user/cart/item/:product_id', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในระบบ' });
  }
});

// ลบรายการจากตะกร้า
router.delete('/cart/item/:product_id', authRequired, async (req, res) => {
  try {
    const userId = req.user.id;
    const pid = Number(req.params.product_id);
    let [[cart]] = await pool.query('SELECT id FROM carts WHERE user_id=?', [userId]);
    if (!cart) return res.status(404).json({ message: 'ไม่พบตะกร้า' });

    await pool.query('DELETE FROM cart_items WHERE cart_id=? AND product_id=?', [cart.id, pid]);
    res.json({ message: 'ลบสินค้าออกจากตะกร้าแล้ว' });
  } catch (err) {
    console.error('DELETE /api/user/cart/item/:product_id', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในระบบ' });
  }
});

/* ============================== CHECKOUT ============================== */
/**
 * helper: สร้างออร์เดอร์จากตะกร้า (ใช้ Transaction)
 * - ล็อกตะกร้าผู้ใช้
 * - เช็ก p.is_active และสต๊อกปัจจุบัน
 * - ลดสต๊อกแบบอะตอมมิกด้วย UPDATE ... WHERE stock >= ?
 * - ใช้ราคา p.price ปัจจุบัน
 */
async function createOrderFromCart(conn, userId, ship = {}) {
  // 1) ล็อกตะกร้า
  const [carts] = await conn.query(
    'SELECT id FROM carts WHERE user_id=? LIMIT 1 FOR UPDATE',
    [userId]
  );
  const cart = carts[0];
  if (!cart) throw new Error('CART_EMPTY');

  // 2) ดึงรายการ + ข้อมูลสินค้า (เช็กล่าสุด)
  const [items] = await conn.query(
    `SELECT ci.product_id, ci.qty, p.price, p.stock, p.is_active
     FROM cart_items ci
     JOIN products p ON p.id = ci.product_id
     WHERE ci.cart_id=?`,
    [cart.id]
  );
  if (!items.length) throw new Error('CART_EMPTY');

  // 3) ตรวจความถูกต้อง
  const invalid = [];
  for (const it of items) {
    if (!it.is_active) invalid.push({ product_id: it.product_id, reason: 'INACTIVE' });
    else if (Number(it.qty) > Number(it.stock)) invalid.push({ product_id: it.product_id, reason: 'OUT_OF_STOCK' });
  }
  if (invalid.length) {
    const ids = invalid.map(x => x.product_id);
    const inClause = ids.map(() => '?').join(',');
    await conn.query(
      `DELETE FROM cart_items WHERE cart_id=? AND product_id IN (${inClause})`,
      [cart.id, ...ids]
    );
    const hasInactive = invalid.some(v => v.reason === 'INACTIVE');
    const hasOOS = invalid.some(v => v.reason === 'OUT_OF_STOCK');
    if (hasInactive) throw new Error('ITEMS_INACTIVE_PRUNED');
    if (hasOOS) throw new Error('OUT_OF_STOCK');
  }

  // 4) รวมยอด
  const total = items.reduce((s, it) => s + Number(it.qty) * Number(it.price), 0);

  // 5) สร้างออร์เดอร์ (status = pending)
  const [insOrder] = await conn.query(
    `INSERT INTO orders
     (user_id, status, total,
      recipient_name, ship_phone, ship_address,
      ship_subdistrict, ship_district, ship_province, ship_zipcode,
      created_at)
     VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      userId, total,
      ship.recipient_name || null,
      ship.ship_phone     || null,
      ship.ship_address   || null,
      ship.ship_subdistrict || null,
      ship.ship_district    || null,
      ship.ship_province    || null,
      ship.ship_zipcode     || null
    ]
  );
  const orderId = insOrder.insertId;

  // 6) ลดสต๊อก "อะตอมมิก" + บันทึกรายการสินค้า
  for (const it of items) {
    // ลดสต๊อกแบบป้องกัน race (ถ้าสต๊อกไม่พอ affectedRows จะเป็น 0)
    const [aff] = await conn.query(
      `UPDATE products SET stock = stock - ?
       WHERE id=? AND is_active=1 AND stock >= ?`,
      [it.qty, it.product_id, it.qty]
    );
    if (!aff.affectedRows) {
      // มีคนตัดหน้าหรือสต๊อกเปลี่ยน -> ยกเลิกทั้งทรานแซกชัน
      throw new Error('OUT_OF_STOCK');
    }

    await conn.query(
      `INSERT INTO order_items (order_id, product_id, qty, price)
       VALUES (?, ?, ?, ?)`,
      [orderId, it.product_id, it.qty, it.price]
    );
  }

  // 7) เคลียร์ตะกร้า
  await conn.query('DELETE FROM cart_items WHERE cart_id=?', [cart.id]);

  return orderId;
}

// พรีวิวเช็คเอาต์ (สรุปจากตะกร้า)
router.post('/checkout/preview', authRequired, async (req, res) => {
  try {
    const userId = req.user.id;
    const [[cart]] = await pool.query('SELECT id FROM carts WHERE user_id=?', [userId]);
    if (!cart) return res.json({ items: [], total: 0, pruned: false });

    const [items] = await pool.query(
      `SELECT ci.product_id, ci.qty,
              p.name, p.model, p.price, p.image_url, p.is_active, p.stock,
              (ci.qty * p.price) AS subtotal
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
       WHERE ci.cart_id=?`,
      [cart.id]
    );

    // ตัดของต้องห้ามเพื่อให้พรีวิวตรงกับสิ่งที่จะสั่งได้จริง
    const valid = items.filter(r => r && r.is_active && Number(r.stock) > 0);
    const total = valid.reduce((s, r) => s + Number(r.subtotal || 0), 0);
    const pruned = items.length !== valid.length;

    res.json({ items: valid, total, pruned });
  } catch (err) {
    console.error('POST /api/user/checkout/preview', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในระบบ' });
  }
});

// คอนเฟิร์มเช็คเอาต์ (สร้างออร์เดอร์จริง + ลดสต๊อก)
router.post('/checkout/confirm', authRequired, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const userId = req.user.id;
    const ship = req.body || {};
    await conn.beginTransaction();
    const orderId = await createOrderFromCart(conn, userId, ship);
    await conn.commit();
    res.json({ message: 'สร้างคำสั่งซื้อเรียบร้อย', order_id: orderId });
  } catch (err) {
    try { await conn.rollback(); } catch {}
    console.error('POST /api/user/checkout/confirm', err);
    if (err.message === 'CART_EMPTY')            return res.status(400).json({ message: 'ตะกร้าว่าง' });
    if (err.message === 'ITEMS_INACTIVE_PRUNED') return res.status(400).json({ message: 'มีสินค้าที่ถูกปิดการขายและถูกนำออกจากตะกร้าแล้ว กรุณาตรวจสอบตะกร้าอีกครั้ง' });
    if (err.message === 'OUT_OF_STOCK')          return res.status(400).json({ message: 'จำนวนเกินสต๊อกของบางรายการ กรุณาตรวจสอบตะกร้า' });
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในระบบ' });
  } finally {
    conn.release();
  }
});

// ALIAS (เผื่อฝั่งหน้าเว็บเดิมเรียก /checkout/create)
router.post('/checkout/create', authRequired, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const userId = req.user.id;
    const ship = req.body || {};
    await conn.beginTransaction();
    const orderId = await createOrderFromCart(conn, userId, ship);
    await conn.commit();
    res.json({ message: 'สร้างคำสั่งซื้อสำเร็จ', order_id: orderId });
  } catch (err) {
    try { await conn.rollback(); } catch {}
    console.error('POST /api/user/checkout/create', err);
    if (err.message === 'CART_EMPTY')            return res.status(400).json({ message: 'ตะกร้าว่าง' });
    if (err.message === 'ITEMS_INACTIVE_PRUNED') return res.status(400).json({ message: 'มีสินค้าที่ถูกปิดการขายและถูกนำออกจากตะกร้าแล้ว กรุณาตรวจสอบตะกร้าอีกครั้ง' });
    if (err.message === 'OUT_OF_STOCK')          return res.status(400).json({ message: 'จำนวนเกินสต๊อกของบางรายการ กรุณาตรวจสอบตะกร้า' });
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในระบบ' });
  } finally {
    conn.release();
  }
});

/* ============================== ORDERS ============================== */
// รายการคำสั่งซื้อของผู้ใช้
router.get('/orders', authRequired, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT o.*,
              COUNT(oi.id) AS items_count,
              COALESCE(SUM(oi.qty * oi.price), 0) AS total
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.user_id = ?
       GROUP BY o.id
       ORDER BY o.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/user/orders', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
  }
});

// รายละเอียดคำสั่งซื้อ
router.get('/orders/:id', authRequired, async (req, res) => {
  try {
    const orderId = req.params.id;

    const [[order]] = await pool.query(
      `SELECT * FROM orders WHERE id=? AND user_id=?`,
      [orderId, req.user.id]
    );
    if (!order) return res.status(404).json({ message: 'ไม่พบคำสั่งซื้อ' });

    const [items] = await pool.query(
      `SELECT oi.*, p.name, p.model, p.image_url
       FROM order_items oi
       LEFT JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id=?`,
      [orderId]
    );

    const [[payment]] = await pool.query(
      `SELECT * FROM payments WHERE order_id=? LIMIT 1`,
      [orderId]
    );

    res.json({ order, items, payment });
  } catch (err) {
    console.error('GET /api/user/orders/:id', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
  }
});

/* ============================== PAYMENTS ============================== */
// อัปโหลดหลักฐานโอนเงิน (อัปเดตซ้ำได้)
router.post('/payments', authRequired, upload.single('payment_image'), async (req, res) => {
  try {
    const { order_id } = req.body;
    if (!order_id || !req.file) {
      return res.status(400).json({ message: 'กรุณาระบุ order_id และแนบไฟล์หลักฐาน' });
    }

    const imageUrl = `/uploads/${req.file.filename}`;

    // ตรวจสิทธิ์ว่าเป็นออร์เดอร์ของผู้ใช้นี้
    const [[order]] = await pool.query(
      `SELECT id FROM orders WHERE id=? AND user_id=?`,
      [order_id, req.user.id]
    );
    if (!order) return res.status(403).json({ message: 'ไม่มีสิทธิ์อัปโหลดไฟล์นี้' });

    const [[exist]] = await pool.query(
      `SELECT id FROM payments WHERE order_id=? LIMIT 1`,
      [order_id]
    );

    if (exist) {
      await pool.query(
        `UPDATE payments SET payment_image=?, status='pending', uploaded_at=NOW() WHERE id=?`,
        [imageUrl, exist.id]
      );
    } else {
      await pool.query(
        `INSERT INTO payments (order_id, payment_image, status, uploaded_at)
         VALUES (?, ?, 'pending', NOW())`,
        [order_id, imageUrl]
      );
    }

    res.json({ message: 'อัปโหลดหลักฐานเรียบร้อย', payment_image: imageUrl });
  } catch (err) {
    console.error('POST /api/user/payments', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' });
  }
});

module.exports = router;
