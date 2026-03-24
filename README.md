# Powerlifting Tracker - Backend Server

Servidor Node.js con Express y MongoDB para la aplicación Powerlifting Tracker.

## 🚀 Inicio Rápido

### Instalación

```bash
cd server
npm install
```

### Configuración

1. Copia `.env.example` a `.env` (ya está creado con las credenciales)
2. Asegúrate de que las variables de entorno estén correctas

### Ejecutar en desarrollo

```bash
npm run dev
```

### Ejecutar en producción

```bash
npm run build
npm start
```

## 📁 Estructura del Proyecto

```
server/
├── src/
│   ├── config/          # Configuración (DB, etc.)
│   ├── models/          # Modelos de MongoDB (User, etc.)
│   ├── routes/          # Rutas de la API
│   ├── middleware/      # Middleware (auth, validación)
│   ├── utils/           # Utilidades (email, crypto)
│   └── index.ts         # Punto de entrada
├── dist/                # Código compilado (generado)
├── package.json
├── tsconfig.json
└── .env                 # Variables de entorno
```

## 🔐 Sistema de Autenticación

### Flujo de Registro

1. **POST `/api/auth/register`** - Registro inicial (solo email)
   - Recibe: `{ email: "usuario@example.com" }`
   - Envía email de verificación
   - Retorna: `{ message: "Email enviado", requiresVerification: true }`

2. **GET `/api/auth/verify-email?token=XXX`** - Verificar email
   - Usuario hace clic en el enlace del email
   - Muestra formulario para completar registro (género, nombre, contraseña)
   - El formulario envía POST a `/api/auth/complete-registration`

3. **POST `/api/auth/complete-registration`** - Completar registro
   - Recibe: `{ token, name, password, gender }`
   - Valida y crea la cuenta completa
   - Retorna: `{ token: JWT, user: {...} }`

### Login

**POST `/api/auth/login`**
- Recibe: `{ email, password }`
- Retorna: `{ token: JWT, user: {...} }`

### Obtener Usuario Actual

**GET `/api/auth/me`** (requiere autenticación)
- Header: `Authorization: Bearer <token>`
- Retorna: `{ user: {...} }`

### Logout

**POST `/api/auth/logout`** (requiere autenticación)
- El cliente simplemente elimina el token

## 🔒 Seguridad

- Contraseñas encriptadas con `bcryptjs`
- Tokens JWT para autenticación
- Tokens de verificación con expiración (24 horas)
- Validación de entrada con `express-validator`
- CORS configurado

## 📧 Email

El servidor usa Gmail SMTP para enviar emails de verificación. Las credenciales están en `.env`.

## 🗄️ MongoDB

Conexión a MongoDB Atlas usando la cadena proporcionada. Todos los modelos se crean automáticamente al conectarse.

### Modelos

#### User
```typescript
{
  email: string (único, indexado)
  password: string (encriptado)
  name?: string
  gender?: 'hombre' | 'mujer'
  avatar?: string
  bodyWeight?: number
  theme?: 'light' | 'dark'
  emailVerified: boolean
  verificationToken?: string
  verificationTokenExpires?: Date
  createdAt: Date
  updatedAt: Date
}
```

#### Routine
```typescript
{
  userId: ObjectId
  name: string
  isActive: boolean
  weeks: TrainingWeek[]
  logs: Record<string, LogEntry>
  createdAt: Date
  updatedAt: Date
}
```

#### TrainingMax
```typescript
{
  userId: ObjectId
  name: string
  value: number
  mode: 'weight' | 'reps' | 'seconds'
  linkedExercise?: 'bench' | 'squat' | 'deadlift'
  createdAt: Date
  updatedAt: Date
}
```

#### HistoryEntry
```typescript
{
  userId: ObjectId
  date: string (ej: 'Ene', 'Feb')
  rms: { bench, squat, deadlift, ... }
  total: number
  trainingMaxes: Record<string, number>
  createdAt: Date
}
```

#### Friendship
```typescript
{
  requester: ObjectId
  recipient: ObjectId
  status: 'pending' | 'accepted' | 'rejected'
  createdAt: Date
  updatedAt: Date
}
```

#### GymCheckIn
```typescript
{
  userId: ObjectId
  userName: string
  gymName: string
  time: string (HH:MM)
  timestamp: Date
  createdAt: Date
}
```

#### Notification
```typescript
{
  userId: ObjectId
  type: 'gym_checkin' | 'friend_request' | 'challenge_invite' | 'friend_accepted'
  title: string
  message: string
  relatedUserId?: ObjectId
  relatedData?: object
  read: boolean
  createdAt: Date
}
```

#### Challenge
```typescript
{
  createdBy: ObjectId
  title: string
  type: 'max_reps' | 'improvement' | 'total_volume'
  exercise: string
  participants: Participant[]
  endDate: Date
  createdAt: Date
  updatedAt: Date
}
```

## 📡 API Endpoints

### Rutinas (`/api/routines`)
- `GET /` - Obtener todas las rutinas del usuario
- `GET /:id` - Obtener una rutina específica
- `POST /` - Crear una nueva rutina
- `PUT /:id` - Actualizar una rutina
- `DELETE /:id` - Eliminar una rutina
- `PUT /:id/activate` - Activar una rutina (desactiva las demás)

### Training Maxes (`/api/training-maxes`)
- `GET /` - Obtener todos los Training Maxes del usuario
- `POST /` - Crear un nuevo Training Max
- `PUT /:id` - Actualizar un Training Max
- `DELETE /:id` - Eliminar un Training Max
- `POST /save-period` - Guardar período actual (historial mensual)
- `GET /history` - Obtener historial de Training Maxes

### Social (`/api/social`)
- `GET /search?q=nombre` - Buscar usuarios por nombre o email
- `GET /friends` - Obtener lista de amigos
- `GET /requests` - Obtener solicitudes de amistad pendientes
- `POST /requests` - Enviar solicitud de amistad (`{ userId }`)
- `PUT /requests/:id/accept` - Aceptar solicitud de amistad
- `PUT /requests/:id/reject` - Rechazar solicitud de amistad

### Check-ins (`/api/checkins`)
- `POST /` - Crear check-in de gimnasio (`{ gymName, time }`)
- `GET /` - Obtener check-ins de amigos y propios (últimas 24h)

### Notificaciones (`/api/notifications`)
- `GET /` - Obtener notificaciones del usuario
- `GET /?unread=true` - Solo no leídas
- `PUT /:id/read` - Marcar como leída
- `PUT /read-all` - Marcar todas como leídas
- `GET /unread-count` - Contador de no leídas

### Challenges (`/api/challenges`)
- `GET /` - Obtener challenges (propios y de amigos)
- `POST /` - Crear un nuevo challenge
- `PUT /:id/join` - Unirse a un challenge (`{ score, value }`)

## 🛠️ Scripts

- `npm run dev` - Desarrollo con hot reload
- `npm run build` - Compilar TypeScript
- `npm start` - Ejecutar en producción
- `npm run lint` - Verificar tipos TypeScript
