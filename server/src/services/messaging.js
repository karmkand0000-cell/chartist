// OTP / notification delivery. 'log' prints to server logs (dev). Plug an SMS/email provider here for production.
import { config } from '../config.js';
export async function deliverOtp(target, code, purpose) {
  if (config.otpDelivery === 'log' || config.dev) {
    console.log(`[OTP] ${purpose} → ${target}: ${code}`);
    return;
  }
  if (config.otpDelivery === 'smtp' && target.includes('@')) {
    // Free option: any SMTP (e.g. Gmail app password / Brevo free tier). Uses nodemailer if installed.
    const nodemailer = await import('nodemailer').catch(() => null);
    if (!nodemailer) return console.warn('nodemailer not installed; OTP not sent');
    const t = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
    await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: target, subject: `${config.brokerName} OTP`, text: `Your OTP is ${code}. It is valid for 5 minutes. Never share it with anyone.` });
  }
  // SMS: integrate a DLT-registered SMS provider here (mandatory in India for transactional SMS).
}
