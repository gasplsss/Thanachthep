// config/mailer.js — Nodemailer จากค่า .env (Gmail App Password)
const nodemailer = require('nodemailer');

const driver = (process.env.MAIL_DRIVER || 'disabled').toLowerCase();

let transporter = null;
if (driver === 'smtp') {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_PORT === '465', // true เมื่อ 465, false เมื่อ 587
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

module.exports = transporter; // อาจเป็น null ถ้า MAIL_DRIVER ไม่ใช่ smtp
