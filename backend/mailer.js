// backend/mailer.js
// Nodemailer — sends OTP verification emails
const nodemailer = require('nodemailer');
require('dotenv').config();

function getTransporter() {
  const port   = parseInt(process.env.SMTP_PORT || '587');
  const secure = port === 465;

  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure,
    // For port 587, use STARTTLS (not SSL). For 465, use SSL.
    requireTLS: !secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: {
      // Accept self-signed certs in dev
      rejectUnauthorized: process.env.NODE_ENV === 'production',
    },
  });
}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function otpExpiresAt() {
  const d = new Date(Date.now() + 10 * 60 * 1000);
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

async function sendOTPEmail({ to, name, otp, type }) {
  // Guard: must have SMTP config
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error('SMTP_USER and SMTP_PASS are not set in your .env file. See README for Gmail App Password setup.');
  }

  const subject = type === 'signup'
    ? 'Verify your Agentra MailSense account'
    : 'Reset your Agentra MailSense password';

  const actionText = type === 'signup'
    ? 'complete your registration'
    : 'reset your password';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:'Segoe UI',Arial,sans-serif;background:#f0f4ff;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#0d1117;border-radius:16px;overflow:hidden;border:1px solid rgba(99,130,255,0.2);">
      <tr><td style="background:linear-gradient(135deg,#4f6ef7,#2dd4bf);padding:28px 32px;">
        <div style="color:white;font-size:20px;font-weight:600;margin:0;">Agentra MailSense</div>
        <div style="color:rgba(255,255,255,0.8);font-size:13px;margin-top:4px;">AI-powered email automation</div>
      </td></tr>
      <tr><td style="padding:32px;">
        <p style="color:#a0aec0;font-size:15px;margin:0 0 12px;">Hi ${name || 'there'},</p>
        <p style="color:#a0aec0;font-size:14px;line-height:1.6;margin:0 0 24px;">Use the code below to <strong style="color:#e2e8f8;">${actionText}</strong>. This code expires in <strong style="color:#e2e8f8;">10 minutes</strong>.</p>
        <div style="background:#131a26;border:1px solid rgba(99,130,255,0.25);border-radius:12px;text-align:center;padding:24px;margin:0 0 24px;">
          <div style="font-size:40px;font-weight:700;letter-spacing:14px;color:#6b88ff;font-family:'Courier New',monospace;">${otp}</div>
          <div style="font-size:12px;color:#4a5270;margin-top:10px;">Expires in 10 minutes · Do not share this code</div>
        </div>
        <p style="color:#4a5270;font-size:13px;margin:0;">If you didn't request this, please ignore this email.</p>
      </td></tr>
      <tr><td style="border-top:1px solid rgba(99,130,255,0.1);padding:16px 32px;">
        <div style="font-size:12px;color:#3a4260;">© 2025 Agentra. All rights reserved.</div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  const transporter = getTransporter();

  // Verify connection before sending
  await transporter.verify().catch(err => {
    throw new Error(`SMTP connection failed: ${err.message}. Check SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in your .env`);
  });

  const info = await transporter.sendMail({
    from:    process.env.SMTP_FROM || `Agentra MailSense <${process.env.SMTP_USER}>`,
    to,
    subject,
    html,
    text: `Your Agentra MailSense verification code is: ${otp}. Valid for 10 minutes.`,
  });

  console.log(`[Mailer] OTP sent to ${to} — MessageID: ${info.messageId}`);
  return info;
}

module.exports = { generateOTP, otpExpiresAt, sendOTPEmail };
