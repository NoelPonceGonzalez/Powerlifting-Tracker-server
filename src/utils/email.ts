import nodemailer from 'nodemailer';
import { config } from '../config/env';

/**
 * Configuración del transporte de correo electrónico
 */
const transporter = nodemailer.createTransport({
  host: config.email.host,
  port: config.email.port,
  secure: config.email.port === 465, // true para 465, false para otros
  auth: {
    user: config.email.user,
    pass: config.email.pass,
  },
});

/**
 * Envía un correo electrónico de verificación de cuenta
 * @param email Correo del destinatario
 * @param verificationToken Token de verificación único
 */
export const sendVerificationEmail = async (
  email: string,
  verificationToken: string
): Promise<void> => {
  const mailOptions = {
    from: `"Powerlifting Tracker" <${config.email.from || config.email.user}>`,
    to: email,
    subject: 'Tu código de verificación - Powerlifting Tracker',
    html: `
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
        <div style="padding: 40px 16px; max-width: 480px; margin: 0 auto;">
          <p style="font-size: 16px; color: #0f172a; font-weight: 700; margin-bottom: 12px;">Powerlifting Tracker</p>
          <p style="font-size: 15px; line-height: 1.5; color: #475569; margin-bottom: 24px;">
            Tu código de verificación para completar el registro:
          </p>
          <p style="font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #0f172a; margin: 24px 0; font-family: monospace;">
            ${verificationToken}
          </p>
          <p style="font-size: 13px; color: #64748b; margin-top: 24px;">
            Introduce este código en la app. Caduca en 24 horas. No lo compartas con nadie.
          </p>
        </div>
      </body>
      </html>
    `,
    text: `Powerlifting Tracker

Tu código de verificación para completar el registro: ${verificationToken}

Introduce este código en la app. Caduca en 24 horas. No lo compartas con nadie.`,
  };

  // Sin credenciales SMTP no se puede enviar. En desarrollo se saca el código por
  // consola para poder registrarse igual; en producción es un error de verdad.
  if (!config.email.enabled) {
    if (config.nodeEnv === 'production') {
      throw new Error('El envío de correo no está configurado (EMAIL_USER / EMAIL_PASS).');
    }
    console.log(`\n📧 [DEV] Sin SMTP configurado. Código de verificación para ${email}: ${verificationToken}\n`);
    return;
  }

  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    console.error('[EMAIL] Fallo enviando la verificación:', error);
    throw new Error('Hubo un error al intentar enviar el correo de verificación.');
  }
};

export const sendPasswordResetEmail = async (
  email: string,
  resetCode: string
): Promise<void> => {
  const mailOptions = {
    from: `"Powerlifting Tracker" <${config.email.from || config.email.user}>`,
    to: email,
    subject: 'Código para cambiar tu contraseña - Powerlifting Tracker',
    html: `
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
        <div style="padding: 40px 16px; max-width: 480px; margin: 0 auto;">
          <p style="font-size: 16px; color: #0f172a; font-weight: 700; margin-bottom: 12px;">Powerlifting Tracker</p>
          <p style="font-size: 15px; line-height: 1.5; color: #475569; margin-bottom: 24px;">
            Tu código para cambiar la contraseña:
          </p>
          <p style="font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #0f172a; margin: 24px 0; font-family: monospace;">
            ${resetCode}
          </p>
          <p style="font-size: 13px; color: #64748b; margin-top: 24px;">
            Introduce este código en la app. Caduca en 15 minutos. Si no has pedido cambiar la contraseña, ignora este correo.
          </p>
        </div>
      </body>
      </html>
    `,
    text: `Powerlifting Tracker

Tu código para cambiar la contraseña: ${resetCode}

Introduce este código en la app. Caduca en 15 minutos. Si no has pedido este cambio, ignora este correo.`,
  };

  if (!config.email.enabled) {
    if (config.nodeEnv === 'production') {
      throw new Error('El envío de correo no está configurado (EMAIL_USER / EMAIL_PASS).');
    }
    console.log(`\n📧 [DEV] Sin SMTP configurado. Código de recuperación para ${email}: ${resetCode}\n`);
    return;
  }

  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    console.error('[EMAIL] Fallo enviando el código de recuperación:', error);
    throw new Error('Hubo un error al intentar enviar el correo de recuperación.');
  }
};