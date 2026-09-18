import express, { Request, Response } from 'express';
import multer from 'multer';
import { body, validationResult } from 'express-validator';
import { User } from '../models/User';
import { PendingSignup, IPendingSignup } from '../models/PendingSignup';
import { sendVerificationEmail, sendPasswordResetEmail } from '../utils/email';
import { hashPassword, comparePassword } from '../utils/crypto';
import { generateToken, authenticateToken, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import { config, getPublicWebBaseUrl } from '../config/env';
import {
  isInlineAvatar,
  publicAvatarRef,
  publicListAvatar,
  resolveIncomingAvatar,
  saveAvatarBuffer,
  saveAvatarDataUrl,
} from '../utils/avatarMedia';
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
});

/** Login sin avatar ni tokens de push: un data: enorme en Mongo hacía que el fetch saltara por timeout. */
const LOGIN_SELECT =
  'email username password name gender bodyWeight theme progressMode mbMode emailVerified';

const router = express.Router();

const normalizeEmailInput = (rawEmail: string): string => {
  const clean = String(rawEmail || '').trim().toLowerCase();
  if (!clean) return clean;
  return clean.includes('@') ? clean : `${clean}@gmail.com`;
};

const escapeRegex = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

const generateUsername = (name: string): string => {
  // Convertir nombre a username manteniendo mayúsculas/minúsculas: "Juan Pérez" -> "JuanPerez"
  let base = name
    .trim()
    .replace(/[^a-zA-Z0-9]/g, '')
    .substring(0, 20);
  
  if (!base || base.length < 3) {
    base = 'user' + Math.random().toString(36).substring(2, 8);
  }
  
  return base;
};

const ensureUniqueUsername = async (baseUsername: string): Promise<string> => {
  let username = baseUsername;
  let counter = 1;
  
  // Buscar de manera case-insensitive para evitar duplicados como "Juan" y "juan"
  while (await User.findOne({ 
    username: { $regex: new RegExp(`^${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
  })) {
    username = `${baseUsername}${counter}`;
    counter++;
    if (counter > 999) {
      username = `${baseUsername}${Date.now()}`;
      break;
    }
  }
  
  return username;
};

const generateNumericVerificationCode = (): string => {
  // 6 dígitos, evitando códigos demasiado cortos por ceros a la izquierda.
  return String(Math.floor(100000 + Math.random() * 900000));
};

// 1. Registro inicial (solo email)
router.post(
  '/register',
  [
    body('email')
      .trim()
      .customSanitizer((value) => normalizeEmailInput(value))
      .isEmail()
      .withMessage('Email inválido'),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { email } = req.body;

      const existingCompleted = await User.findOne({
        email,
        password: { $exists: true, $nin: [null, ''] },
      });
      if (existingCompleted) {
        return res.status(400).json({
          error: 'Este email ya está registrado. Entra o recupera la contraseña.',
        });
      }
      await User.deleteMany({
        email,
        $or: [{ password: { $exists: false } }, { password: null }, { password: '' }],
      });

      const verificationToken = generateNumericVerificationCode();
      const verificationTokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const existingPending = await PendingSignup.findOne({ email });
      let createdNewPending = false;
      let pendingDoc: IPendingSignup;

      if (existingPending) {
        existingPending.verificationToken = verificationToken;
        existingPending.verificationTokenExpires = verificationTokenExpires;
        await existingPending.save();
        pendingDoc = existingPending;
      } else {
        pendingDoc = await PendingSignup.create({
          email,
          verificationToken,
          verificationTokenExpires,
        });
        createdNewPending = true;
      }

      try {
        await sendVerificationEmail(email, verificationToken);
      } catch (emailError: any) {
        logger.error('Error enviando email de verificación', emailError);
        if (createdNewPending) {
          try {
            await PendingSignup.findByIdAndDelete(pendingDoc._id);
          } catch (deleteError) {
            logger.error('Error eliminando pending después de fallo de email', deleteError);
          }
        }

        let errorMessage = 'Error al enviar el email de verificación';
        if (emailError.code === 'EAUTH' || emailError.message?.includes('Invalid login')) {
          errorMessage = 'Error de autenticación del servidor de correo. Verifica las credenciales en la configuración.';
        } else if (emailError.code === 'ECONNECTION' || emailError.message?.includes('connection')) {
          errorMessage = 'No se pudo conectar al servidor de correo. Verifica la configuración de red.';
        } else if (emailError.message) {
          errorMessage = `Error al enviar email: ${emailError.message}`;
        }

        return res.status(500).json({
          error: errorMessage,
          emailError: emailError.message,
        });
      }

      // Sin SMTP el código no llega al correo: el navegador necesita el token
      // para completar el registro (si no, el amigo se queda esperando un email).
      res.status(201).json({
        message: config.email.enabled
          ? 'Código de verificación enviado. Revisa tu bandeja de entrada.'
          : 'Introduce tus datos para completar la cuenta. El correo no está configurado en este servidor.',
        requiresVerification: true,
        requiresCode: true,
        emailSent: config.email.enabled,
        ...(!config.email.enabled ? { token: verificationToken } : {}),
      });
    } catch (error: any) {
      logger.error('Error en registro', error);
      
      let errorMessage = 'Error al registrar usuario';
      if (error.message?.includes('duplicate key')) {
        errorMessage = 'Este email ya está registrado';
      } else if (error.message?.includes('validation')) {
        errorMessage = 'Datos inválidos. Verifica el email ingresado';
      } else if (error.message) {
        errorMessage = error.message;
      }
      
      res.status(500).json({ error: errorMessage });
    }
  }
);

// 1.5 Validar código numérico antes de completar registro
router.post(
  '/verify-registration-code',
  [
    body('email')
      .trim()
      .customSanitizer((value) => normalizeEmailInput(value))
      .isEmail()
      .withMessage('Email inválido'),
    body('code')
      .trim()
      .matches(/^\d{6}$/)
      .withMessage('Código inválido'),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { email, code } = req.body;
      const pending = await PendingSignup.findOne({
        email,
        verificationToken: code,
        verificationTokenExpires: { $gt: new Date() },
      });

      if (!pending) {
        return res.status(400).json({ error: 'Código inválido o expirado' });
      }

      return res.json({
        message: 'Código verificado',
        token: code,
      });
    } catch (error: any) {
      logger.error('Error verificando código de registro', error);
      return res.status(500).json({ error: 'No se pudo verificar el código' });
    }
  }
);

// 2. Verificar email y completar registro
router.get(
  '/verify-email',
  async (req: Request, res: Response) => {
    try {
      const { token } = req.query;
      
      if (!token || typeof token !== 'string') {
        return res.status(400).send(`
          <html>
            <body style="font-family: sans-serif; text-align: center; padding: 50px;">
              <h1>Token inválido</h1>
              <p>El enlace de verificación no es válido.</p>
            </body>
          </html>
        `);
      }

      const pending = await PendingSignup.findOne({
        verificationToken: token,
        verificationTokenExpires: { $gt: new Date() },
      });

      if (!pending) {
        return res.status(400).send(`
          <html>
            <body style="font-family: sans-serif; text-align: center; padding: 50px;">
              <h1>Token inválido o expirado</h1>
              <p>El enlace de verificación ha expirado o no es válido.</p>
            </body>
          </html>
        `);
      }

      const mobileUrl = `${config.mobileAppScheme}://complete-registration?token=${encodeURIComponent(token)}`;
      const webBase = getPublicWebBaseUrl();
      const webFormUrl = webBase
        ? `${webBase}/api/auth/verify-email?token=${encodeURIComponent(token)}&web=1`
        : mobileUrl;
      const ua = String(req.headers['user-agent'] || '');
      const isMobileUa = /android|iphone|ipad|ipod|mobile/i.test(ua);
      // En el navegador de escritorio no tiene sentido abrir el deep link de la app:
      // el amigo se quedaba en «Abriendo la app…» y no podía terminar el registro.
      const forceMobileGate = String(req.query.web || '') !== '1' && isMobileUa;
      if (forceMobileGate) return res.send(`
        <!DOCTYPE html>
        <html lang="es">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width,initial-scale=1" />
            <title>Abrir app - Powerlifting Tracker</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#0f172a; color:#e2e8f0; margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:20px; }
              .card { width:100%; max-width:520px; background:#111827; border:1px solid #334155; border-radius:16px; padding:24px; box-shadow:0 20px 40px rgba(0,0,0,.35); }
              h1 { margin:0 0 8px; font-size:22px; color:#fff; }
              p { margin:0 0 16px; line-height:1.5; color:#94a3b8; }
              .btn { display:block; text-align:center; text-decoration:none; font-weight:700; border-radius:12px; padding:14px 16px; margin-top:12px; }
              .btn-primary { background:#4f46e5; color:#fff; }
              .btn-secondary { background:#1f2937; color:#cbd5e1; border:1px solid #334155; }
              .hint { margin-top:14px; font-size:12px; color:#64748b; word-break:break-all; }
            </style>
          </head>
          <body>
            <div class="card">
              <h1>Abriendo la app...</h1>
              <p>Si la app está instalada, se abrirá automáticamente para completar tu registro.</p>
              <a class="btn btn-primary" href="${mobileUrl}">Abrir Powerlifting Tracker</a>
              <a class="btn btn-secondary" href="${webFormUrl}">Continuar en navegador</a>
              <div class="hint">Si no abre, pega este enlace en tu navegador móvil:<br/>${mobileUrl}</div>
            </div>
            <script>
              (function() {
                var deep = ${JSON.stringify(`${config.mobileAppScheme}://complete-registration?token=${encodeURIComponent(token)}`)};
                setTimeout(function(){ window.location.href = deep; }, 120);
              })();
            </script>
          </body>
        </html>
      `);


      // Mostrar formulario de completar registro
      res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Completa tu registro - Powerlifting Tracker</title>
            <style>
              * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
              }
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
                background: #f8fafc;
                min-height: 100vh;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 16px;
                margin: 0;
              }
              .container {
                background: white;
                border-radius: 12px;
                padding: 32px 24px;
                max-width: 100%;
                width: 100%;
                box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
                border: 1px solid #e2e8f0;
              }
              h1 {
                color: #1e293b;
                margin-bottom: 8px;
                font-size: 24px;
                font-weight: 700;
              }
              @media (min-width: 640px) {
                .container {
                  max-width: 450px;
                  padding: 40px;
                }
                h1 {
                  font-size: 28px;
                }
              }
              .subtitle {
                color: #64748b;
                margin-bottom: 24px;
                font-size: 14px;
              }
              .form-group {
                margin-bottom: 20px;
              }
              label {
                display: block;
                color: #334155;
                font-weight: 600;
                margin-bottom: 8px;
                font-size: 14px;
              }
              input, select {
                width: 100%;
                padding: 12px 16px;
                border: 1px solid #e2e8f0;
                border-radius: 8px;
                font-size: 16px;
                transition: border-color 0.2s;
                -webkit-appearance: none;
                appearance: none;
              }
              input:focus, select:focus {
                outline: none;
                border-color: #4f46e5;
              }
              .gender-group {
                display: flex;
                gap: 12px;
              }
              .gender-option {
                flex: 1;
                padding: 12px 8px;
                border: 1px solid #e2e8f0;
                border-radius: 8px;
                text-align: center;
                cursor: pointer;
                transition: all 0.2s;
                font-size: 14px;
              }
              .gender-option:hover {
                border-color: #4f46e5;
              }
              .gender-option.selected {
                border-color: #4f46e5;
                background: #eef2ff;
              }
              .gender-option div {
                font-size: 14px;
              }
              input[type="radio"] {
                display: none;
              }
              button {
                width: 100%;
                padding: 14px;
                background: #4f46e5;
                color: white;
                border: none;
                border-radius: 8px;
                font-size: 16px;
                font-weight: 700;
                cursor: pointer;
                transition: background 0.2s;
                margin-top: 10px;
              }
              button:hover {
                background: #4338ca;
              }
              button:disabled {
                background: #94a3b8;
                cursor: not-allowed;
              }
              .error {
                color: #ef4444;
                font-size: 14px;
                margin-top: 5px;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>Completa tu registro</h1>
              <p class="subtitle">Último paso para empezar a entrenar</p>
              <form id="completeForm" onsubmit="handleSubmit(event)">
                <div class="form-group">
                  <label>Género *</label>
                  <div class="gender-group">
                    <label class="gender-option" onclick="selectGender('hombre')">
                      <input type="radio" name="gender" value="hombre" required>
                      <div>Hombre</div>
                    </label>
                    <label class="gender-option" onclick="selectGender('mujer')">
                      <input type="radio" name="gender" value="mujer" required>
                      <div>Mujer</div>
                    </label>
                  </div>
                </div>
                <div class="form-group">
                  <label for="name">Nombre *</label>
                  <input type="text" id="name" name="name" required placeholder="Tu nombre">
                </div>
                <div class="form-group">
                  <label for="bodyWeight">Peso corporal (kg) *</label>
                  <input type="number" id="bodyWeight" name="bodyWeight" required placeholder="Ej: 80" min="25" max="400" step="0.1">
                </div>
                <div class="form-group">
                  <label for="password">Contraseña *</label>
                  <input type="password" id="password" name="password" required placeholder="Mínimo 6 caracteres" minlength="6">
                </div>
                <div class="form-group">
                  <label for="confirmPassword">Confirmar contraseña *</label>
                  <input type="password" id="confirmPassword" name="confirmPassword" required placeholder="Repite tu contraseña" minlength="6">
                </div>
                <div id="error" class="error" style="display: none;"></div>
                <button type="submit" id="submitBtn">Crear cuenta</button>
              </form>
            </div>
            <script>
              let selectedGender = null;
              
              function selectGender(gender) {
                selectedGender = gender;
                document.querySelectorAll('.gender-option').forEach(el => {
                  el.classList.remove('selected');
                });
                event.currentTarget.classList.add('selected');
                document.querySelector('input[value="' + gender + '"]').checked = true;
              }
              
              async function handleSubmit(event) {
                event.preventDefault();
                const submitBtn = document.getElementById('submitBtn');
                const errorDiv = document.getElementById('error');
                const form = event.target;
                
                const name = form.name.value.trim();
                const bodyWeight = parseFloat(form.bodyWeight.value);
                const password = form.password.value;
                const confirmPassword = form.confirmPassword.value;
                const gender = selectedGender;
                
                errorDiv.style.display = 'none';
                
                if (!gender) {
                  errorDiv.textContent = 'Por favor selecciona tu género';
                  errorDiv.style.display = 'block';
                  return;
                }
                
                if (!name || name.length < 2) {
                  errorDiv.textContent = 'El nombre debe tener al menos 2 caracteres';
                  errorDiv.style.display = 'block';
                  return;
                }

                if (!bodyWeight || Number.isNaN(bodyWeight) || bodyWeight < 25 || bodyWeight > 400) {
                  errorDiv.textContent = 'Introduce un peso válido entre 25 y 400 kg';
                  errorDiv.style.display = 'block';
                  return;
                }
                
                if (password.length < 6) {
                  errorDiv.textContent = 'La contraseña debe tener al menos 6 caracteres';
                  errorDiv.style.display = 'block';
                  return;
                }
                
                if (password !== confirmPassword) {
                  errorDiv.textContent = 'Las contraseñas no coinciden';
                  errorDiv.style.display = 'block';
                  return;
                }
                
                submitBtn.disabled = true;
                submitBtn.textContent = 'Creando cuenta...';
                
                try {
                  const response = await fetch('/api/auth/complete-registration', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                      token: '${token}',
                      name,
                      bodyWeight,
                      password,
                      gender,
                    }),
                  });
                  
                  const data = await response.json();
                  
                  if (response.ok) {
                    // Guardar el token en localStorage
                    if (data.token) {
                      localStorage.setItem('auth_token', data.token);
                    }
                    
                    // Redirigir automáticamente a la aplicación
                    window.location.href = '/';
                  } else {
                    throw new Error(data.error || 'Error al crear la cuenta');
                  }
                } catch (error) {
                  errorDiv.textContent = error.message || 'Error al crear la cuenta. Intenta de nuevo.';
                  errorDiv.style.display = 'block';
                  submitBtn.disabled = false;
                  submitBtn.textContent = 'Crear cuenta';
                }
              }
            </script>
          </body>
        </html>
      `);
    } catch (error: any) {
      logger.error('Error verificando email', error);
      res.status(500).send(`
        <html>
          <body style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h1>Error</h1>
            <p>Ocurrió un error al verificar tu email. Por favor, intenta de nuevo.</p>
          </body>
        </html>
      `);
    }
  }
);

// 3. Completar registro después de verificar email
router.post(
  '/complete-registration',
  [
    body('token').notEmpty().withMessage('Token requerido'),
    body('name').trim().isLength({ min: 2 }).withMessage('El nombre debe tener al menos 2 caracteres'),
    body('bodyWeight').isFloat({ min: 25, max: 400 }).withMessage('El peso corporal debe estar entre 25 y 400 kg'),
    body('password').isLength({ min: 6 }).withMessage('La contraseña debe tener al menos 6 caracteres'),
    body('gender').isIn(['hombre', 'mujer']).withMessage('Género inválido'),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { token, name, bodyWeight, password, gender } = req.body;
      const rawAvatar = typeof req.body.avatar === 'string' ? req.body.avatar.trim() : '';
      let avatar = '';
      if (rawAvatar) {
        avatar = (await resolveIncomingAvatar(rawAvatar, '')) || '';
      }

      const pending = await PendingSignup.findOne({
        verificationToken: token,
        verificationTokenExpires: { $gt: new Date() },
      });

      if (!pending) {
        return res.status(400).json({ error: 'Token inválido o expirado' });
      }

      const email = pending.email.trim().toLowerCase();
      await User.deleteMany({
        email,
        $or: [{ password: { $exists: false } }, { password: null }, { password: '' }],
      });

      const already = await User.findOne({
        email,
        password: { $exists: true, $nin: [null, ''] },
      });
      if (already) {
        await PendingSignup.deleteOne({ _id: pending._id });
        return res.status(400).json({
          error: 'Este email ya está registrado. Entra o recupera la contraseña.',
        });
      }

      const hashedPassword = await hashPassword(password);
      const baseUsername = generateUsername(name);

      if (!baseUsername || baseUsername.length < 3) {
        throw new Error('No se pudo generar un nombre de usuario válido. Por favor, usa un nombre con al menos 3 letras.');
      }

      const uniqueUsername = await ensureUniqueUsername(baseUsername);

      if (!uniqueUsername || uniqueUsername.length < 3) {
        throw new Error('Error al generar nombre de usuario único');
      }

      let user = await User.findOne({ email });
      if (user) {
        user.name = name.trim();
        user.username = uniqueUsername.trim();
        user.bodyWeight = Number(bodyWeight);
        user.password = hashedPassword;
        user.gender = gender;
        user.emailVerified = true;
        if (avatar) user.avatar = avatar;
      } else {
        user = new User({
          email,
          name: name.trim(),
          username: uniqueUsername.trim(),
          bodyWeight: Number(bodyWeight),
          password: hashedPassword,
          gender,
          emailVerified: true,
          avatar,
        });
      }

      const validationError = user.validateSync();
      if (validationError) {
        throw new Error(
          'Error de validación: ' +
            Object.values(validationError.errors || {}).map((e: any) => e.message).join(', ')
        );
      }

      try {
        await user.save();
      } catch (saveErr: any) {
        if (saveErr?.code === 11000) {
          await PendingSignup.deleteOne({ _id: pending._id });
          return res.status(400).json({
            error: 'Este email ya está registrado. Entra o recupera la contraseña.',
          });
        }
        throw saveErr;
      }
      await PendingSignup.deleteOne({ _id: pending._id });

      // Generar token JWT
      const jwtToken = generateToken(user._id.toString(), user.email);

      res.json({
        message: 'Registro completado exitosamente',
        token: jwtToken,
        user: {
          id: user._id.toString(),
          email: user.email,
          username: user.username,
          name: user.name,
          gender: user.gender,
          bodyWeight: user.bodyWeight,
          avatar: publicListAvatar(user.avatar, user._id.toString()),
          theme: user.theme ?? undefined,
          progressMode: user.progressMode ?? undefined,
          mbMode: !!user.mbMode,
        },
      });
    } catch (error: any) {
      logger.error('Error completando registro', error);
      
      let errorMessage = 'Error al completar el registro';
      if (error.message) {
        errorMessage = error.message;
      } else if (error.name === 'ValidationError') {
        errorMessage = 'Error de validación: ' + Object.values(error.errors || {}).map((e: any) => e.message).join(', ');
      } else if (error.code === 11000) {
        errorMessage = String(error.message || '').includes('email')
          ? 'Este email ya está registrado. Entra o recupera la contraseña.'
          : 'El nombre de usuario ya está en uso';
      }
      
      res.status(500).json({ 
        error: errorMessage,
        details: error.message
      });
    }
  }
);

// 4. Login por nombre de usuario
router.post(
  '/login',
  [
    body('username')
      .trim()
      .isLength({ min: 2, max: 120 })
      .withMessage('Usuario o correo inválido'),
    body('password').notEmpty().withMessage('Contraseña requerida'),
  ],
  async (req: Request, res: Response) => {
    try {
      logger.info('POST /login - Iniciando proceso de login', { username: req.body?.username ? 'proporcionado' : 'no proporcionado' });
      
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        logger.warn('POST /login - Errores de validación', errors.array());
        return res.status(400).json({ errors: errors.array() });
      }

      const { username, password } = req.body;
      const rawIdentifier = String(username || '').trim();
      const normalizedIdentifier = rawIdentifier.toLowerCase();
      const isEmailLogin = normalizedIdentifier.includes('@');
      
      logger.info('POST /login - Buscando usuario', { normalizedIdentifier, isEmailLogin });
      
      let user;
      try {
        if (isEmailLogin) {
          user = await User.findOne({ email: normalizedIdentifier }).select(LOGIN_SELECT);
        } else {
          // 1) Intentar por username exacto (case-insensitive)
          user = await User.findOne({
            username: { $regex: `^${escapeRegex(rawIdentifier)}$`, $options: 'i' },
          }).select(LOGIN_SELECT);

          // 2) Si no existe, intentar por nombre exacto (case-insensitive)
          if (!user) {
            user = await User.findOne({
              name: { $regex: `^${escapeRegex(rawIdentifier)}$`, $options: 'i' },
            }).select(LOGIN_SELECT);
          }

          // 3) Si sigue sin existir, normalizar como username generado desde nombre
          // Ejemplo: "Juan Pérez" -> "JuanPerez"
          if (!user) {
            const normalizedAsUsername = rawIdentifier
              .trim()
              .replace(/[^a-zA-Z0-9]/g, '')
              .substring(0, 20);

            if (normalizedAsUsername.length >= 3) {
              user = await User.findOne({
                username: { $regex: `^${escapeRegex(normalizedAsUsername)}$`, $options: 'i' },
              }).select(LOGIN_SELECT);

              // 4) Fallback: si al registrar se añadió sufijo numérico (ej: Noel -> Noel1),
              // aceptar el base solo cuando hay una coincidencia única.
              if (!user) {
                const candidates = await User.find({
                  username: {
                    $regex: `^${escapeRegex(normalizedAsUsername)}\\d*$`,
                    $options: 'i',
                  },
                })
                  .select(LOGIN_SELECT)
                  .limit(2);

                if (candidates.length === 1) {
                  user = candidates[0];
                }
              }
            }
          }
        }
      } catch (dbError: any) {
        logger.error('POST /login - Error buscando usuario en BD', dbError);
        throw dbError;
      }
      
      if (!user) {
        logger.warn('POST /login - Usuario no encontrado', { normalizedIdentifier, isEmailLogin });
        return res.status(401).json({ error: 'Credenciales inválidas' });
      }

      logger.info('POST /login - Usuario encontrado', { 
        userId: user._id.toString(), 
        email: user.email,
        emailVerified: user.emailVerified,
        hasPassword: !!user.password,
        hasUsername: !!user.username
      });

      if (!user.emailVerified) {
        logger.warn('POST /login - Email no verificado', { userId: user._id.toString() });
        return res.status(401).json({ 
          error: 'Email no verificado. Revisa tu bandeja de entrada.',
          requiresVerification: true 
        });
      }

      if (!user.password || !user.username) {
        logger.warn('POST /login - Cuenta incompleta', { 
          userId: user._id.toString(),
          hasPassword: !!user.password,
          hasUsername: !!user.username
        });
        return res.status(401).json({ error: 'Cuenta incompleta. Termina el registro desde el enlace de correo.' });
      }
      
      logger.info('POST /login - Comparando contraseña');
      let isPasswordValid = false;
      try {
        isPasswordValid = await comparePassword(password, user.password);
        logger.info('POST /login - Comparación de contraseña completada', { isValid: isPasswordValid });
      } catch (passwordError: any) {
        logger.error('POST /login - Error comparando contraseña', passwordError);
        throw passwordError;
      }
      
      if (!isPasswordValid) {
        logger.warn('POST /login - Contraseña inválida', { userId: user._id.toString() });
        return res.status(401).json({ error: 'Credenciales inválidas' });
      }

      logger.info('POST /login - Generando token JWT');
      let jwtToken;
      try {
        jwtToken = generateToken(user._id.toString(), user.email);
        logger.info('POST /login - Token JWT generado exitosamente');
      } catch (tokenError: any) {
        logger.error('POST /login - Error generando token JWT', tokenError);
        throw tokenError;
      }

      logger.info('POST /login - Login exitoso', { userId: user._id.toString(), username: user.username });

      const avatar = await publicUserAvatar(user._id);
      
      res.json({
        message: 'Login exitoso',
        token: jwtToken,
        user: {
          id: user._id.toString(),
          email: user.email,
          username: user.username,
          name: user.name,
          gender: user.gender,
          bodyWeight: user.bodyWeight,
          avatar,
          theme: user.theme ?? undefined,
          progressMode: user.progressMode ?? undefined,
          mbMode: !!user.mbMode,
        },
      });
    } catch (error: any) {
      logger.error('POST /login - ERROR CAPTURADO EN CATCH', error);
      
      let errorMessage = 'Error del servidor';
      let errorDetails = error?.message || 'Error desconocido';
      
      if (error?.name === 'MongoError' || error?.code === 11000) {
        errorMessage = 'Error de base de datos';
        errorDetails = 'Error de base de datos: Usuario duplicado';
      } else if (error?.name === 'ValidationError') {
        errorMessage = 'Error de validación';
        errorDetails = Object.values(error.errors || {}).map((e: any) => e.message).join(', ');
      } else if (error?.message?.includes('bcrypt') || error?.message?.includes('compare') || error?.message?.includes('genSalt')) {
        errorMessage = 'Error al verificar la contraseña';
        errorDetails = `Error de bcrypt: ${error?.message}`;
      } else if (error?.message?.includes('jwt') || error?.message?.includes('token')) {
        errorMessage = 'Error al generar token';
        errorDetails = `Error al generar token: ${error?.message}`;
      } else if (error?.message) {
        errorMessage = error.message;
        errorDetails = error.message;
      }
      
      res.status(500).json({ 
        error: errorMessage,
        details: errorDetails
      });
    }
  }
);

// 5. Obtener usuario actual
router.get('/me', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const user = await User.findById(req.userId).select(
      '-password -resetPasswordToken -pushTokens -webPushSubscriptions -avatar'
    );
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const avatar = await publicUserAvatar(user._id);

    res.json({ 
      user: {
        _id: user._id,
        id: user._id,
        email: user.email,
        username: user.username,
        name: user.name,
        gender: user.gender,
        bodyWeight: user.bodyWeight,
        avatar,
        theme: user.theme,
        progressMode: user.progressMode ?? undefined,
        mbMode: !!user.mbMode,
        emailVerified: user.emailVerified,
      }
    });
  } catch (error: any) {
    logger.error('Error obteniendo usuario', error);
    res.status(500).json({ error: 'Error al obtener usuario' });
  }
});

// 6. Logout — quitar solo el token de este dispositivo (body.token) o todos si no se envía (clientes antiguos).
router.post('/logout', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthRequest).userId || (req as any).user?.userId;
    if (userId) {
      const bodyToken =
        typeof req.body?.token === 'string' ? req.body.token.trim() : '';
      const webPushEndpoint =
        typeof req.body?.webPushEndpoint === 'string' ? req.body.webPushEndpoint.trim() : '';
      const update: Record<string, unknown> = {};
      const pull: Record<string, unknown> = {};
      if (bodyToken) pull.pushTokens = bodyToken;
      else update.$set = { pushTokens: [] };
      if (webPushEndpoint) pull.webPushSubscriptions = { endpoint: webPushEndpoint };
      if (Object.keys(pull).length > 0) update.$pull = pull;
      if (Object.keys(update).length > 0) {
        await User.findByIdAndUpdate(userId, update);
      }
    }
  } catch {
    /* best-effort */
  }
  res.json({ message: 'Logout exitoso' });
});

// 7. Actualizar usuario (apariencia/theme, nombre, bodyWeight, etc.)
router.put('/me', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const user = await User.findById(req.userId).select('-pushTokens -webPushSubscriptions -avatar');
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    const { theme, name, bodyWeight, avatar, progressMode, mbMode, gender } = req.body;
    if (theme !== undefined) {
      if (theme === 'light' || theme === 'dark') {
        user.theme = theme;
      }
    }
    if (name !== undefined && typeof name === 'string') user.name = name.trim();
    if (bodyWeight !== undefined && typeof bodyWeight === 'number') user.bodyWeight = bodyWeight;
    if (gender === 'hombre' || gender === 'mujer') user.gender = gender;
    if (avatar !== undefined && typeof avatar === 'string') {
      const [prevMeta] = await User.aggregate<{ avatar: string }>([
        { $match: { _id: user._id } },
        {
          $project: {
            avatar: {
              $cond: [
                { $lt: [{ $strLenBytes: { $ifNull: ['$avatar', ''] } }, 400] },
                { $ifNull: ['$avatar', ''] },
                '',
              ],
            },
          },
        },
      ]);
      user.avatar = await resolveIncomingAvatar(avatar, prevMeta?.avatar);
    }
    if (progressMode !== undefined) {
      if (progressMode === 'month' || progressMode === 'year') {
        user.progressMode = progressMode;
      }
    }
    if (mbMode !== undefined) {
      user.mbMode = !!mbMode;
    }
    await user.save();
    const avatarOut = await publicUserAvatar(user._id);
    res.json({
      user: {
        id: user._id.toString(),
        email: user.email,
        username: user.username,
        name: user.name,
        gender: user.gender,
        bodyWeight: user.bodyWeight,
        avatar: avatarOut,
        theme: user.theme ?? undefined,
        progressMode: user.progressMode ?? undefined,
        mbMode: !!user.mbMode,
        emailVerified: user.emailVerified,
      },
    });
  } catch (error: any) {
    logger.error('Error actualizando usuario', error);
    res.status(500).json({ error: 'Error al actualizar el usuario' });
  }
});

function loginUserPayload(
  user: { _id: unknown; email?: string; username?: string; name?: string; gender?: string; bodyWeight?: number; theme?: string; progressMode?: string; mbMode?: boolean },
  avatar: string
) {
  return {
    id: String(user._id),
    email: user.email,
    username: user.username,
    name: user.name,
    gender: user.gender,
    bodyWeight: user.bodyWeight,
    avatar,
    theme: user.theme ?? undefined,
    progressMode: user.progressMode ?? undefined,
    mbMode: !!user.mbMode,
  };
}

async function publicUserAvatar(userId: unknown): Promise<string> {
  const row = await User.findById(userId).select('avatar').lean();
  const raw = String(row?.avatar || '').trim();
  if (isInlineAvatar(raw)) {
    try {
      const key = await saveAvatarDataUrl(raw);
      await User.updateOne({ _id: userId }, { $set: { avatar: key } });
      return publicListAvatar(key, String(userId));
    } catch (err) {
      logger.warn('[avatar] Migración omitida', err);
      return publicListAvatar(raw, String(userId));
    }
  }
  return publicListAvatar(raw, String(userId));
}

router.post(
  '/forgot-password',
  [
    body('email')
      .trim()
      .customSanitizer((value) => normalizeEmailInput(value))
      .isEmail()
      .withMessage('Email inválido'),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const email = String(req.body.email || '').trim().toLowerCase();
      const user = await User.findOne({
        email,
        password: { $exists: true, $nin: [null, ''] },
      }).select('_id email');

      if (user) {
        const resetCode = generateNumericVerificationCode();
        await User.updateOne(
          { _id: user._id },
          {
            $set: {
              resetPasswordToken: resetCode,
              resetPasswordExpires: new Date(Date.now() + 15 * 60 * 1000),
            },
          }
        );
        await sendPasswordResetEmail(email, resetCode);
      }

      return res.json({
        ok: true,
        message: 'Si el correo está registrado, te hemos enviado un código.',
      });
    } catch (error: any) {
      logger.error('Error en forgot-password', error);
      return res.status(500).json({ error: 'No se pudo enviar el código. Inténtalo de nuevo.' });
    }
  }
);

router.post(
  '/verify-reset-code',
  [
    body('email')
      .trim()
      .customSanitizer((value) => normalizeEmailInput(value))
      .isEmail()
      .withMessage('Email inválido'),
    body('code')
      .trim()
      .matches(/^\d{6}$/)
      .withMessage('Código inválido'),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const email = String(req.body.email || '').trim().toLowerCase();
      const code = String(req.body.code || '').trim();
      const user = await User.findOne({
        email,
        resetPasswordToken: code,
        resetPasswordExpires: { $gt: new Date() },
      }).select('_id');
      if (!user) {
        return res.status(400).json({ error: 'Código inválido o expirado' });
      }
      return res.json({ ok: true, message: 'Código verificado' });
    } catch (error: any) {
      logger.error('Error verificando código de recuperación', error);
      return res.status(500).json({ error: 'No se pudo verificar el código' });
    }
  }
);

router.post(
  '/reset-password',
  [
    body('email')
      .trim()
      .customSanitizer((value) => normalizeEmailInput(value))
      .isEmail()
      .withMessage('Email inválido'),
    body('code')
      .trim()
      .matches(/^\d{6}$/)
      .withMessage('Código inválido'),
    body('password').isLength({ min: 6 }).withMessage('La contraseña debe tener al menos 6 caracteres'),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const email = String(req.body.email || '').trim().toLowerCase();
      const code = String(req.body.code || '').trim();
      const password = String(req.body.password || '');

      const user = await User.findOne({
        email,
        resetPasswordToken: code,
        resetPasswordExpires: { $gt: new Date() },
      }).select('email username name gender bodyWeight theme progressMode mbMode');

      if (!user) {
        return res.status(400).json({ error: 'Código inválido o expirado' });
      }

      user.password = await hashPassword(password);
      user.resetPasswordToken = undefined;
      user.resetPasswordExpires = undefined;
      await user.save();

      const jwtToken = generateToken(user._id.toString(), user.email);
      const avatar = await publicUserAvatar(user._id);
      return res.json({
        message: 'Contraseña actualizada',
        token: jwtToken,
        user: loginUserPayload(user, avatar),
      });
    } catch (error: any) {
      logger.error('Error en reset-password', error);
      return res.status(500).json({ error: 'No se pudo cambiar la contraseña' });
    }
  }
);

router.post(
  '/me/avatar',
  authenticateToken,
  avatarUpload.single('file'),
  async (req: AuthRequest, res: Response) => {
    try {
      const file = (req as any).file as { buffer: Buffer; mimetype: string } | undefined;
      if (!file) return res.status(400).json({ error: 'Falta la foto' });
      const key = await saveAvatarBuffer(file.buffer, file.mimetype);
      const [prevMeta] = await User.aggregate<{ avatar: string }>([
        { $match: { _id: req.userId } },
        {
          $project: {
            avatar: {
              $cond: [
                { $lt: [{ $strLenBytes: { $ifNull: ['$avatar', ''] } }, 400] },
                { $ifNull: ['$avatar', ''] },
                '',
              ],
            },
          },
        },
      ]);
      await resolveIncomingAvatar(key, prevMeta?.avatar);
      await User.updateOne({ _id: req.userId }, { $set: { avatar: key } });
      res.json({ avatar: key });
    } catch (error: any) {
      logger.error('Error subiendo avatar', error);
      res.status(400).json({ error: error.message || 'No se ha podido guardar la foto' });
    }
  }
);

export default router;
