const nodemailer = require("nodemailer");

// Builds the transporter from .env (SMTP_HOST/PORT/USER/PASS). If SMTP_HOST isn't set — e.g. while
// developing locally without real credentials — sendMail() below logs the email to the console
// instead of sending it, so OTPs are still visible while testing.
function buildTransporter() {
    if (!process.env.SMTP_HOST) return null;

    const port = Number(process.env.SMTP_PORT) || 587;

    return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure: port === 465,
        auth: process.env.SMTP_USER
            ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
            : undefined,
    });
}

const transporter = buildTransporter();

// The one place every outgoing email goes through — signup OTP, login re-verification OTP,
// forgot-password OTP and resend-OTP all call this, so there is a single place to change
// the sender address, add logging, or swap providers later.
async function sendMail({ to, subject, text, html }) {
    const from = process.env.EMAIL_FROM || '"Courtside" <notifications@courtside.com>';

    if (!transporter) {
        console.log(
            `\n--- Email not sent (SMTP_HOST is not set in .env) ---\n` +
            `To: ${to}\nSubject: ${subject}\n\n${text || html}\n` +
            `-------------------------------------------------------\n`
        );
        return { skipped: true };
    }

    return transporter.sendMail({ from, to, subject, text, html });
}

// Shared HTML for every OTP email, so signup / login / forgot-password / resend all look the same
// instead of each controller building its own copy of this markup.
function otpEmailHtml({ name, otp, intro }) {
    return `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 30px; color: #333;">
            <h2>Courtside</h2>
            <p>Hi ${name || "there"},</p>
            <p>${intro}</p>
            <div style="background: #f5f5f5; padding: 20px; text-align: center; border-radius: 8px; margin: 25px 0;">
                <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px;">${otp}</span>
            </div>
            <p>This code is only valid for a short time. If you didn't request it, you can ignore this email.</p>
            <p>Regards,<br><strong>Courtside Team</strong></p>
        </div>
    `;
}

// Convenience wrapper for the OTP case specifically — pass a name, an otp and one line of
// context, get a properly formatted email out. Used by signup, login, forgotPassword and resendOtp.
async function sendOtpEmail({ to, name, otp, subject, intro }) {
    return sendMail({
        to,
        subject,
        text: `${intro} Your OTP is: ${otp}`,
        html: otpEmailHtml({ name, otp, intro }),
    });
}

module.exports = { sendMail, sendOtpEmail };
