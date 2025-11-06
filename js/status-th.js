// public/js/status-th.js
window.STATUS = [
  { value: 'pending',   label: 'ยืนยันการสั่งซื้อและรอชำระเงิน' },
  { value: 'paid',      label: 'ชำระเงินสำเร็จรอการตรวจสอบ' },
  { value: 'shipped',   label: 'ชำระเงินสมบูรณ์รอจัดส่ง' },
  { value: 'completed', label: 'ดำเนินการจัดส่งเรียบร้อย' },
  { value: 'canceled',  label: 'สถานะยกเลิกคำสั่งซื้อ' },
];
window.statusTH = v => (window.STATUS.find(s => s.value === v)?.label) || v;
window.statusPillTH = v => {
  const label = window.statusTH(v);
  const cls = v === 'pending' ? 'pill warn'
            : v === 'canceled' ? 'pill danger'
            : 'pill ok';
  return `<span class="${cls}">${label}</span>`;
};

// ชำระเงิน
window.PAY_TH = { pending:'รอพิจารณา', verified:'ชำระเงินสำเร็จ', rejected:'ถูกปฏิเสธ' };
window.payBadgeTH = v => {
  const cls = v === 'verified' ? 'pill ok' : (v === 'rejected' ? 'pill danger' : 'pill warn');
  return `<span class="${cls}">${window.PAY_TH[v] || v}</span>`;
};

// สรุปสั้นบนการ์ด
window.orderShortTH = v => ({
  completed:'สำเร็จ', shipped:'จัดส่งแล้ว', paid:'ชำระแล้ว', pending:'รอชำระ/ตรวจสอบ', canceled:'ยกเลิก'
}[v] || v);
