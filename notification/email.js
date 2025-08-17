import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

export async function sendTradeEmail({ subject, html, attachmentPath }) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  const info = await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: process.env.MAIL_TO,
    subject,
    html,
    attachments: attachmentPath ? [{
      filename: 'entry.png',
      path: attachmentPath,
      contentType: 'image/png'
    }] : []
  });

  return info.messageId;
}
